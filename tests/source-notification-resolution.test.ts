import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { getBoss, stopBoss } from "@amp/backend/jobs/queue";
import { sendDigest } from "@amp/backend/operations/alerts";
import { sourceHealthWeekly } from "@amp/backend/operations/reports";
import { mockFeishuAlerts } from "./feishu-alert-fixture.ts";

const day = 86400_000;
before(async () => {
  Object.assign(process.env, { COLLECT_ENABLED: "true", COLLECT_NEWS_ENABLED: "true", JINA_API_KEY: "synthetic-reader" });
  await getBoss();
});
beforeEach(async () => {
  await sql`DELETE FROM settings WHERE key='alerts.state'`;
  await sql`UPDATE sources SET enabled=false`;
});
after(async () => {
  await stopBoss();
  await closeDb();
});
async function source(now: number, health = "ok") {
  const id = `notification-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,lane,enabled,participation_mode,health,created_at,fail_count,last_error)
    VALUES(${id},${id},'rss','news',true,'editorial',${health},${new Date(now - 20 * day)},${health === "failing" ? 5 : 0},${health === "failing" ? "HTTP 503 synthetic" : null})`;
  return id;
}
const state = async () => (await sql`SELECT value FROM settings WHERE key='alerts.state'`)[0]?.value ?? {};

test("Monday summaries do not repeat incident details or consume each other's failed notification", async (t) => {
  const delivery = mockFeishuAlerts(t),
    now = Date.now(),
    id = await source(now, "failing");
  await sql`INSERT INTO job_runs(job,status,started_at,finished_at,detail) VALUES('reports.source-health','ok',${new Date(now - 7 * day)},${new Date(now - 7 * day + 1000)},'{"failing":3,"silent":2,"overdue":1}'::jsonb)`;
  await sendDigest(now);
  const announced = await state();
  await sourceHealthWeekly(now);
  assert.match(delivery.messages[0]!, new RegExp(id));
  assert.ok(!delivery.messages[1]!.includes(id), "weekly overview must not repeat the daily incident's detailed source list");
  assert.match(delivery.messages[1]!, /连续抓取失败：1 个/);
  assert.match(delivery.messages[1]!, /较上次成功运行记录的统计：抓取失败 -2 个/);
  assert.match(delivery.messages[1]!, /逐项问题由系统日报发送，未送达的仍保留待发送/);
  delivery.fail = true;
  await assert.rejects(sourceHealthWeekly(now), /outcome unknown/);
  assert.deepEqual(await state(), announced);
});

test("quality notices distinguish window expiry, observed clearing and an unobserved source mode", async (t) => {
  const delivery = mockFeishuAlerts(t),
    now = Date.now(),
    sentAt = now - 2 * day;
  const expired = await source(now),
    repaired = await source(now),
    unchecked = await source(now);
  for (const [id, age] of [
    [expired, 8],
    [repaired, 3],
    [unchecked, 3],
  ] as const)
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at)
      VALUES(${id},${id},${id},${`https://example.invalid/${id}`},'Synthetic title',${new Date(now - age * day)},${new Date(now - age * day)})`;
  await sendDigest(sentAt);
  const key = (id: string) => `digest:sources.quality.${id}`;
  assert.ok((await state())[key(unchecked)]);
  await sql`UPDATE articles SET published_at=discovered_at WHERE id=${repaired}`;
  await sql`UPDATE sources SET participation_mode='hot_signal' WHERE id=${unchecked}`;
  for (const id of [expired, repaired, unchecked])
    await sql`INSERT INTO fetch_runs(source_id,status,started_at,finished_at,found_count,new_count)
      VALUES(${id},'ok',${new Date(now - 60_000)},${new Date(now - 30_000)},0,0)`;
  delivery.messages.length = 0;
  const result = await sendDigest(now);
  assert.equal(delivery.messages.length, 0, "statistical change alone must not create another owner notification");
  assert.equal(result.items, 0);
  assert.ok("quality_changes" in result);
  assert.ok(result.quality_changes);
  assert.deepEqual(
    result.quality_changes.map((item) => [item.source_id, item.state, item.reviewed]).sort(),
    [
      [expired, "window_expired", false],
      [repaired, "statistics_changed", false],
    ].sort(),
  );
  assert.ok((await state())[key(unchecked)], "stopping quality observation is not recovery");
  assert.equal((await state())[key(expired)], undefined);
  assert.equal((await state())[key(repaired)], undefined);
  await sql`UPDATE sources SET participation_mode='isolated' WHERE id=${unchecked}`;
  await sendDigest(now + 60_000);
  assert.ok((await state())[key(unchecked)]);
});

test("disabled and unknown delivery leave the unique daily incident pending", async (t) => {
  const delivery = mockFeishuAlerts(t),
    now = Date.now(),
    id = await source(now, "failing"),
    key = `digest:sources.failing.${id}`;
  process.env.FEISHU_INTERNAL_ENABLED = "false";
  await sendDigest(now);
  assert.equal((await state())[key], undefined, "disabled delivery is not an announcement");
  process.env.FEISHU_INTERNAL_ENABLED = "true";
  delivery.fail = true;
  await assert.rejects(sendDigest(now + 60_000), /outcome unknown/);
  assert.equal((await state())[key], undefined);
  await assert.rejects(sourceHealthWeekly(now + 60_000), /outcome unknown/);
  delivery.fail = false;
  await sendDigest(now + 120_000);
  assert.ok((await state())[key]);
  assert.equal(delivery.messages.length, 1);
  await sendDigest(now + 180_000);
  assert.equal(delivery.messages.length, 1);
});
