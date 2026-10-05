import { z } from "zod";
import { SourcePolicySchema, PermissionDecisionSchema, PermissionScopeSchema, type SourcePolicy } from "@amp/contracts/source-policy";
import { dbOf, type Db, type Tx } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";

const sql = dbOf("sources");
const publicPurposes = ["public_excerpt", "public_summary", "public_original_fulltext", "public_translation"] as const;
const PublicPolicy = z.strictObject({
  source_id: SourcePolicySchema.shape.source_id,
  permission_version: SourcePolicySchema.shape.permission_version,
  permissions: z.record(z.enum(publicPurposes), PermissionDecisionSchema),
  scope: PermissionScopeSchema,
  conditions: SourcePolicySchema.shape.conditions,
  attachments_in_scope: z.boolean(),
  expires_at: SourcePolicySchema.shape.expires_at,
  licence_label_zh: SourcePolicySchema.shape.licence_label_zh,
  grants: z.record(z.enum(publicPurposes), z.array(z.strictObject({ scope: PermissionScopeSchema, expires_at: SourcePolicySchema.shape.expires_at }))),
});

export class SourcePolicyConflict extends Error {
  code = "conflict";
}

/** The caller cannot supply this projection or copy private evidence into the public login. */
function publicProjection(policy: SourcePolicy) {
  return PublicPolicy.parse({
    source_id: policy.source_id,
    permission_version: policy.permission_version,
    permissions: Object.fromEntries(publicPurposes.map((purpose) => [purpose, policy.permissions[purpose]])),
    scope: policy.scope,
    conditions: policy.conditions,
    attachments_in_scope: policy.attachments_in_scope,
    expires_at: policy.expires_at,
    licence_label_zh: policy.licence_label_zh,
    grants: Object.fromEntries(
      publicPurposes.map((purpose) => [
        purpose,
        policy.evidence
          .filter((e) => e.capabilities.includes(purpose) && !["source_objection", "owner_instruction", "legal_requirement"].includes(e.kind))
          .map((e) => ({ scope: e.scope, expires_at: e.valid_until })),
      ]),
    ),
  });
}

export async function readCurrentSourcePolicy(sourceId: string, db: Db = sql): Promise<SourcePolicy | null> {
  const [row] = await db`
    SELECT v.policy, v.policy_hash, v.permission_version
    FROM sources.source_policy_current c JOIN sources.source_policy_versions v
      ON v.source_id=c.source_id AND v.permission_version=c.permission_version WHERE c.source_id=${sourceId}`;
  if (!row) return null;
  const policy = SourcePolicySchema.parse(row.policy);
  if (policy.source_id !== sourceId || policy.permission_version !== Number(row.permission_version) || sha256(stableJson(policy)) !== row.policy_hash)
    throw new Error("Stored source policy identity mismatch");
  return policy;
}

export async function readCurrentPublicPolicy(sourceId: string, db: Db = sql) {
  const [row] = await db`SELECT source_id, permission_version, public_policy FROM sources.source_policy_current WHERE source_id=${sourceId}`;
  if (!row) return null;
  const policy = PublicPolicy.parse(row.public_policy);
  if (policy.source_id !== row.source_id || policy.permission_version !== Number(row.permission_version))
    throw new Error("Public source policy identity mismatch");
  return policy;
}

/** All permission edits hold this source's exclusive transaction lock through audit and commit. */
export async function appendSourcePolicy(tx: Tx, expectedVersion: number | null, input: unknown) {
  const policy = SourcePolicySchema.parse(input);
  if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1))
    throw new SourcePolicyConflict("Invalid expected permission version");
  await tx`SELECT pg_advisory_xact_lock(23621, hashtext(${policy.source_id}))`;
  const before = await readCurrentSourcePolicy(policy.source_id, tx);
  if ((before?.permission_version ?? null) !== expectedVersion || policy.permission_version !== (expectedVersion ?? 0) + 1)
    throw new SourcePolicyConflict("Source permission version changed");
  const projection = publicProjection(policy);
  await tx`INSERT INTO sources.source_policy_versions(source_id,permission_version,policy,policy_hash)
    VALUES(${policy.source_id},${policy.permission_version},${tx.json(policy)},${sha256(stableJson(policy))})`;
  const rows =
    expectedVersion === null
      ? await tx`INSERT INTO sources.source_policy_current(source_id,permission_version,public_policy)
        VALUES(${policy.source_id},${policy.permission_version},${tx.json(projection)}) ON CONFLICT DO NOTHING RETURNING source_id`
      : await tx`UPDATE sources.source_policy_current SET permission_version=${policy.permission_version},public_policy=${tx.json(projection)}
        WHERE source_id=${policy.source_id} AND permission_version=${expectedVersion} RETURNING source_id`;
  if (rows.length !== 1) throw new SourcePolicyConflict("Source permission version changed");
  return { before, after: policy };
}

/** Hold versions through the caller's transaction; resource/use validation still runs before use. */
export async function lockCurrentSourcePolicies(tx: Tx, expected: readonly { sourceId: string; permissionVersion: number }[]) {
  const [transaction] = await tx`SHOW transaction_isolation`;
  if (transaction?.transaction_isolation !== "read committed") throw new Error("Permission fences require read committed transactions");
  if (!expected.length || new Set(expected.map((item) => item.sourceId)).size !== expected.length) throw new Error("Distinct source permissions required");
  const result: SourcePolicy[] = [];
  for (const item of [...expected].sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0))) {
    await tx`SELECT pg_advisory_xact_lock_shared(23621, hashtext(${item.sourceId}))`;
    const policy = await readCurrentSourcePolicy(item.sourceId, tx);
    if (!policy || policy.permission_version !== item.permissionVersion) throw new SourcePolicyConflict("Source permission version changed");
    result.push(policy);
  }
  return result;
}
