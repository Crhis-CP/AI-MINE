import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCatalogue, compareOwnership, ownershipReport, type OwnershipMap, type Baseline } from "../data-ownership.ts";
import type { extractOwnership } from "../ts-ownership.ts";

const map: OwnershipMap = {
  moduleAliases: { ops: "platform/ops", identity: "platform/identity" },
  tables: {
    "public.articles": { module: "content", access: "business" },
    "public.sources": { module: "sources", access: "business" },
    "public.settings": { module: "shared/settings", access: "business" },
  },
  externalTables: {},
  settings: { "models.*": "ai-gateway", "heartbeat.*": "platform/ops" },
  retiredSettings: ["contact_qr"],
  readModels: { "packages/read.ts": ["public.articles"] },
  splitFiles: { "packages/split.ts": {} },
};
const fixture = (file = "packages/change.ts", module = "publication", table = "public.articles", mode: "read" | "write" = "read") =>
  [
    {
      file,
      scope: "runtime",
      modules: [{ name: module, line: 1 }],
      ignoredTags: [],
      sites: [
        {
          line: 2,
          column: 1,
          scopeName: "query",
          kind: "template",
          sourceHash: "query-v1",
          dependencies: { [file]: "file-v1" },
          relations: [{ table, mode, keys: [] as string[] }],
          unknown: [] as string[],
          shape: "SELECT",
        },
      ],
    },
  ] satisfies ReturnType<typeof extractOwnership>;

test("publication read-model and appendix split debt are explicit, separate and directional", () => {
  const allowed = ownershipReport(fixture("packages/read.ts"), map);
  assert.equal(allowed.totals["runtime.read-model"], 1);
  assert.deepEqual(allowed.baseline.debt, {});
  assert.equal(ownershipReport(fixture("packages/read.ts", "publication", "public.articles", "write"), map).totals["runtime.cross-debt"], 1);
  assert.equal(ownershipReport(fixture("packages/split.ts"), map).totals["runtime.split-debt"], 1);
  assert.equal(ownershipReport(fixture("packages/read.ts", "editorial"), map).totals["runtime.cross-debt"], 1);
});
test("crossings cannot grow, move to another function/file or leave reusable stale budgets", () => {
  const prior = ownershipReport(fixture(), map).baseline;
  const doubled = fixture();
  doubled[0].sites.push(structuredClone(doubled[0].sites[0]));
  assert.match(compareOwnership(ownershipReport(doubled, map).baseline, prior).join(), /increased/);
  const moved = fixture("packages/other.ts");
  moved[0].sites[0].scopeName = "elsewhere";
  assert.match(compareOwnership(ownershipReport(moved, map).baseline, prior).join(), /increased/);
  const empty = { debt: {}, unknown: {} };
  assert.match(compareOwnership(empty, prior).join(), /obsolete/);
  assert.deepEqual(compareOwnership(empty, prior, false), []);
  assert.deepEqual(compareOwnership(prior, prior), []);
});
test("settings use key ownership; dynamic/retired keys remain unresolved", () => {
  const own = fixture("packages/settings.ts", "ai-gateway", "public.settings", "write");
  own[0].sites[0].relations[0].keys = ["models.chat"];
  assert.equal(ownershipReport(own, map).totals["runtime.own"], 1);
  own[0].sites[0].relations[0].keys = ["heartbeat.worker"];
  assert.equal(ownershipReport(own, map).totals["runtime.cross-debt"], 1);
  for (const keys of [[], ["contact_qr"], ["anything.*"]]) {
    own[0].sites[0].relations[0].keys = keys;
    assert.equal(ownershipReport(own, map).totals["runtime.unknownSites"], 1);
  }
});
test("opaque SQL is recorded and changed dependencies fail even without a resolved table", () => {
  const data = fixture();
  data[0].sites[0].unknown = ["dynamic raw SQL"];
  data[0].sites[0].relations = [];
  const prior = ownershipReport(data, map).baseline;
  data[0].sites[0].dependencies["packages/change.ts"] = "file-v2";
  assert.match(compareOwnership(ownershipReport(data, map).baseline, prior).join(), /unknown: new/);
});

test("UNKNOWN keeps source protection while replacing whole-lock bytes with the selected graph", () => {
  const data = fixture();
  data[0].sites[0].unknown = ["opaque SQL"];
  data[0].sites[0].dependencies["pnpm-lock.yaml"] = "whole-lock-before";
  const before = ownershipReport(data, map, "sql-graph-one").baseline;
  data[0].sites[0].dependencies["pnpm-lock.yaml"] = "whole-lock-after";
  assert.deepEqual(compareOwnership(ownershipReport(data, map, "sql-graph-one").baseline, before), []);
  assert.match(compareOwnership(ownershipReport(data, map, "sql-graph-two").baseline, before).join(), /unknown: new/);
  data[0].sites[0].dependencies["packages/change.ts"] = "source-changed";
  assert.match(compareOwnership(ownershipReport(data, map, "sql-graph-one").baseline, before).join(), /unknown: new/);
  assert.throws(() => ownershipReport(data, map), /fingerprint missing/);
});
test("unmapped runtime tables and inconsistent role catalogue cannot pass a zero count", () => {
  assert.match(ownershipReport(fixture("packages/change.ts", "content", "public.new_table"), map).errors.join(), /unmapped table/);
  const catalogue = { tables: { articles: { module: "content", access: "business" } } };
  const one = { ...map, tables: { "public.articles": map.tables["public.articles"] } };
  assert.deepEqual(checkCatalogue(one, catalogue, ["public.articles"]), []);
  assert.ok(checkCatalogue(one, catalogue, ["public.articles", "public.new_table"]).length);
  catalogue.tables.articles.access = "identity";
  assert.ok(checkCatalogue(one, catalogue, ["public.articles"]).length);
});

test("both budget operands reject nonnumeric, noninteger, negative and malformed data", () => {
  const empty: Baseline = { debt: {}, unknown: {} };
  for (const kind of ["debt", "unknown"])
    for (const value of ["not-a-number", null, -1, 0.5, Infinity, NaN, [], {}]) {
      const bad = { ...empty, [kind]: { introduced: value } } as Baseline;
      assert.match(compareOwnership(bad, empty).join(), /invalid JSON/);
      assert.match(compareOwnership(empty, bad).join(), /invalid JSON/);
      assert.match(compareOwnership(empty, bad, false).join(), /invalid JSON/);
    }
  for (const bad of [null, [], {}, { debt: [], unknown: {} }, { debt: {}, unknown: "invalid" }])
    assert.match(compareOwnership(empty, bad as unknown as Baseline).join(), /invalid JSON/);
  assert.deepEqual(compareOwnership(empty, empty), []);
});

test("ownership metadata rejects non-record containers and invalid field shapes", () => {
  for (const patch of [
    { tables: [] },
    { moduleAliases: [] },
    { tables: { "public.articles": { module: false, access: "business" } } },
    { settings: "invalid" },
    { readModels: { "packages/read.ts": "public.articles" } },
    { retiredSettings: {} },
    { splitFiles: { "packages/split.ts": true } },
  ])
    assert.throws(() => ownershipReport(fixture(), { ...map, ...patch } as OwnershipMap), /invalid JSON/);
  assert.match(checkCatalogue(map, { tables: [] } as never, []).join(), /invalid JSON/);
});
