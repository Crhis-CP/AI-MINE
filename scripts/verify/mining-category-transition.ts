import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { API } from "typescript/unstable/sync";
import * as ts from "typescript/unstable/ast";
import { z } from "zod";
import { digest, type extractOwnership } from "./ts-ownership.ts";

const ITEMS = "packages/backend/src/publication/items.ts";
const V1 = "packages/backend/src/publication/v1.ts";
const POOL = "packages/backend/src/publication/pool.ts";
const LOCK = "sql/parser-locked-subgraph";
const RULES: Record<string, readonly (readonly string[])[]> = {
  "packages/backend/src/publication/items.ts": [
    [
      "import",
      "",
      'import type { CategoryKey, ChannelKey } from "@amp/contracts/taxonomy";',
      'import { toPublicApiCategory, type CategoryKey, type ChannelKey } from "@amp/contracts/taxonomy";',
    ],
    [
      "function",
      "categoryCondition",
      `export function categoryCondition(category: CategoryKey | null | undefined, v1 = false) {
  if (!category) return sql\`\`;
  // v1 and RSS publish opinion as tip.
  if (v1 && category === "tip") return sql\`AND p.category IN ('tip', 'opinion')\`;
  return sql\`AND p.category = \${category}\`;
}`,
      `export function categoryCondition(category: CategoryKey | null | undefined, _v1 = false) {
  if (!category) return sql\`\`;
  return sql\`AND p.category = \${category}\`;
}`,
    ],
    ["property", "toItemSummary", "category: (row.category as CategoryKey | null) ?? null", "category: toPublicApiCategory(row.category)"],
  ],
  "packages/backend/src/publication/v1.ts": [
    [
      "import",
      "",
      'import type { PublicApiCategoryKey } from "@amp/contracts/taxonomy";',
      'import { toPublicApiCategory, type PublicApiCategoryKey } from "@amp/contracts/taxonomy";',
    ],
    ["property", "minimalOf", "category: item.category", "category: toPublicApiCategory(item.category)"],
    [
      "property",
      "selectedSnapshot",
      'items: page.map((r) => (fields === "minimal" ? minimalOf(r.payload) : r.payload))',
      'items: page.map((r) => (fields === "minimal" ? minimalOf(r.payload) : { ...r.payload, category: toPublicApiCategory(r.payload.category) }))',
    ],
    [
      "object",
      "selectedChanges",
      '{ op: "upsert" as const, changedAt: r.changed_at.toISOString(), item: c.f === "minimal" ? minimalOf(r.payload!) : r.payload! }',
      '{\n            op: "upsert" as const,\n            changedAt: r.changed_at.toISOString(),\n            item: c.f === "minimal" ? minimalOf(r.payload!) : { ...r.payload!, category: toPublicApiCategory(r.payload!.category) },\n          }',
    ],
  ],
};
const HASHES: Record<string, readonly string[]> = {
  "packages/backend/src/publication/items.ts": [
    "1b0a1d54d20393a63bd9a1320c577f1c20a20f0f14d9ac9c8f96e7112ae16e2c",
    "20035a352e8c5ccaaec24f666f9c60694bd5777b6c8c9863ce726a045a133dbb",
  ],
  "packages/backend/src/publication/v1.ts": [
    "c16fe7c2a1a84c5ccf13729ebf34d884f6382cefb3e5d2b801813601a733e2d8",
    "a43270b575fb010149e48b3eb4ba18e34666bd9845d9e437b0a5f75abf203596",
  ],
};
const TARGETS = new Set([
  "packages/backend/src/publication/pool.ts:loadPool/run/result:cbab10a65a0a5aca82b5d0413f3f9b9dec08ed289ef63e1b67c17a769958da63:template",
  "packages/backend/src/publication/pool.ts:loadPool/run/rows:e544fa9bbee69430ee3cb72cb44543bcce78c1bea9fbac16e40b70c3ef4742ef:template",
  "packages/backend/src/publication/pool.ts:loadPool/run/{ n }:fcfd1f767a9e6a7d7cd419983ac01ac8c44c68498e64dd6f972bb4abc1f7cfea:template",
  "packages/backend/src/publication/v1.ts:v1Items/run:fcb1437ace4c15aeaabbe793c76ce70d3ef85fc2ae56f35aab737d317c7748ab:template",
  "packages/backend/src/publication/v1.ts:v1Items/run:d89acf5ed4c3f095daed5407730caf3c0a01b0b01494ec82bdea94413b370de7:unresolved-call",
  "packages/backend/src/publication/v1.ts:v1Items/rows:645a9319c1a814c6c806f3e74545f620badc4f0d531630519cd6ee0a5b11bf6a:unresolved-call",
  "packages/backend/src/publication/v1.ts:ledgerPayload:1e56d6baa051cac628980a8705fc01e150ff9dc0c8b7e9307bd98d70fe7dec01:template",
  "packages/backend/src/publication/v1.ts:selectedSnapshot/rows:a7c47b71079740b1e3512064c2227948247f612dcf6bc02d0353a3a81ba3e781:template",
  "packages/backend/src/publication/v1.ts:selectedSnapshot/rows:2a75541571969ca036fdf958f32fbe65e4603b3e7ffb6d732d16dd78b1ee99d8:unresolved-call",
  "packages/backend/src/publication/v1.ts:selectedChanges/rows:c97634c5bc89fbd0eec10109d9f363942790ac754f200f9381e87428aa23a15f:template",
  "packages/backend/src/publication/v1.ts:selectedChanges/rows:2a782ee8269bc72dd3f36d163cd75b181fb55fc98098188ae49dffd5836dc457:unresolved-call",
]);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const dependencies = z.partialRecord(z.enum([ITEMS, V1, POOL, LOCK]), hash);
export const miningCategoryTransitionSchema = z
  .object({
    revision: z.literal("ADR-0022-nine-categories"),
    sites: z
      .array(
        z
          .object({
            file: z.enum([POOL, V1]),
            scopeName: z.string(),
            kind: z.string(),
            sourceHash: hash,
            shape: z.string(),
            reasons: z.array(z.string()).min(1),
            before: dependencies,
            after: dependencies,
          })
          .strict(),
      )
      .length(11),
  })
  .strict();

export type MiningCategoryTransition = z.infer<typeof miningCategoryTransitionSchema>;

/** Exact AST substitutions, preserving every other byte including all helper/import bindings. */
export function miningCategoryProof(file: string, before: string, after: string): boolean {
  const rules = RULES[file];
  if (!rules) return false;
  const dir = mkdtempSync(path.join(tmpdir(), "amp-category-proof-")),
    api = new API({ cwd: dir });
  try {
    const files = [before, after].map((text, i) => {
      const name = path.join(dir, `${i}.ts`);
      writeFileSync(name, text);
      return name;
    });
    const snapshot = api.updateSnapshot({ openFiles: files });
    try {
      const masks = files.map((name, index) => {
        const project = snapshot.getDefaultProjectForFile(name),
          source = project?.program.getSourceFile(name);
        if (!project || !source || project.program.getSyntacticDiagnostics(name).length) return null;
        const spans: { start: number; end: number; rule: number }[] = [];
        const owner = (node: ts.Node) => {
          for (let p: ts.Node | undefined = node; p; p = p.parent) if (ts.isFunctionDeclaration(p)) return p.name?.text;
          return "";
        };
        const walk = (node: ts.Node) => {
          rules.forEach(([kind, scope, old, current], rule) => {
            const matches =
              kind === "import"
                ? ts.isImportDeclaration(node)
                : kind === "function"
                  ? ts.isFunctionDeclaration(node)
                  : kind === "property"
                    ? ts.isPropertyAssignment(node)
                    : ts.isObjectLiteralExpression(node);
            if (matches && owner(node) === scope && node.getText() === (index ? current : old)) spans.push({ start: node.getStart(), end: node.end, rule });
          });
          node.forEachChild(walk);
        };
        walk(source);
        if (spans.length !== rules.length || new Set(spans.map((s) => s.rule)).size !== rules.length) return null;
        spans.sort((a, b) => b.start - a.start);
        let text = source.text,
          end = text.length;
        for (const span of spans) {
          if (span.end > end) return null;
          text = text.slice(0, span.start) + `__CATEGORY_EDIT_${span.rule}__` + text.slice(span.end);
          end = span.start;
        }
        return text;
      });
      return masks[0] !== null && masks[0] === masks[1];
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Only the eleven frozen UNKNOWN slots; no new SQL, reason, dependency or reusable allowance. */
export function miningCategoryBudget(
  now: Record<string, number>,
  prior: Record<string, number>,
  value: unknown,
  inventory: ReturnType<typeof extractOwnership>,
  lock: string,
  read: (file: string, before: boolean) => string | null,
) {
  const budget = { ...prior };
  const fail = () => ({ budget: { ...prior }, errors: ["mining category: exact source proof or one-use UNKNOWN transfer failed"] });
  if (value === undefined) return { budget, errors: [] };
  const parsed = miningCategoryTransitionSchema.safeParse(value);
  if (!parsed.success) return fail();
  const pairs = parsed.data.sites.map((site) => {
    const id = `${site.file}:${site.scopeName}:${site.sourceHash}:${site.kind}`;
    const key = (deps: object) => `${site.file}:${site.scopeName}:` + digest(JSON.stringify([site.sourceHash, deps, site.reasons]));
    return { site, id, from: key(site.before), to: key(site.after) };
  });
  if (new Set(pairs.map((p) => p.id)).size !== 11 || pairs.some((p) => !TARGETS.has(p.id))) return fail();
  if (pairs.every((p) => !prior[p.from])) return pairs.some((p) => !!now[p.from] || (now[p.to] ?? 0) > (prior[p.to] ?? 0)) ? fail() : { budget, errors: [] };
  if (pairs.some((p) => prior[p.from] !== 1 || !!prior[p.to] || now[p.to] !== 1 || !!now[p.from] || p.from === p.to)) return fail();
  for (const file of [ITEMS, V1]) {
    const before = read(file, true),
      after = read(file, false),
      hashes = HASHES[file]!;
    if (before === null || after === null || digest(before) !== hashes[0] || digest(after) !== hashes[1] || !miningCategoryProof(file, before, after))
      return fail();
  }
  for (const { site } of pairs) {
    const current = inventory.find((f) => f.file === site.file)?.sites.filter((s) => s.scopeName === site.scopeName && s.sourceHash === site.sourceHash);
    if (current?.length !== 1) return fail();
    const actual = current[0]!,
      deps = { ...actual.dependencies };
    delete deps["pnpm-lock.yaml"];
    deps[LOCK] = lock;
    if (
      actual.kind !== site.kind ||
      actual.shape !== site.shape ||
      JSON.stringify(actual.unknown) !== JSON.stringify(site.reasons) ||
      JSON.stringify(deps) !== JSON.stringify(site.after) ||
      JSON.stringify(Object.keys(site.before)) !== JSON.stringify(Object.keys(site.after))
    )
      return fail();
    for (const [file, oldHash] of Object.entries(site.before)) {
      if (file === LOCK) {
        if (oldHash !== lock || site.after[file] !== lock) return fail();
        continue;
      }
      const before = read(file, true),
        after = read(file, false),
        newHash = site.after[file as keyof typeof site.after];
      if (before === null || after === null || digest(before) !== oldHash || digest(after) !== newHash) return fail();
      if (HASHES[file] ? oldHash !== HASHES[file]![0] || newHash !== HASHES[file]![1] : before !== after) return fail();
    }
  }
  for (const p of pairs) {
    delete budget[p.from];
    budget[p.to] = 1;
  }
  return { budget, errors: [] };
}
