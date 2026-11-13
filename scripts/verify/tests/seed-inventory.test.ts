import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { prepareIntake } from "../../source-intake.ts";
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

test("current catalogues require 524 news plus 83 eligible policy identities", () => {
  const ids = industrySourceIds(ROOT);
  assert.equal(ids.length, 607);
  assert.equal(ids.filter((id) => id.startsWith("policy-")).length, 83);
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

test("news catalogue has no two sources on the same kind and entry URL (createSource dedupes on these, TASK-0588)", () => {
  const { sources } = JSON.parse(readFileSync(join(ROOT, "industry/sources.json"), "utf8")) as {
    sources: { id: string; kind: string; config: { feedUrl?: string; url?: string } }[];
  };
  const seen = new Map<string, string>();
  for (const source of sources) {
    const entry = source.config.feedUrl ?? source.config.url;
    if (!entry) continue;
    const key = `${source.kind} ${entry}`;
    assert.equal(seen.get(key), undefined, `${source.id} repeats ${seen.get(key)} (${key})`);
    seen.set(key, source.id);
  }
});

test("TASK-0645 catalogue, intake and actual preview bind the same 51 sources and preserve the CGS duplicate", () => {
  const { sources } = JSON.parse(readFileSync(join(ROOT, "industry/sources.json"), "utf8")) as { sources: Record<string, unknown>[] };
  const plan = JSON.parse(readFileSync(join(ROOT, "docs/acceptance/sources-global-20261113/source-intake.json"), "utf8"));
  const preview = JSON.parse(readFileSync(join(ROOT, "docs/acceptance/sources-global-20261113/source-preview.json"), "utf8"));
  const dedup = JSON.parse(readFileSync(join(ROOT, "docs/acceptance/sources-global-20261113/production-dedup.json"), "utf8"));
  const added = sources.filter((source) => String(source.id).startsWith("exp-20261113-global-"));
  const prepared = prepareIntake(plan, sources);
  assert.equal(added.length, 51);
  assert.equal(prepared.length, 51);
  assert.equal(new Set(added.map((source) => source.owner_entity_id)).size, 50);
  const ids = added.map((source) => String(source.id)).sort();
  assert.deepEqual(prepared.map(({ entry }) => entry.id).sort(), ids);
  assert.deepEqual(preview.sources.map((source: { id: string }) => source.id).sort(), ids);
  assert.deepEqual([...dedup.accepted_subset_ids].sort(), ids);
  assert.equal(dedup.request_candidates, 52);
  assert.equal(dedup.query_count, 1);
  assert.equal(dedup.accepted_subset_collision_count, 0);
  assert.deepEqual(dedup.preserved_existing_records.map((source: { id: string }) => source.id).sort(), ["cgs-news", "policy-cn-010"]);
  assert.ok(!ids.includes("exp-20261113-global-cn-cgs-gov-cn"));
  assert.equal(preview.body_samples_observed, 48);
  assert.equal(preview.sources.filter((row: { body_sample: { body_observed: boolean } }) => row.body_sample.body_observed).length, 48);
  for (const { entry, input } of prepared) {
    const source = added.find((row) => row.id === entry.id)!;
    const recorded = preview.sources.find((row: { id: string }) => row.id === entry.id);
    assert.equal(recorded.target_config_hash, entry.target_config_hash);
    assert.equal(recorded.preview_status, "succeeded");
    assert.equal(recorded.robots.allowed, true);
    assert.ok(recorded.count > 0 && recorded.sample_item.title_example.trim() && /^https:\/\//.test(recorded.sample_item.url));
    assert.equal(entry.expected_existing, false);
    assert.equal(source.owner_entity_id, entry.owner_entity_id);
    assert.equal(source.enabled, true);
    assert.equal(source.participation_mode, "editorial");
    assert.equal(source.interval_minutes, 60);
    assert.equal(source.site_fulltext, true);
    assert.equal(source.syndicate_fulltext, false);
    assert.equal(input.site_fulltext, true);
    assert.equal(input.syndicate_fulltext, false);
  }
});
