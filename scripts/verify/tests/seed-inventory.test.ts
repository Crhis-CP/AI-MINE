import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { industrySourceIds, seedSourceMismatch } from "../run.ts";
import { ROOT } from "../lib.ts";
import { scratch, write } from "./helpers.ts";

test("full seed combines news with collectable policy IDs and preserves seeder identity rules", () => {
  const root = scratch();
  const collect = (url: string, kind = "rss") => ({ kind, config: { feedUrl: url } });
  write(root, {
    "industry/sources.json": JSON.stringify({
      sources: [
        { id: "news", ...collect("https://source.invalid/news") },
        { id: "policy-existing", ...collect("https://source.invalid/existing") },
        { id: "news", ...collect("https://source.invalid/ignored-second-id") },
      ],
    }),
    "industry/policy-sources.json": JSON.stringify({
      sources: [
        { id: "READY", status: "ready", collect: collect("https://source.invalid/ready") },
        { id: "Overseas", status: "needs_overseas", collect: collect("https://source.invalid/overseas") },
        { id: "NeedsReader", status: "needs_reader", collect: collect("https://source.invalid/reader") },
        { id: "Blocked", status: "blocked", collect: collect("https://source.invalid/blocked") },
        { id: "Reference", status: "reference_only", collect: collect("https://source.invalid/reference") },
        { id: "NoConfig", status: "ready", collect: null },
        { id: "Existing", status: "ready", collect: collect("https://source.invalid/other") },
        { id: "NewsAlias", status: "ready", collect: collect("http://www.source.invalid/news/?utm_source=fixture#part") },
        { id: "PolicyAlias", status: "ready", collect: collect("https://source.invalid/ready") },
        { id: "DifferentKind", status: "ready", collect: collect("https://source.invalid/news", "web_list") },
      ],
    }),
  });
  assert.deepEqual(industrySourceIds(root), ["news", "policy-differentkind", "policy-existing", "policy-overseas", "policy-ready"]);
});

test("seed evidence requires exact IDs, including equal-count substitutions and duplicates", () => {
  const expected = ["news", "policy-ready"];
  assert.equal(seedSourceMismatch(expected, '["policy-ready","news"]'), null);
  assert.match(seedSourceMismatch(expected, '["news","unexpected"]')!, /missing: policy-ready; unexpected: unexpected/);
  assert.match(seedSourceMismatch(expected, '["news"]')!, /seeded 1 sources, catalogues require 2/);
  assert.match(seedSourceMismatch(expected, '["news","news"]')!, /duplicate IDs: 1/);
  assert.match(seedSourceMismatch(expected, "2")!, /not a string array/);
  assert.match(seedSourceMismatch(expected, '["news",null]')!, /not a string array/);
  assert.match(seedSourceMismatch(expected, "database error")!, /not valid JSON/);
  assert.equal(seedSourceMismatch([], "[]"), null);
});

test("current catalogues require 319 news plus 81 eligible policy identities", () => {
  const ids = industrySourceIds(ROOT);
  assert.equal(ids.length, 400);
  assert.equal(ids.filter((id) => id.startsWith("policy-")).length, 81);
  assert.equal(new Set(ids).size, ids.length);
});

test("malformed catalogue identities fail rather than silently shrinking expected coverage", () => {
  const root = scratch();
  write(root, {
    "industry/sources.json": JSON.stringify({ sources: [{ id: "", kind: "rss", config: {} }] }),
    "industry/policy-sources.json": JSON.stringify({ sources: [] }),
  });
  assert.throws(() => industrySourceIds(root), /Invalid seed source identity/);
});

test("importable seed helpers do not change direct verify CLI refusal of unfinished stages", () => {
  const result = spawnSync(process.execPath, ["scripts/verify/run.ts", "--release-check"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /make release-check:.*not implemented yet/);
});
