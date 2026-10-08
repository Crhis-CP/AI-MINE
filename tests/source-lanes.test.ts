// Business lines (ADR-0016, TASK-0093): material collected from a policy source is stored like any other, but no
// news stage takes it up: not the processing queue, the safety-net sweep, the requeue of failures, the republish
// after a metadata change, the interval tuning or the heat clocks. News sources behave exactly as before.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@amp/backend/config";
import { closeDb, dbOf } from "@amp/backend/db";
import { QUEUES, stopBoss } from "@amp/backend/jobs/queue";
import { queueProcessing, requeueFailed, sweepUnprocessed } from "@amp/backend/jobs/content";
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
const republishes = async (sourceId: string) =>
  (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pgboss.job WHERE name = ${QUEUES.republishSource} AND data->>'sourceId' = ${sourceId}`)[0]!.n;

test("existing sources are on the news line and a line is one of two values", async () => {
  assert.equal((await sql<{ lane: string }[]>`SELECT lane FROM sources WHERE id = ${NEWS}`)[0]!.lane, "news");
  await assert.rejects(sql`UPDATE sources SET lane = 'other' WHERE id = ${NEWS}`, /check/i);
});

test("material of a policy source is stored, but never queued for news processing or republished", async () => {
  assert.equal((await collectSource(POLICY, { force: true })).status, "ok");
  assert.equal((await collectSource(NEWS, { force: true })).status, "ok");
  const policy = await articleIds(POLICY);
  const news = await articleIds(NEWS);
  assert.equal(policy.length, 2, "the policy material is in the material store");
  assert.equal(news.length, 2);
  assert.deepEqual(await jobsFor(policy), [], "no extraction, analysis or grouping job for policy material");
  assert.deepEqual(await jobsFor(news), [QUEUES.extractBody, QUEUES.extractBody], "news material goes to processing as before");
  assert.equal(await queueProcessing(policy[0]!), null, "the one way into processing refuses policy material");
  assert.deepEqual(await jobsFor(policy), []);
  assert.equal((await sql`SELECT 1 FROM publications WHERE article_id = ANY(${policy})`).length, 0, "nothing is published");

  // A changed source date is a metadata change: the news source is republished, the policy source is not.
  firstDay = "2026-09-03";
  assert.equal((await collectSource(POLICY, { force: true })).status, "ok");
  assert.equal((await collectSource(NEWS, { force: true })).status, "ok");
  assert.equal(await republishes(POLICY), 0, "no news republish for a policy source");
  assert.equal(await republishes(NEWS), 1);
  assert.deepEqual(await jobsFor(policy), []);
});

test("the safety-net sweep and the requeue of failures only take news material", async () => {
  const policy = await articleIds(POLICY);
  const news = await articleIds(NEWS);
  await sql`DELETE FROM pgboss.job WHERE data->>'articleId' = ANY(${[...policy, ...news]})`;
  // Old enough for the sweep, and not held by any queue.
  await sql`UPDATE articles SET created_at = now() - interval '1 hour', processing_queued_at = NULL WHERE id = ANY(${[...policy, ...news]})`;
  await sweepUnprocessed();
  assert.deepEqual(await jobsFor(policy), [], "the sweep leaves policy material alone");
  assert.equal((await jobsFor(news)).length, 2, "the sweep requeues waiting news material");

  await sql`DELETE FROM pgboss.job WHERE data->>'articleId' = ANY(${[...policy, ...news]})`;
  await sql`UPDATE articles SET processing_state = 'failed', processing_error = 'synthetic failure' WHERE id = ANY(${[policy[0]!, news[0]!]})`;
  await requeueFailed(null);
  const state = async (id: string) => (await sql<{ processing_state: string }[]>`SELECT processing_state FROM articles WHERE id = ${id}`)[0]!.processing_state;
  assert.equal(await state(policy[0]!), "failed", "a failed policy material is not put back into news processing");
  assert.equal(await state(news[0]!), "new");
  assert.deepEqual(await jobsFor([policy[0]!]), []);
  assert.equal((await jobsFor([news[0]!])).length, 1);
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
