// Business lines (ADR-0016, TASK-0093): material collected from a policy source is stored like any other, but no
// news stage takes it up. The one way into processing settles it as skipped, so neither the safety-net sweep nor
// the alerts about new content count it; the republish after a metadata change, the interval tuning, the heat
// clocks and the about page leave policy sources out. News sources behave exactly as before.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@amp/backend/config";
import { closeDb, dbOf } from "@amp/backend/db";
import { getBoss, QUEUES, stopBoss } from "@amp/backend/jobs/queue";
import { queueProcessing, sweepUnprocessed } from "@amp/backend/jobs/content";
import { upsertMaterial } from "@amp/backend/content/materials";
import { checkAlerts, collectFindings } from "@amp/backend/operations/alerts";
import { loadSiteStats } from "@amp/backend/site/stats";
import { adaptIntervals, collectSource } from "@amp/backend/sources/collect";
import { sourceClocks } from "@amp/backend/events/hot";
import { grantDateFixture } from "./source-date-fixture.ts";

const sql = dbOf("content");
const T = tag();
const NEWS = `test-lane-news-${T}`;
const POLICY = `test-lane-policy-${T}`;
const BODY = "合成的官方文书正文，用于检验法规线的材料不进资讯处理，内容足够长，足够长，足够长。";

// Each listing names two items; the date printed for the first one can be changed between fetches.
let firstDay = "2026-09-01";
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  const m = /^\/(news|policy)\/list$/.exec(req.url ?? "");
  if (m) {
    const line = m[1]!;
    return res.end(
      `<ul><li><a href="/${line}/a/1">${line} 一号 ${T}</a><span>${firstDay}</span></li>` +
        `<li><a href="/${line}/a/2">${line} 二号 ${T}</a><span>2026-09-02</span></li></ul>`,
    );
  }
  res.end(`<html><body><h1>文书</h1><p>${BODY}</p></body></html>`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;

const listing = (line: string) => ({
  url: `${base}/${line}/list`,
  language: "zh-CN",
  itemSelector: "li",
  linkSelector: "a[href]",
  publishedAtRegex: "<span>(\\d{4}-\\d{2}-\\d{2})</span>",
});
before(async () => {
  await getBoss(); // the alerts read the job tables
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, site_fulltext, next_fetch_at) VALUES
    (${NEWS}, '资讯线信源', 'web_list', ${sql.json(listing("news"))}, 'T1', 'editorial', true, '2100-01-01')`;
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, site_fulltext, next_fetch_at, lane, interval_minutes) VALUES
    (${POLICY}, '法规线信源', 'web_list', ${sql.json(listing("policy"))}, 'T1', 'editorial', true, '2100-01-01', 'policy', 360)`;
  for (const id of [NEWS, POLICY]) await grantDateFixture(id, [base]);
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopBoss();
  await closeDb();
});

const articleIds = async (sourceId: string) =>
  (await sql<{ id: string }[]>`SELECT id FROM articles WHERE source_id = ${sourceId} ORDER BY url`).map((r) => r.id);
const jobsFor = async (ids: string[]) =>
  (await sql<{ name: string }[]>`SELECT name FROM pgboss.job WHERE data->>'articleId' = ANY(${ids}) ORDER BY name`).map((r) => r.name);
const states = async (ids: string[]) =>
  (await sql<{ processing_state: string }[]>`SELECT processing_state FROM articles WHERE id = ANY(${ids})`).map((r) => r.processing_state);
const republishes = async (sourceId: string) =>
  (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pgboss.job WHERE name = ${QUEUES.republishSource} AND data->>'sourceId' = ${sourceId}`)[0]!.n;

test("existing sources are on the news line and a line is one of two values", async () => {
  assert.equal((await sql<{ lane: string }[]>`SELECT lane FROM sources WHERE id = ${NEWS}`)[0]!.lane, "news");
  await assert.rejects(sql`UPDATE sources SET lane = 'other' WHERE id = ${NEWS}`, /check/i);
});

test("material of a policy source is stored and settled as skipped, never queued for news processing or republished", async () => {
  assert.equal((await collectSource(POLICY, { force: true })).status, "ok");
  assert.equal((await collectSource(NEWS, { force: true })).status, "ok");
  const policy = await articleIds(POLICY);
  const news = await articleIds(NEWS);
  assert.equal(policy.length, 2, "the policy material is in the material store");
  assert.equal(news.length, 2);
  assert.deepEqual(await jobsFor(policy), [], "no extraction, analysis or grouping job for policy material");
  assert.deepEqual(await states(policy), ["skipped", "skipped"], "settled at once, like a post of a non-editorial source");
  assert.deepEqual(await jobsFor(news), [QUEUES.extractBody, QUEUES.extractBody], "news material goes to processing as before");
  assert.equal(await queueProcessing(policy[0]!), null, "the one way into processing refuses policy material");
  assert.deepEqual(await jobsFor(policy), []);
  assert.deepEqual(await states(policy), ["skipped", "skipped"]);
  assert.equal((await sql`SELECT 1 FROM publications WHERE article_id = ANY(${policy})`).length, 0, "nothing is published");

  // A changed source date is a metadata change: the news source is republished, the policy source is not.
  firstDay = "2026-09-03";
  assert.equal((await collectSource(POLICY, { force: true })).status, "ok");
  assert.equal((await collectSource(NEWS, { force: true })).status, "ok");
  assert.equal(await republishes(POLICY), 0, "no news republish for a policy source");
  assert.equal(await republishes(NEWS), 1);
  assert.deepEqual(await jobsFor(policy), []);
});

test("the safety-net sweep and the alerts about new content count news material only", async () => {
  process.env.COLLECT_ENABLED = "true";
  process.env.MODEL_CALLS_ENABLED = "true";
  await sql`DELETE FROM settings WHERE key = 'heartbeat.worker'`;
  const findings = async () => (await collectFindings()).map((f) => f.key);
  // Twenty documents of each line written three hours ago that no queue took (a crash between the write and the enqueue).
  const waiting = async (sourceId: string) => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i++)
      ids.push(
        (
          await upsertMaterial({
            sourceId,
            url: `${base}/${sourceId}/w/${i}`,
            title: `等待 ${i} ${T}`,
            language: "zh-CN",
            bodyStatus: "none",
            via: "fetch",
          } as never)
        ).articleId,
      );
    await sql`UPDATE articles SET created_at = now() - interval '3 hours', discovered_at = now() - interval '3 hours',
      processing_state = 'new', processing_queued_at = NULL WHERE id = ANY(${ids})`;
    return ids;
  };
  const policy = await waiting(POLICY);
  await sweepUnprocessed();
  assert.deepEqual(await jobsFor(policy), [], "the sweep queues no news step for policy material");
  assert.deepEqual(new Set(await states(policy)), new Set(["skipped"]), "it settles the policy material as skipped instead");
  assert.ok(!(await findings()).includes("content.process"), "settled policy material is not new content stuck");
  const news = await waiting(NEWS);
  assert.ok((await findings()).includes("content.process"), "the same backlog on the news line is reported as before");
  await sweepUnprocessed();
  assert.equal((await jobsFor(news)).length, 20, "the sweep requeues waiting news material");

  // News first-discovery silence is reported even while a policy source keeps bringing documents.
  await sql`UPDATE articles SET discovered_at = now() - interval '7 hours' WHERE source_id = ${NEWS}`;
  await sql`UPDATE articles SET discovered_at = now() WHERE id = ${policy[0]!}`;
  assert.ok((await findings()).includes("content.collect"), "policy documents do not hide a quiet news line");
});

test("news intake recovery requires a new news arrival, not a new policy document", async () => {
  process.env.COLLECT_ENABLED = "true";
  await sql`DELETE FROM settings WHERE key IN ('heartbeat.worker', 'alerts.state')`;
  await sql`UPDATE articles SET discovered_at = now() - interval '7 hours' WHERE source_id = ${NEWS}`;
  const now = Date.now();
  const opened = await checkAlerts(now);
  assert.ok(opened.open.includes("content.collect"));
  await sql`UPDATE articles SET discovered_at = now() WHERE source_id = ${POLICY}`;
  const stillQuiet = await checkAlerts(now + 60_000);
  assert.ok(stillQuiet.open.includes("content.collect"));
  assert.ok(!stillQuiet.sent.includes("content.collect:recovered"));
  await sql`UPDATE articles SET discovered_at = now() WHERE source_id = ${NEWS}`;
  const recovered = await checkAlerts(now + 120_000);
  assert.ok(recovered.sent.includes("content.collect:recovered"));
  assert.ok(!recovered.open.includes("content.collect"));
});

test("the about page counts news sources only", async () => {
  const enabled = async (lane: string) => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sources WHERE enabled AND lane = ${lane}`)[0]!.n;
  assert.ok((await enabled("policy")) >= 1, "the policy source is enabled");
  const stats = await loadSiteStats();
  assert.equal(stats.sources, await enabled("news"), "the reader sees the news sources, not documents it cannot read yet");
  const [webList] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sources WHERE enabled AND lane = 'news' AND kind = 'web_list'`;
  assert.equal(stats.sourceKinds.web_list ?? 0, webList!.n);
});

test("interval tuning and the heat clocks only count news sources", async () => {
  await adaptIntervals();
  const interval = async (id: string) =>
    (await sql<{ interval_minutes: number }[]>`SELECT interval_minutes FROM sources WHERE id = ${id}`)[0]!.interval_minutes;
  assert.equal(await interval(POLICY), 360, "a policy source keeps the interval it was created with");
  assert.equal(await interval(NEWS), 60, "a quiet news source is slowed to the hourly maximum, as before");
  const clocks = (await sourceClocks()).map((c) => c.id);
  assert.ok(clocks.includes(NEWS));
  assert.ok(!clocks.includes(POLICY), "a slow policy source does not make the heat evidence look incomplete");
});
