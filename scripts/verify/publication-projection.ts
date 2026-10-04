import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { API } from "typescript/unstable/sync";
import * as ts from "typescript/unstable/ast";
import { z } from "zod";
import { digest, type extractOwnership } from "./ts-ownership.ts";
import { sqlOwnership } from "./sql-ownership.ts";

const ITEMS = "packages/backend/src/publication/items.ts";
const POOL = "packages/backend/src/publication/pool.ts";
const V1 = "packages/backend/src/publication/v1.ts";
const LOCK = "sql/parser-locked-subgraph";
const TARGETS: Record<string, string> = {
  [`${POOL}:loadPool/run/result`]: "cbab10a65a0a5aca82b5d0413f3f9b9dec08ed289ef63e1b67c17a769958da63",
  [`${POOL}:loadPool/run/rows`]: "e544fa9bbee69430ee3cb72cb44543bcce78c1bea9fbac16e40b70c3ef4742ef",
  [`${POOL}:loadPool/run/{ n }`]: "fcfd1f767a9e6a7d7cd419983ac01ac8c44c68498e64dd6f972bb4abc1f7cfea",
  [`${V1}:v1Items/run`]: "fcb1437ace4c15aeaabbe793c76ce70d3ef85fc2ae56f35aab737d317c7748ab",
};
export const publicationProjectionSchema = z
  .object({
    revision: z.literal("TASK-0010-source-excerpt-v4"),
    before: z.literal("0bd2ecf4478e01b6c1b4348025ce7ccceaf6ee9ce23aef39269c758577c12775"),
    after: z.literal("1b0a1d54d20393a63bd9a1320c577f1c20a20f0f14d9ac9c8f96e7112ae16e2c"),
    sites: z
      .array(
        z
          .object({
            file: z.enum([POOL, V1]),
            scopeName: z.string(),
            sql: z.string(),
            shape: z.string(),
            reasons: z.array(z.string()),
            dependencies: z.partialRecord(z.enum([ITEMS, POOL, V1, LOCK]), z.string().regex(/^[a-f0-9]{64}$/)),
            projectionOffsets: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().positive()])),
          })
          .strict(),
      )
      .length(4),
  })
  .strict();
export type PublicationProjection = z.infer<typeof publicationProjectionSchema>;

function parseSources<T>(texts: string[], read: (sources: ts.SourceFile[]) => T): T | undefined {
  const dir = mkdtempSync(path.join(tmpdir(), "publication-projection-"));
  const api = new API({ cwd: dir });
  try {
    const files = texts.map((text, i) => {
      const file = path.join(dir, `${i}.ts`);
      writeFileSync(file, text);
      return file;
    });
    const snapshot = api.updateSnapshot({ openFiles: files });
    try {
      const sources = files.map((file) => {
        const project = snapshot.getDefaultProjectForFile(file);
        return project && !project.program.getSyntacticDiagnostics(file).length ? project.program.getSourceFile(file) : undefined;
      });
      return sources.every((source) => !!source) ? read(sources as ts.SourceFile[]) : undefined;
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Exact static projection substitution; all bytes outside the template literal stay unchanged. */
export function publicationProjectionProof(before: string, after: string) {
  return parseSources([before, after], (sources) => {
    const parsed = sources.map((source) => {
      const declarations = source.statements.flatMap((statement) =>
        ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const
          ? statement.declarationList.declarations.filter((declaration) => declaration.name.getText() === "ITEM_COLUMNS")
          : [],
      );
      if (declarations.length !== 1 || !ts.isVariableDeclarationList(declarations[0]!.parent) || declarations[0]!.parent.declarations.length !== 1)
        return undefined;
      const value = declarations[0]!.initializer;
      if (!value || !ts.isTaggedTemplateExpression(value) || value.tag.getText() !== "sql" || !ts.isNoSubstitutionTemplateLiteral(value.template))
        return undefined;
      const sql = sqlOwnership(value.template.text);
      if (sql.unknown.length || sql.relations.length) return undefined;
      return {
        sql: value.template.text.replace(/\s+/g, " ").trim(),
        shape: sql.shape,
        outside: `${source.text.slice(0, value.template.getStart())}__PROJECTION__${source.text.slice(value.template.end)}`,
      };
    });
    const [old, current] = parsed;
    if (!old || !current || old.outside !== current.outside || old.sql.split("p.summary").length !== 2) return undefined;
    const fallback = "coalesce(p.summary, CASE WHEN s.site_fulltext AND p.visibility = 'public' THEN p.source_excerpt END) AS summary";
    return current.sql === old.sql.replace("p.summary", fallback) ? { beforeShape: old.shape, afterShape: current.shape } : undefined;
  });
}

/** One named migration of four existing UNKNOWN slots, never a general dependency-rekey allowance. */
export function publicationProjectionBudget(
  now: Record<string, number>,
  prior: Record<string, number>,
  value: unknown,
  inventory: ReturnType<typeof extractOwnership>,
  lock: string,
  read: (file: string, before: boolean) => string | null,
) {
  const budget = { ...prior };
  const fail = () => ({ budget: { ...prior }, errors: ["publication projection: fixed v4 proof or one-use UNKNOWN transfer failed"] });
  if (value === undefined) return { budget, errors: [] };
  const parsed = publicationProjectionSchema.safeParse(value);
  if (!parsed.success) return fail();
  const proof = parsed.data,
    identities = proof.sites.map((site) => `${site.file}:${site.scopeName}`);
  if (new Set(identities).size !== 4 || identities.some((id) => !TARGETS[id])) return fail();
  const pairs = proof.sites.map((site) => {
    const id = `${site.file}:${site.scopeName}`,
      source = digest(site.sql);
    const key = (dependencies: Record<string, string | undefined>) => `${id}:${digest(JSON.stringify([source, dependencies, site.reasons]))}`;
    return { site, source, from: key(site.dependencies), to: key({ ...site.dependencies, [ITEMS]: proof.after }) };
  });
  if (pairs.some(({ site, source }) => TARGETS[`${site.file}:${site.scopeName}`] !== source || site.dependencies[ITEMS] !== proof.before)) return fail();
  if (pairs.every(({ from }) => !prior[from]))
    return pairs.some(({ from, to }) => !!now[from] || (now[to] ?? 0) > (prior[to] ?? 0)) ? fail() : { budget, errors: [] };
  if (pairs.some(({ from, to }) => prior[from] !== 1 || !!prior[to] || now[to] !== 1 || !!now[from] || from === to)) return fail();
  const before = read(ITEMS, true),
    after = read(ITEMS, false);
  if (before === null || after === null || digest(before) !== proof.before || digest(after) !== proof.after) return fail();
  const change = publicationProjectionProof(before, after);
  if (!change) return fail();
  const callers = new Map<string, string>();
  for (const { site, source } of pairs) {
    const current = inventory.find((file) => file.file === site.file)?.sites.filter((item) => item.scopeName === site.scopeName && item.sourceHash === source);
    if (current?.length !== 1 || current[0]!.kind !== "template") return fail();
    const actual = current[0]!,
      dependencies = { ...actual.dependencies };
    delete dependencies["pnpm-lock.yaml"];
    dependencies[LOCK] = lock;
    if (
      JSON.stringify(dependencies) !== JSON.stringify({ ...site.dependencies, [ITEMS]: proof.after }) ||
      JSON.stringify(actual.unknown) !== JSON.stringify(site.reasons)
    )
      return fail();
    const pieces = actual.shape.split(change.afterShape);
    if (pieces.length - 1 !== site.projectionOffsets.length || site.shape !== pieces.join(change.beforeShape)) return fail();
    for (const [file, expected] of Object.entries(site.dependencies)) {
      if (file === ITEMS || file === LOCK) continue;
      const old = read(file, true),
        text = read(file, false);
      if (old === null || text === null || old !== text || digest(text) !== expected) return fail();
      callers.set(file, text);
    }
  }
  const callerFiles = [...callers.keys()];
  const offsetsMatch = parseSources([...callers.values()], (sources) =>
    pairs.every(({ site, source }) => {
      const matches: ts.TaggedTemplateExpression[] = [];
      const walk = (node: ts.Node): void => {
        if (ts.isTaggedTemplateExpression(node) && digest(node.getText()) === source) matches.push(node);
        node.forEachChild(walk);
      };
      walk(sources[callerFiles.indexOf(site.file)]!);
      if (matches.length !== 1) return false;
      const node = matches[0]!,
        offsets = ts.isTemplateExpression(node.template)
          ? node.template.templateSpans
              .filter((span) => span.expression.getText() === "ITEM_COLUMNS")
              .map((span) => [span.expression.getStart() - node.getStart(), span.expression.end - node.getStart()])
          : [];
      return node.getText() === site.sql && JSON.stringify(offsets) === JSON.stringify(site.projectionOffsets);
    }),
  );
  if (!offsetsMatch) return fail();
  for (const { from, to } of pairs) {
    delete budget[from];
    budget[to] = 1;
  }
  return { budget, errors: [] };
}
