import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { buildApp } from "../apps/api/src/app.ts";
import { config } from "@amp/backend/config";
import { closeDb, dbOf } from "@amp/backend/db";
import { getBoss, stopBoss, QUEUES } from "@amp/backend/jobs/queue";
import { registerSourceJobs } from "@amp/backend/jobs/sources";
import { registerContentJobs } from "@amp/backend/jobs/content";
import { registerPublicationJobs } from "@amp/backend/jobs/publication";
import { scheduleDueSources } from "@amp/backend/sources/collect";
import { automaticFeedFixture, authoredSummary, authoredTitle, FEED_CASES } from "./automatic-feed-fixture.ts";

test("INV-01: real source/content workers collect, book model receipts and publish only admitted Chinese material", async (t) => {
  const sql = dbOf("ops");
  const fixture = await automaticFeedFixture();
  const savedConfig = { ...config };
  const dispatcher = getGlobalDispatcher(),
    offline = new MockAgent();
  offline.disableNetConnect();
  for (const url of [fixture.feedUrl, fixture.providerUrl]) offline.enableNetConnect(new URL(url).host);
  setGlobalDispatcher(offline);
  const variables = ["DASHSCOPE_BASE_URL", "ZHIPU_BASE_URL", "DEEPSEEK_BASE_URL", "DASHSCOPE_API_KEY", "ZHIPU_API_KEY", "DEEPSEEK_API_KEY"];
  const savedEnv = variables.map((key) => [key, process.env[key]] as const);
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  t.after(async () => {
    await stopBoss();
    for (const app of apps) await app.close();
    await fixture.close();
    setGlobalDispatcher(dispatcher);
    await offline.close();
    Object.assign(config, savedConfig);
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await closeDb();
  });
  for (const name of variables) process.env[name] = name.endsWith("BASE_URL") ? `${fixture.providerUrl}/v1` : "synthetic-test-key";
  Object.assign(config, {
    allowPrivateNetworkFetch: true,
    egressProxyUrl: null,
    modelCallsEnabled: true,
    privateHost: "private.automatic.test",
    devAdmin: { displayName: "Synthetic test owner" },
  });
  const admin = await buildApp("private-api");
  apps.push(admin);
  const reader = await buildApp("public-api");
  apps.push(reader);
  const headers = { "x-forwarded-host": "private.automatic.test", "x-csrf-token": "dev" };
  const sourceId = "automatic-fixture-feed";
  async function waitFor(label: string, check: () => Promise<boolean>) {
    for (let i = 0; i < 600; i++) {
      if (await check()) return;
      await delay(50);
    }
    const rows = await sql`SELECT title, processing_state, processing_error FROM articles WHERE source_id=${sourceId}`;
    assert.fail(`${label}: ${JSON.stringify({ rows, calls: fixture.calls.map(({ marker, step }) => ({ marker, step })) })}`);
  }
  async function editSource(patch: Record<string, unknown>) {
    const current = await admin.inject({ url: `/api/admin/sources/${sourceId}`, headers });
    assert.equal(current.statusCode, 200, current.body);
    const response = await admin.inject({
      method: "PATCH",
      url: `/api/admin/sources/${sourceId}`,
      headers,
      payload: { patch, version: current.json().source.updated_at, reason: "isolated fixture only" },
    });
    assert.equal(response.statusCode, 200, response.body);
  }
  const settled = async (queue: string, before = 0) =>
    (await sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name=${queue} AND state='completed'`)[0].n > before;
  {
    const created = await admin.inject({
      method: "POST",
      url: "/api/admin/sources",
      headers,
      payload: {
        id: sourceId,
        name: "SELF_AUTHORED 自动链夹具",
        kind: "rss",
        tier: "T2",
        participation_mode: "editorial",
        config: { feedUrl: fixture.feedUrl },
        permission_scope: { hosts: [new URL(fixture.feedUrl).hostname, "example.invalid"], path_prefixes: ["/"], document_types: [], excluded_content: [] },
        attachments_in_scope: false,
        site_fulltext: true,
        syndicate_fulltext: false,
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(created.json().created, true);
    await editSource({ enabled: false });
    const boss = await getBoss();
    await registerSourceJobs(boss);
    await registerContentJobs(boss, 1);
    await registerPublicationJobs(boss);
    assert.equal((await scheduleDueSources()).enqueued, 0, "paused fixture is not collected");
    assert.equal(fixture.feedRequests.length, 0);
    await editSource({ enabled: true });
    assert.equal((await scheduleDueSources()).enqueued, 1);
    await waitFor("three actual worker analyses completed", async () => {
      const [r] = await sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name=${QUEUES.analyze} AND state='completed'`;
      return r.n === FEED_CASES.length;
    });
    assert.equal(fixture.feedRequests.length, 1);
    const materials = await sql`SELECT id, title, body_status, revision FROM articles WHERE source_id=${sourceId}`;
    assert.equal(materials.length, 3);
    const ids = new Map(FEED_CASES.map(({ marker }) => [marker, materials.find((r) => r.title.includes(marker))!.id as string]));
    for (const { marker, label } of FEED_CASES) {
      const id = ids.get(marker)!;
      const [analysis] = await sql`SELECT origin, receipt_ids, output FROM analyses WHERE article_id=${id} ORDER BY id DESC LIMIT 1`;
      assert.equal(analysis.origin, "model");
      assert.equal(analysis.output.prefilter.label, label);
      const receipts = await sql`SELECT status, purpose, origin, request, response FROM receipts WHERE id IN ${sql(analysis.receipt_ids)}`;
      assert.ok(receipts.length > 0 && receipts.every((r) => r.status === "completed" && r.origin === "live"));
      const scope = receipts.find((r) => r.purpose === "prefilter_article")!;
      assert.match(scope.request.promptVersion, /^prefilter@/);
      assert.equal(JSON.parse(scope.response.choices[0].message.content).label, label);
      const detail = await reader.inject(`/api/site/items/${id}`);
      assert.equal(detail.statusCode, label === "PASS" ? 200 : 404, detail.body);
      if (label === "PASS") {
        assert.equal(detail.json().title, authoredTitle(marker));
        assert.equal(detail.json().summary, authoredSummary(marker));
        assert.equal(detail.json().body.zhKind, "original");
        assert.equal(detail.json().body.complete, true);
        assert.match(detail.json().body.zh, /自编采集夹具/);
        assert.equal(detail.json().publishedAt, "2026-01-01T00:00:00.000Z", "the actual RSS source date is preserved");
      }
    }
    assert.deepEqual(
      fixture.calls.filter((r) => r.marker === "AUTO_BLOCK").map((r) => r.step),
      ["prefilter"],
    );
    assert.ok(fixture.calls.filter((r) => r.marker === "AUTO_PASS").every((r) => r.user.includes("自编采集夹具")));
    const listing = await reader.inject("/api/site/pool");
    assert.equal(listing.statusCode, 200, listing.body);
    assert.deepEqual(
      listing.json().items.map((r: { id: string }) => r.id),
      [ids.get("AUTO_PASS")],
    );
    const modelCalls = fixture.calls.length;
    const fetch = await admin.inject({ method: "POST", url: `/api/admin/sources/${sourceId}/fetch`, headers });
    assert.equal(fetch.statusCode, 200, fetch.body);
    await waitFor("duplicate collection settled", () => settled(QUEUES.fetchSource, 1));
    assert.equal(fixture.feedRequests.length, 2);
    assert.equal(fixture.calls.length, modelCalls, "unchanged source bytes do not cause another paid request");
    assert.equal((await sql`SELECT count(*)::int AS n FROM articles WHERE source_id=${sourceId}`)[0].n, 3);
    assert.equal((await sql`SELECT count(*)::int AS n FROM articles WHERE source_id=${sourceId} AND revision<>1`)[0].n, 0);
    const [beforeNarrowing] = await sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name=${QUEUES.republishSource} AND state='completed'`;
    await editSource({ site_fulltext: false });
    await waitFor("permission republish worker settled", () => settled(QUEUES.republishSource, beforeNarrowing.n));
    const counts = async () =>
      (
        await sql`SELECT (SELECT count(*) FROM receipts)::int AS receipts,
      (SELECT count(*) FROM fetch_runs)::int AS fetches, (SELECT count(*) FROM pgboss.job)::int AS jobs,
      (SELECT count(*) FROM analyses)::int AS analyses`
      )[0];
    const beforeRead = await counts();
    for (let i = 0; i < 2; i++) {
      const detail = await reader.inject(`/api/site/items/${ids.get("AUTO_PASS")}`);
      assert.equal(detail.statusCode, 200, detail.body);
      assert.equal(detail.json().body, null, "current source permission is honored");
      assert.equal(detail.json().summary, authoredSummary("AUTO_PASS"));
      assert.equal((await reader.inject("/api/site/pool")).statusCode, 200);
    }
    assert.deepEqual(await counts(), beforeRead, "public reads do not collect, model, enqueue or write analyses");
    assert.equal(fixture.calls.length, modelCalls);
    assert.equal(fixture.feedRequests.length, 2);
    t.diagnostic(
      JSON.stringify({
        sourceFetches: fixture.feedRequests.length,
        fakeModelCalls: modelCalls,
        materials: materials.length,
        publicItems: 1,
        blockedOrUnknownItems: 2,
        realModelCalls: 0,
      }),
    );
  }
});
