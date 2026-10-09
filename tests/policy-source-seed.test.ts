import "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { POLICY_SOURCES, type PolicySource } from "@amp/industry/policy-sources";
import { createSource, readCurrentSourcePolicy } from "@amp/backend/admin/sources";
import { config } from "@amp/backend/config";
import { stopBoss } from "@amp/backend/jobs/queue";
import { closeDb, dbOf } from "@amp/backend/db";
import { seedPolicySources } from "../scripts/seed.ts";
import { enablePolicySources, listPolicySources, parsePolicySourceArgs, selectPolicySources } from "../scripts/policy-sources.ts";

const sql = dbOf("sources");
let requests = 0;
const server = http.createServer((req, res) => {
  requests++;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(req.url?.startsWith("/empty") ? "<p>没有文书</p>" : '<ul><li><a href="/doc/1">合成矿业管理办法第一号</a></li></ul>');
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopBoss();
  await closeDb();
});
const entry = (n: number, overrides: Partial<PolicySource> = {}): PolicySource => ({
  ...POLICY_SOURCES[0]!,
  id: `CN-${900 + n}`,
  jurisdiction: "CN",
  authority: { zh: "合成机关", original: "Fixture" },
  name: { zh: `合成栏目${n}`, original: `Fixture ${n}` },
  entry: `${base}/ok/${n}`,
  listed_url: `${base}/ok/${n}`,
  status: "ready",
  terms: "open",
  hold: null,
  collect: { kind: "web_list", config: { url: `${base}/ok/${n}`, itemSelector: "li", linkSelector: "a[href]", language: "zh-CN" } },
  ...overrides,
});
const id = (e: PolicySource) => `policy-${e.id.toLowerCase()}`;
const source = async (e: PolicySource) => (await sql`SELECT * FROM sources WHERE id=${id(e)}`)[0]!;
const snapshot = async () => ({
  sources: await sql`SELECT * FROM sources ORDER BY id`,
  policies: await sql`SELECT * FROM sources.source_policy_versions ORDER BY source_id,permission_version`,
  audit: await sql`SELECT * FROM audit_log ORDER BY id`,
});

test("policy initialization grants reviewed uses, stays disabled, and preserves existing operator edits", async () => {
  const open = entry(1),
    restricted = entry(2, { status: "needs_overseas", terms: "restricted" });
  const entries = [open, restricted, entry(3, { status: "needs_reader" }), entry(4, { status: "reference_only", collect: null })];
  const result = await seedPolicySources(entries);
  assert.deepEqual(result.added, { ready: 1, needs_overseas: 1 });
  assert.equal(result.skipped.waitingReader, 1);
  assert.equal(result.skipped.noConfiguration, 1);
  for (const e of [open, restricted]) {
    const row = await source(e),
      p = await readCurrentSourcePolicy(id(e));
    assert.deepEqual(
      [row.lane, row.enabled, row.health, row.next_fetch_at, row.interval_minutes, row.tier, row.syndicate_fulltext],
      ["policy", false, "paused", null, 360, "T1", false],
    );
    assert.deepEqual(p?.scope.hosts, ["127.0.0.1"]);
    assert.equal(p?.evidence[0]?.kind, "owner_declared");
    assert.equal(p?.permission_version, 1);
    assert.equal(p?.attachments_in_scope, true);
    for (const [purpose, decision] of Object.entries(p!.permissions))
      assert.equal(decision, e.terms !== "open" && ["public_original_fulltext", "public_translation"].includes(purpose) ? "deny" : "allow");
  }
  await sql`UPDATE sources SET name='人工名称', enabled=true, next_fetch_at='2100-01-01', updated_at=now() WHERE id=${id(open)}`;
  const before = await snapshot();
  assert.deepEqual((await seedPolicySources(entries)).added, { ready: 0, needs_overseas: 0 });
  assert.deepEqual(await snapshot(), before, "reseeding writes neither sources nor permission/audit rows");
  assert.equal(requests, 0, "initialization never fetches");
});

test("same-address entries skip duplication and malformed batch config is rejected before the first insertion", async () => {
  const first = entry(5),
    duplicate = entry(6, { collect: first.collect, entry: first.entry });
  const result = await seedPolicySources([first, duplicate]);
  assert.deepEqual(result.duplicates, [{ id: id(duplicate), existingId: id(first) }]);
  const good = entry(7),
    bad = entry(8, { collect: { kind: "web_list", config: { url: `${base}/bad`, madeUpConfig: true } } });
  const before = await snapshot();
  await assert.rejects(() => seedPolicySources([good, bad]), /unsupported|不支持|配置/i);
  assert.deepEqual(await snapshot(), before);
});

test("selection is explicit and bounded; dry run previews without database writes or enabling", async () => {
  const e = entry(9);
  assert.throws(() => selectPolicySources([e], {}), /请选择/);
  assert.throws(
    () =>
      selectPolicySources(
        Array.from({ length: 11 }, (_, i) => entry(20 + i)),
        { country: "CN" },
      ),
    /1至10/,
  );
  assert.throws(() => parsePolicySourceArgs(["enable", "--country", "CN", "--limit", "NaN"]), /整数/);
  await seedPolicySources([e]);
  const before = await snapshot(),
    beforeRequests = requests;
  const result = await enablePolicySources([e], { ids: [e.id], dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.results[0]?.status, "would_enable");
  assert.equal(result.results[0]?.count, 1);
  assert.equal(requests, beforeRequests + 1);
  assert.deepEqual(await snapshot(), before);
});

test("live fixture preview enables only eligible policy sources and writes separate preview/update audit", async () => {
  const ok = entry(10),
    empty = entry(11, { entry: `${base}/empty`, collect: { kind: "web_list", config: { url: `${base}/empty`, itemSelector: "li", linkSelector: "a[href]" } } });
  const held = entry(12, { hold: "等待同主机限速" }),
    overseas = entry(13, { status: "needs_overseas" }),
    news = entry(14);
  await seedPolicySources([ok, empty, held, overseas]);
  await createSource(
    {
      id: id(news),
      name: "既有资讯源",
      kind: "web_list",
      config: news.collect!.config,
      permission_scope: { hosts: ["127.0.0.1"], path_prefixes: ["/"], document_types: [], excluded_content: [] },
      attachments_in_scope: true,
    },
    "fixture",
  );
  const result = await enablePolicySources([ok, empty, held, overseas, news], { country: "CN", limit: 5 });
  assert.equal(result.ok, false);
  assert.equal(result.results.filter((r) => r.status === "enabled").length, 1);
  assert.equal((await source(ok)).enabled, true);
  assert.ok((await source(ok)).next_fetch_at);
  for (const e of [empty, held, overseas, news]) assert.equal((await source(e)).enabled, false);
  assert.equal((await source(news)).lane, "news");
  const actions = await sql`SELECT action FROM audit_log WHERE subject=${`source:${id(ok)}`} ORDER BY id`;
  assert.deepEqual(
    actions.map((r) => r.action),
    ["source.create", "source.preview", "source.update"],
  );
  const listed = await listPolicySources([ok, news]);
  assert.equal(listed[0]?.source?.enabled, true);
  assert.equal(listed[1]?.source, null, "news rows cannot enter the policy listing");
});
