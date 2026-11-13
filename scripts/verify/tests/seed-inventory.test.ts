import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

test("current catalogues require 478 news (TASK-0635 adds five isolated previews) plus 83 eligible policy identities", () => {
  const ids = industrySourceIds(ROOT);
  assert.equal(ids.length, 561);
  assert.equal(ids.filter((id) => id.startsWith("policy-")).length, 83);
  assert.equal(new Set(ids).size, ids.length);
});

test("TASK-0635 keeps Mendoza isolated and enables only the four reviewed official news sources", () => {
  const sources = JSON.parse(readFileSync(join(ROOT, "industry/sources.json"), "utf8")).sources.filter((source: { id: string }) =>
    source.id.startsWith("exp-20261113-ar-"),
  );
  assert.deepEqual(sources.map((source: { id: string }) => source.id).sort(), [
    "exp-20261113-ar-jujuy-mining-news",
    "exp-20261113-ar-mendoza-mining-news",
    "exp-20261113-ar-salta-news",
    "exp-20261113-ar-santacruz-energy-news",
    "exp-20261113-ar-santacruz-government-mining",
  ]);
  for (const source of sources) {
    const held = source.id === "exp-20261113-ar-mendoza-mining-news";
    assert.equal(source.enabled, !held);
    assert.equal(source.participation_mode, held ? "isolated" : "editorial");
    assert.equal(source.interval_minutes, 60);
    assert.equal(source.site_fulltext, !held);
    assert.equal(source.syndicate_fulltext, false);
  }
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
