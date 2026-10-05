import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { compareOwnership, ownershipReport, type OwnershipMap } from "../data-ownership.ts";
import { extractOwnership } from "../ts-ownership.ts";
import { TRANSACTION_FILE, TRANSACTION_SCOPE, stableTransactionDebt } from "../transaction-identity.ts";
import { ROOT } from "../lib.ts";
import { scratch, write } from "./helpers.ts";

const original = readFileSync(path.join(ROOT, TRANSACTION_FILE), "utf8");
const start = original.indexOf("export async function detachFromFact("),
  end = original.indexOf("\n}\n", start) + 2;
const body = original.slice(start, end);
const source = (fn = body, root = 'const sql = dbOf("editorial");') => `
import {dbOf} from "../module-db.ts";
${root}
declare function publishArticle(id: string): Promise<void>;
declare function enqueue(...args: unknown[]): Promise<void>;
declare function audit(...args: unknown[]): Promise<void>;
declare const QUEUES: {digest: string};
throw Error("Static analysis must not execute this source");
${fn}
`;
const map: OwnershipMap = {
  moduleAliases: {},
  tables: Object.fromEntries(
    ["articles", "fact_articles", "facts", "story_signals", "grouping_overrides"].map((table) => [`public.${table}`, { module: "other", access: "business" }]),
  ),
  externalTables: {},
  settings: {},
  retiredSettings: [],
  readModels: {},
  splitFiles: { [TRANSACTION_FILE]: {} },
};
function report(text: string, file = TRANSACTION_FILE) {
  const root = scratch();
  mkdirSync(path.join(root, "node_modules"));
  symlinkSync(path.resolve(ROOT, "packages/backend/node_modules/postgres"), path.join(root, "node_modules/postgres"));
  write(root, {
    "package.json": '{"type":"module"}',
    "tsconfig.json": '{"compilerOptions":{"module":"nodenext","strict":true,"allowImportingTsExtensions":true,"noEmit":true}}',
    "packages/backend/src/module-db.ts":
      'import type postgres from "postgres"; export function dbOf(_module: string): postgres.Sql { throw Error("static only"); }',
    [file]: text,
  });
  return ownershipReport(extractOwnership(root, [file]), map);
}
function legacyBudget(value: ReturnType<typeof report>) {
  return Object.fromEntries(
    Object.entries(value.baseline.debt).map(([key, count]) => {
      const parts = JSON.parse(key) as string[];
      const site = value.files[0]!.sites.find((s) => s.scopeName === parts[1]);
      if (site?.legacyScopeName) parts[1] = site.legacyScopeName;
      return [JSON.stringify(parts), count];
    }),
  );
}

test("the six immutable transaction crossings retain identity when unrelated declarations move them", () => {
  const text = source(),
    initial = report(text),
    shifted = report("const metadata = (id: string) => id;\n" + text);
  assert.equal(initial.references.filter((r) => r.scopeName.includes(TRANSACTION_SCOPE)).length, 6);
  assert.deepEqual(initial.baseline, shifted.baseline);
  assert.notDeepEqual(legacyBudget(initial), legacyBudget(shifted));
  const migrated = stableTransactionDebt(initial.baseline.debt, legacyBudget(initial), initial, () => text);
  assert.deepEqual(migrated, { budget: initial.baseline.debt, errors: [] });
  assert.deepEqual(stableTransactionDebt(shifted.baseline.debt, migrated.budget, shifted, () => null).errors, []);
});

test("first migration requires identical complete source, every old allowance and exact counts", () => {
  const text = source(),
    value = report(text),
    now = value.baseline.debt,
    prior = legacyBudget(value);
  const key = Object.keys(now).find((k) => k.includes(TRANSACTION_SCOPE))!,
    old = Object.keys(prior).find((k) => k.includes("<closure@"))!;
  for (const read of [() => null, (_file: string, before: boolean) => (before ? text : text + "\n")])
    assert.ok(stableTransactionDebt(now, prior, value, read).errors.length);
  for (const [n, p] of [
    [{ ...now, [key]: 2 }, prior],
    [{ ...now, [old]: 0 }, prior],
    [now, { ...prior, [old]: 0 }],
    [now, {}],
  ]) {
    const checked = stableTransactionDebt(n!, p!, value, () => text);
    assert.ok(checked.errors.length);
    assert.deepEqual(checked.budget, p);
  }
});

test("changed bodies, duplicate transactions, native-root changes and new files cannot borrow this identity", () => {
  const initial = report(source());
  for (const text of [
    source(body.replace("FOR UPDATE", "FOR SHARE")),
    source(body.replace("return { facts: factIds, stories: storyIds };", "return { facts: [], stories: storyIds };")),
    source(body.replace("const { facts, stories } =", "await sql.begin(async () => {}); const { facts, stories } =")),
    source(body + "\n" + body),
    source(body, 'const sql = dbOf("sources");'),
    source(body, 'let sql = dbOf("editorial");'),
  ]) {
    const changed = report(text);
    assert.ok(changed.files[0]!.sites.every((s) => !s.scopeName.includes(TRANSACTION_SCOPE)));
    assert.ok(compareOwnership(changed.baseline, initial.baseline).length);
  }
  const elsewhere = report(source(), "packages/backend/src/admin/other.ts");
  assert.ok(elsewhere.files[0]!.sites.every((s) => !s.scopeName.includes(TRANSACTION_SCOPE)));
});

test("unproved SQL remains on its original fingerprint and never receives a known transaction allowance", () => {
  const changed = report(source(body.replace(`tx\`SELECT 1 FROM articles WHERE id = \${id} FOR UPDATE\``, "tx.unsafe(id)")));
  assert.ok(changed.unresolved.length);
  assert.ok(changed.files[0]!.sites.every((s) => !s.legacyScopeName));
  assert.deepEqual(
    stableTransactionDebt({}, {}, changed, () => null),
    { budget: {}, errors: [] },
  );
});
