import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, beforeEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { POLICY_SOURCES } from "@amp/industry/policy-sources";
import { config } from "@amp/backend/config";
import { closeDb, dbOf } from "@amp/backend/db";
import { getBoss, stopBoss, enqueue, ensureQueue, QUEUES } from "@amp/backend/jobs/queue";
import { SOURCE_QUEUES, ensureSourceQueues, sourceFetchQueue, type CollectionLane } from "../packages/backend/src/jobs/source-queues.ts";
import { registerSourceJobs } from "@amp/backend/jobs/sources";
import { scheduleDueSources } from "@amp/backend/sources/collect";
import { fetchNow } from "@amp/backend/admin/sources";
import { saveRobots } from "../packages/backend/src/acquisition/pacing.ts";
import { grantDateFixture } from "./source-date-fixture.ts";

const sql = dbOf("sources"),
  hits = new Map<string, number>();
let unblock = () => {};
let slow = Promise.resolve();
const server = http.createServer(async (req, res) => {
  const id = decodeURIComponent((req.url ?? "").slice(1));
  hits.set(id, (hits.get(id) ?? 0) + 1);
  if (id.startsWith("slow-")) await slow;
  res.writeHead(200, { "content-type": "application/rss+xml" });
  res.end(
    `<rss><channel><item><title>合成矿业公告</title><link>http://127.0.0.1:${(server.address() as { port: number }).port}/${id}/article</link></item></channel></rss>`,
  );
});
await new Promise<void>((resolve) => server.listen(0, resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
const queues = [QUEUES.fetchSource, SOURCE_QUEUES.news, SOURCE_QUEUES.policy];
async function until(check: () => Promise<boolean>, label: string) {
  for (let n = 0; n < 120; n++) {
    if (await check()) return;
    await delay(100);
  }
  assert.fail(label);
}
async function source(lane: CollectionLane, id = `${lane}-${tag()}`, permit = true) {
  const origin = lane === "news" ? base.replace("127.0.0.1", "localhost") : base;
  await saveRobots(origin, 404, "", new Date(), null, null);
  await sql`INSERT INTO sources(id,name,kind,config,lane,enabled,participation_mode,next_fetch_at)
    VALUES(${id},${id},'rss',${sql.json({ feedUrl: `${origin}/${id}` })},${lane},true,'isolated',NULL)`;
  if (permit) await grantDateFixture(id, [base, origin]);
  return id;
}
const done = async (id: string) =>
  (await sql`SELECT 1 FROM fetch_runs WHERE source_id=${id} AND finished_at IS NOT NULL AND status IN ('ok','failed')`).length > 0;
beforeEach(async () => {
  unblock();
  await stopBoss();
  for (const lane of ["NEWS", "POLICY"]) {
    process.env[`COLLECT_${lane}_ENABLED`] = "true";
    process.env[`FETCH_${lane}_CONCURRENCY`] = "1";
  }
  await sql`UPDATE sources SET enabled=false`;
  const boss = await getBoss();
  await ensureSourceQueues();
  for (const name of queues) {
    await ensureQueue(name);
    await boss.deleteAllJobs(name);
  }
});
after(async () => {
  unblock();
  await stopBoss();
  await new Promise<void>((r) => server.close(() => r()));
  await closeDb();
});

test("lane batches are independent and policy countries rotate before a second source from one country", async () => {
  const first = POLICY_SOURCES[0]!;
  const same = POLICY_SOURCES.find((s) => s.jurisdiction === first.jurisdiction && s.id !== first.id)!;
  const other = POLICY_SOURCES.find((s) => s.jurisdiction !== first.jurisdiction)!;
  const ids = await Promise.all([first, same, other].map((s) => source("policy", `policy-${s.id.toLowerCase()}`)));
  await sql`UPDATE sources SET next_fetch_at='2020-01-01' WHERE id IN ${sql(ids.slice(0, 2))}`;
  await sql`UPDATE sources SET next_fetch_at='2021-01-01' WHERE id=${ids[2]!}`;
  const news = await source("news");
  assert.equal((await scheduleDueSources(2, "policy")).enqueued, 2);
  assert.equal((await scheduleDueSources(1, "news")).enqueued, 1);
  const scheduled = await sql`SELECT data FROM pgboss.job WHERE name=${SOURCE_QUEUES.policy}`;
  assert.ok(scheduled.some((r) => r.data.sourceId === ids[2]));
  assert.equal(scheduled.filter((r) => ids.slice(0, 2).includes(r.data.sourceId)).length, 1);
  assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE name=${SOURCE_QUEUES.news} AND data->>'sourceId'=${news}`).length, 1);
  assert.equal((await scheduleDueSources(2, "policy")).enqueued, 1);
});

test("a blocked news host cannot occupy a different policy host capacity; old, scheduled and manual work share a source singleton", async () => {
  slow = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const news = await source("news", `slow-${tag()}`),
    policy = await source("policy");
  await enqueue(SOURCE_QUEUES.news, { sourceId: news, lane: "news" }, { singletonKey: news });
  const boss = await getBoss();
  await registerSourceJobs(boss);
  try {
    await until(async () => hits.has(news), "news fetch started");
    const legacy = await enqueue(QUEUES.fetchSource, { sourceId: news, force: true }, { singletonKey: `manual:${news}` });
    assert.equal((await fetchNow(news, "test"))!.jobId, null, "active source does not get a second fetch");
    await enqueue(SOURCE_QUEUES.policy, { sourceId: policy, lane: "policy" }, { singletonKey: policy });
    await until(() => done(policy), "policy completes while news HTTP remains blocked");
    await until(async () => (await boss.getJobById(QUEUES.fetchSource, legacy!))?.state === "completed", "legacy forwarding commits");
    assert.equal(await done(news), false);
    assert.equal(hits.get(news), 1);
    assert.equal((await sql`SELECT new_count FROM fetch_runs WHERE source_id=${policy} AND status='ok'`)[0]!.new_count, 1);
  } finally {
    unblock();
  }
  await until(() => done(news), "news resumes");
  assert.equal(hits.get(news), 1);
});

test("pausing news leaves its legacy work queued while policy proceeds, then resumes it once", async () => {
  const news = await source("news"),
    policy = await source("policy");
  process.env.COLLECT_NEWS_ENABLED = "false";
  assert.equal((await scheduleDueSources(1, "news")).enqueued, 0);
  const legacy = await enqueue(QUEUES.fetchSource, { sourceId: news, force: true }, { singletonKey: news });
  let boss = await getBoss();
  await registerSourceJobs(boss);
  await scheduleDueSources(1, "policy");
  await until(() => done(policy), "policy unaffected by news pause");
  await until(async () => (await boss.getJobById(QUEUES.fetchSource, legacy!))?.state === "completed", "paused legacy task is safely forwarded");
  assert.equal(hits.has(news), false);
  const [pending] = await sql`SELECT state,data FROM pgboss.job WHERE name=${SOURCE_QUEUES.news} AND data->>'sourceId'=${news}`;
  assert.equal(pending!.state, "created");
  assert.equal(pending!.data.force, true);
  await stopBoss();
  process.env.COLLECT_NEWS_ENABLED = "true";
  boss = await getBoss();
  await registerSourceJobs(boss);
  await until(() => done(news), "news resumes queued work");
  assert.equal(hits.get(news), 1);
});

test("source pauses and missing permissions still stop requests after lane dispatch", async () => {
  const paused = await source("policy"),
    denied = await source("news", `denied-${tag()}`, false);
  await sql`UPDATE sources SET enabled=false WHERE id=${paused}`;
  const boss = await getBoss();
  await registerSourceJobs(boss);
  const id = await enqueue(sourceFetchQueue("policy"), { sourceId: paused, lane: "policy" }, { singletonKey: paused });
  await enqueue(sourceFetchQueue("news"), { sourceId: denied, lane: "news" }, { singletonKey: denied });
  await until(() => done(denied), "missing permission fails without fetch");
  await until(async () => (await boss.getJobById(SOURCE_QUEUES.policy, id!))?.state === "completed", "paused source is skipped");
  assert.equal(hits.has(paused), false);
  assert.equal(hits.has(denied), false);
  assert.equal((await sql`SELECT status FROM fetch_runs WHERE source_id=${denied}`)[0]!.status, "failed");
});
