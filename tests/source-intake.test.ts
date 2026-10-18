import "./setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { once } from "node:events";
import { after, test } from "node:test";
import { config } from "@amp/backend/config";
import { sql, closeDb } from "@amp/backend/db";
import { QUEUES, stopBoss } from "@amp/backend/jobs/queue";
import { sourceDetail, updateSource } from "@amp/backend/admin/sources";
import { sha256, stableJson } from "@amp/backend/lib/ids";
import { prepareIntake, applyIntakeEntry } from "../scripts/source-intake.ts";

config.allowPrivateNetworkFetch = true;
const server = createServer((req, res) => {
  res.setHeader("content-type", req.url === "/robots.txt" ? "text/plain" : "text/html");
  res.end(
    req.url === "/robots.txt"
      ? "User-agent: *\nAllow: /"
      : '<ul><li><a href="/article">Copper mine production update</a><time datetime="2026-10-15T12:00:00Z"></time></li></ul>',
  );
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopBoss();
  await closeDb();
});

test("incremental intake previews before enabling, resumes without duplicating and preserves subsequent owner edits", async () => {
  const source = {
    id: "intake-fixture-copper",
    name: "合成铜矿来源",
    kind: "web_list",
    lane: "news",
    config: {
      url: `${origin}/news`,
      itemSelector: "li",
      linkSelector: "a",
      titleSelector: "a",
      publishedAtSelector: "time",
      sourceDate: { format: "iso8601", language: "en" },
    },
    site_fulltext: false,
  };
  const entry = {
    id: source.id,
    target_config_hash: sha256(stableJson([source.kind, source.config])),
    expected_config_hash: null,
    expected_owner_entity_id: null,
    owner_entity_id: "fixture-copper",
    expected_existing: false,
  };
  const plan = { batch: "source-intake-20261017", entries: [entry] };
  const [prepared] = prepareIntake(plan, [source]);
  assert.throws(() => prepareIntake(plan, [{ ...source, config: { ...source.config, url: `${origin}/edited` } }]), /Catalogue changed/);
  const outcomes: string[] = [],
    actor = "upgrade:source-intake-20261017";
  const output = (_id: string, status: string) => {
    outcomes.push(status);
  };
  await applyIntakeEntry(prepared!, actor, false, output);
  assert.equal(outcomes.pop(), "would_create_preview_enable");
  assert.equal(await sourceDetail(source.id), null);
  await applyIntakeEntry(prepared!, actor, true, output);
  assert.equal(
    outcomes.pop(),
    "enabled_preview_passed",
    JSON.stringify(await sql`SELECT status,error FROM sources.source_previews WHERE source_id=${source.id}`),
  );
  const before = (await sourceDetail(source.id))!;
  assert.equal(before.source.enabled, true);
  assert.equal(before.source.site_fulltext, false);
  assert.equal(before.permission?.permissions.public_original_fulltext, "deny");
  const count = (await sql`SELECT count(*)::int AS n FROM sources.source_previews WHERE source_id=${source.id}`)[0]!.n;
  await applyIntakeEntry(prepared!, actor, true, output);
  assert.equal(outcomes.pop(), "enabled_preview_passed");
  assert.equal((await sql`SELECT count(*)::int AS n FROM sources.source_previews WHERE source_id=${source.id}`)[0]!.n, count);
  assert.equal((await sourceDetail(source.id))!.source.updated_at.toISOString(), before.source.updated_at.toISOString());
  await updateSource(source.id, { version: before.source.updated_at.toISOString(), patch: { enabled: false }, reason: "人工暂停" }, "fixture-owner");
  await applyIntakeEntry(prepared!, actor, true, output);
  assert.equal(outcomes.pop(), "blocked_unexpected_existing");
  assert.equal((await sourceDetail(source.id))!.source.enabled, false);
});

test("real intake CLI commits identity edits with publication jobs, exits cleanly and safely resumes", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "amp-intake-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ids = ["intake-cli-first", "intake-cli-next"];
  for (const id of ids)
    await sql`INSERT INTO sources(id,name,kind,config,enabled,owner_entity_id)
      VALUES(${id},'合成身份核对来源','rss',${sql.json({ feedUrl: `https://example.invalid/${id}` })},false,'fixture-before')`;
  const manifest = path.join(dir, "plan.json");
  await writeFile(
    manifest,
    JSON.stringify({
      batch: "source-intake-20261019",
      entries: [],
      identity_patches: ids.map((id) => ({
        id,
        expected_owner_entity_id: "fixture-before",
        owner_entity_id: "fixture-after",
        expected_entry_hosts: ["example.invalid"],
      })),
    }),
  );
  const run = async (apply: boolean) => {
    const { stdout } = await promisify(execFile)(process.execPath, ["scripts/source-intake.ts", manifest, ...(apply ? ["--apply"] : [])], {
      cwd: process.cwd(),
      env: process.env,
      timeout: 15_000,
    });
    return stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  };
  const preview = await run(false);
  assert.deepEqual(
    preview.slice(0, 2).map((r) => r.status),
    ["would_reconcile_identity", "would_reconcile_identity"],
  );
  assert.equal((await sourceDetail(ids[0]!))!.source.owner_entity_id, "fixture-before");
  const applied = await run(true);
  assert.deepEqual(
    applied.slice(0, 2).map((r) => r.status),
    ["identity_reconciled", "identity_reconciled"],
  );
  assert.equal(applied.at(-1).blocked, 0);
  for (const id of ids) {
    const source = (await sourceDetail(id))!.source;
    assert.equal(source.owner_entity_id, "fixture-after");
    assert.equal(source.enabled, false, "identity reconciliation preserves the existing pause");
    const jobs = await sql`SELECT data FROM pgboss.job WHERE name=${QUEUES.republishSource} AND data->>'sourceId'=${id}`;
    assert.equal(jobs.length, 1, "source edit and publication task both committed");
    assert.equal(jobs[0]!.data.lane, "news");
  }
  const resumed = await run(true);
  assert.deepEqual(
    resumed.slice(0, 2).map((r) => r.status),
    ["identity_unchanged", "identity_unchanged"],
  );
  assert.equal((await sql`SELECT count(*)::int n FROM pgboss.job WHERE name=${QUEUES.republishSource} AND data->>'sourceId' IN ${sql(ids)}`)[0]!.n, 2);
});
