import { z } from "zod";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { closeDb, initializeDb } from "@amp/backend/db";
import { PermissionScopeSchema, SOURCE_PURPOSES, SourcePolicySchema, type SourcePolicy } from "../packages/contracts/src/source-policy.ts";
import { sourceDetail, saveSourcePolicy } from "@amp/backend/admin/sources";

const webUrl = z.url({ protocol: /^https?$/ }).refine((value) => !new URL(value).username && !new URL(value).password);
const MoveSchema = z
  .strictObject({
    source_id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    owner_entity_id: z
      .string()
      .min(1)
      .max(120)
      .refine((value) => value === value.trim()),
    old_domain: PermissionScopeSchema.shape.hosts.element,
    new_domain: PermissionScopeSchema.shape.hosts.element,
    path_prefixes: PermissionScopeSchema.shape.path_prefixes,
    evidence_kind: z.enum(["redirect", "institution_announcement", "exchange_disclosure", "regulatory_disclosure"]),
    evidence_url: webUrl,
    verified_at: z.iso.datetime({ offset: true }),
    same_institution: z.literal(true),
    explanation_zh: z.string().trim().min(1),
    redirect_status: z
      .number()
      .int()
      .refine((status) => [301, 302, 303, 307, 308].includes(status))
      .optional(),
    redirect_target: webUrl.optional(),
  })
  .refine(
    (move) =>
      move.old_domain !== move.new_domain &&
      (move.evidence_kind !== "redirect" ||
        (move.redirect_status !== undefined &&
          move.redirect_target !== undefined &&
          new URL(move.evidence_url).hostname === move.old_domain &&
          new URL(move.redirect_target).hostname === move.new_domain)),
  );
type DomainMove = z.infer<typeof MoveSchema>;
type SourceIdentity = { id: string; owner_entity_id: string | null; archived_at: unknown };

export function parseDomainMoves(input: unknown) {
  const parsed = z.array(MoveSchema).min(1).safeParse(input);
  if (!parsed.success || new Set(parsed.data.map((move) => move.source_id)).size !== parsed.data.length)
    throw new Error("Invalid or repeated domain move entry");
  return parsed.data;
}

export async function migrateSourceDomains(input: unknown, apply = false) {
  const plans = [];
  for (const move of parseDomainMoves(input)) {
    const detail = await sourceDetail(move.source_id);
    if (!detail?.permission) throw new Error(`Missing source or permission: ${move.source_id}`);
    const source = { id: detail.source.id, owner_entity_id: detail.source.owner_entity_id, archived_at: detail.source.archived_at };
    plans.push({ move, before: detail.permission, after: planDomainMove(detail.permission, source, move) });
  }
  const result = [];
  for (const { move, before, after } of plans) {
    const saved =
      after && apply
        ? await saveSourcePolicy(
            move.source_id,
            {
              policy: after,
              expectedVersion: before.permission_version,
              reason: move.explanation_zh,
              expectedSourceGuard: { ownerEntityId: move.owner_entity_id },
            },
            "ops:source-domain-move",
          )
        : null;
    const snapshot = (policy: SourcePolicy) => ({ scope: policy.scope, permissions: policy.permissions, evidence: policy.evidence });
    result.push({
      source_id: move.source_id,
      status: !after ? "already_registered" : apply ? "applied" : "dry_run",
      beforeVersion: before.permission_version,
      afterVersion: saved?.permission_version ?? before.permission_version + (after ? 1 : 0),
      before: snapshot(before),
      after: snapshot(saved ?? after ?? before),
    });
  }
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.slice(2).some((arg) => arg !== "--apply")) throw new Error("Usage: source-domain-move.ts [--apply]");
  const moves = parseDomainMoves(JSON.parse(readFileSync(new URL("../industry/source-domain-moves.json", import.meta.url), "utf8")));
  try {
    await initializeDb("worker");
    console.log(JSON.stringify(await migrateSourceDomains(moves, process.argv.includes("--apply")), null, 2));
  } finally {
    await closeDb();
  }
}

export function planDomainMove(policy: SourcePolicy, source: SourceIdentity | null, move: DomainMove) {
  if (
    !source ||
    source.id !== move.source_id ||
    policy.source_id !== move.source_id ||
    source.archived_at !== null ||
    source.owner_entity_id !== move.owner_entity_id ||
    !policy.scope.hosts.includes(move.old_domain)
  )
    throw new Error("Source identity or old domain changed");
  if (policy.scope.hosts.includes(move.new_domain)) return null;
  if (
    policy.conditions.length ||
    policy.expires_at ||
    policy.evidence.some((evidence) => evidence.valid_until !== null || ["source_objection", "owner_instruction", "legal_requirement"].includes(evidence.kind))
  )
    throw new Error("Restricted permission requires separate review");
  const capabilities = SOURCE_PURPOSES.filter((purpose) => policy.permissions[purpose] === "allow");
  const covers = (scope: SourcePolicy["scope"], path: string) =>
    !scope.document_types.length && !scope.excluded_content.length && scope.path_prefixes.some((prefix) => path.startsWith(prefix));
  if (
    !capabilities.length ||
    policy.evidence.some((evidence) => evidence.scope.hosts.includes(move.new_domain)) ||
    move.path_prefixes.some(
      (path) =>
        !covers(policy.scope, path) ||
        capabilities.some(
          (purpose) =>
            !policy.evidence.some(
              (evidence) => evidence.scope.hosts.includes(move.old_domain) && evidence.capabilities.includes(purpose) && covers(evidence.scope, path),
            ),
        ),
    )
  )
    throw new Error("Existing scope cannot be mapped without widening permission");
  return SourcePolicySchema.parse({
    ...policy,
    scope: { ...policy.scope, hosts: [...policy.scope.hosts, move.new_domain] },
    evidence: [
      ...policy.evidence,
      {
        kind: "owner_declared",
        url: move.evidence_url,
        checked_at: move.verified_at,
        valid_until: null,
        basis_zh: `${move.explanation_zh}；${move.old_domain} → ${move.new_domain}，沿用既有用途，仅扩展所列新域路径，不新增许可。`,
        capabilities,
        scope: { hosts: [move.new_domain], path_prefixes: move.path_prefixes, document_types: [], excluded_content: [] },
      },
    ],
  });
}
