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

test("current catalogues require 474 news plus 83 eligible policy identities", () => {
  const ids = industrySourceIds(ROOT);
  assert.equal(ids.length, 557);
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

test("TASK-0651 repairs HRSS with its original ID and runtime guards, leaving Torex stopped", () => {
  const { sources } = JSON.parse(readFileSync(join(ROOT, "industry/sources.json"), "utf8")) as { sources: Record<string, unknown>[] };
  const plan = JSON.parse(readFileSync(join(ROOT, "docs/acceptance/source-repairs-20261113/source-intake.json"), "utf8"));
  const guard = JSON.parse(readFileSync(join(ROOT, "docs/acceptance/source-repairs-20261113/runtime-guard.json"), "utf8"));
  const proof = JSON.parse(readFileSync(join(ROOT, "docs/acceptance/source-repairs-20261113/hrss-preview.json"), "utf8"));
  const stopped = JSON.parse(readFileSync(join(ROOT, "docs/acceptance/source-repairs-20261113/torex-stopped.json"), "utf8"));
  const [prepared] = prepareIntake(plan, sources);
  assert.equal(plan.entries.length, 1);
  assert.equal(prepared!.entry.id, "hrss-index-html-news");
  assert.equal(prepared!.entry.expected_existing, true);
  assert.equal(prepared!.entry.expected_config_hash, guard.expected_current_config_hash);
  assert.equal(prepared!.entry.expected_owner_entity_id, null);
  assert.equal(prepared!.entry.owner_entity_id, "hrss.yn.gov.cn");
  assert.equal(prepared!.input.config.url, "https://hrss.yn.gov.cn/gsgg/gztz/");
  assert.equal(prepared!.input.config.language, "zh-CN");
  assert.equal(prepared!.input.config.publishedAtUtcOffset, "+08:00");
  assert.equal(prepared!.entry.target_config_hash, proof.target_config_hash);
  assert.equal(proof.preview_count, 20);
  assert.equal(guard.safe_config_hash_matches_runtime, true);
  assert.equal(stopped.included_in_intake, false);
  assert.equal(stopped.local_scope_evaluation.decision, "deny");
  assert.ok(!plan.entries.some((entry: { id: string }) => entry.id === "rpl-torexgold"));
});
