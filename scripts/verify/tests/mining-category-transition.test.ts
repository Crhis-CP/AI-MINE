import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { miningCategoryBudget, miningCategoryProof, type MiningCategoryTransition } from "../mining-category-transition.ts";
import { digest, type extractOwnership } from "../ts-ownership.ts";
import { ROOT } from "../lib.ts";

type Site = MiningCategoryTransition["sites"][number];
const fixture = JSON.parse(readFileSync(new URL("./fixtures/mining-category-transition.json", import.meta.url), "utf8")) as {
  sources: Record<string, { before: string; after: string }>;
  transition: MiningCategoryTransition;
};
const sources = fixture.sources as Record<string, { before: string; after: string }>;
const key = (site: Site, side: "before" | "after") => `${site.file}:${site.scopeName}:` + digest(JSON.stringify([site.sourceHash, site[side], site.reasons]));
const prior = Object.fromEntries(fixture.transition.sites.map((s) => [key(s, "before"), 1]));
const now = Object.fromEntries(fixture.transition.sites.map((s) => [key(s, "after"), 1]));
const inventory = [...new Set<string>(fixture.transition.sites.map((s) => s.file))].map((file) => ({
  file,
  sites: fixture.transition.sites
    .filter((s) => s.file === file)
    .map((s) => ({ scopeName: s.scopeName, kind: s.kind, sourceHash: s.sourceHash, shape: s.shape, unknown: s.reasons, dependencies: s.after })),
})) as ReturnType<typeof extractOwnership>;
const lock = fixture.transition.sites[0]!.after["sql/parser-locked-subgraph"]!;
const read = (file: string, before: boolean) => sources[file]?.[before ? "before" : "after"] ?? readFileSync(path.join(ROOT, file), "utf8");
// The real extractor supplies pnpm-lock rather than the normalized parser dependency key.
for (const f of inventory)
  for (const s of f.sites) {
    s.dependencies = { ...s.dependencies };
    delete s.dependencies["sql/parser-locked-subgraph"];
  }
const verify = (value = fixture.transition, current = now, previous = prior, reader = read) =>
  miningCategoryBudget(current, previous, value, inventory, lock, reader);

test("the exact category projection transition transfers eleven slots once without changing counts", () => {
  for (const [file, texts] of Object.entries(sources)) assert.equal(miningCategoryProof(file, texts.before, texts.after), true, file);
  const result = verify();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.budget, now);
  assert.deepEqual(verify(fixture.transition, now, now).budget, now);
  assert.deepEqual(miningCategoryBudget(now, prior, undefined, inventory, lock, read).errors, []);
});

test("all other bytes and active AST positions remain fixed, including helper and import bindings", () => {
  for (const [file, texts] of Object.entries(sources)) {
    for (const after of [
      texts.after.trimEnd(),
      texts.after + "\n",
      texts.after.replace("toPublicApiCategory,", "toPublicApiCategory as category,"),
      texts.after.replace('"@amp/contracts/taxonomy"', '"./other.ts"'),
      texts.after + "\nfunction extra() { return sql`SELECT * FROM receipts`; }",
      texts.after.replace("FROM publications", "FROM receipts"),
      texts.after.replace("toPublicApiCategory(row.category)", "toPublicApiCategory(row.title)"),
      texts.after.replace("toPublicApiCategory(item.category)", "toPublicApiCategory(item.title)"),
    ].filter((value) => value !== texts.after))
      assert.equal(miningCategoryProof(file, texts.before, after), false, file);
    assert.equal(miningCategoryProof(file, texts.before.replace("import", "// import"), texts.after), false);
  }
  const file = Object.keys(sources).find((name) => name.endsWith("/items.ts"))!,
    t = sources[file]!;
  assert.equal(miningCategoryProof(file, t.before, t.after.replace("if (!category)", "if (category)")), false);
  assert.equal(
    miningCategoryProof(file, t.before, t.after.replace(`AND p.category = \${category}`, "AND EXISTS (SELECT 1 FROM receipts), publications")),
    false,
  );
});

test("wrong preimages, SQL, reasons, dependencies, duplicate or increased budgets are rejected", () => {
  for (const modify of [
    (v: MiningCategoryTransition) => v.sites[0]!.reasons.push("extra"),
    (v: MiningCategoryTransition) => (v.sites[0]!.shape += " from receipts"),
    (v: MiningCategoryTransition) => (v.sites[0]!.kind = "other"),
    (v: MiningCategoryTransition) => (v.sites[0]!.scopeName += "/new"),
    (v: MiningCategoryTransition) => (v.sites[0]!.sourceHash = "0".repeat(64)),
    (v: MiningCategoryTransition) => Object.assign(v.sites[0]!.after, { "other.ts": "0".repeat(64) }),
    (v: MiningCategoryTransition) => (v.sites[1] = v.sites[0]!),
  ]) {
    const value = structuredClone(fixture.transition);
    modify(value);
    assert.ok(verify(value).errors.length);
  }
  const first = Object.keys(now)[0]!;
  assert.ok(verify(fixture.transition, { ...now, [first]: 2 }).errors.length);
  assert.ok(verify(fixture.transition, { ...now, ...prior }).errors.length);
  assert.ok(verify(fixture.transition, now, { ...prior, [first]: 1 }).errors.length);
  assert.ok(verify(fixture.transition, now, prior, (file, before) => (before ? read(file, before).trimEnd() : read(file, before))).errors.length);
  assert.ok(verify(fixture.transition, now, prior, (file, before) => (before ? read(file, before) : read(file, before) + "\n")).errors.length);
});
