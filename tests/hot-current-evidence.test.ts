import "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql, closeDb } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { computeHotRanking } from "@amp/backend/events/hot";
import { stopBoss } from "@amp/backend/jobs/queue";
import { confirmGroupingFixture } from "./grouping-fixture.ts";

after(async () => {
  await stopBoss();
  await closeDb();
});
const now = new Date("2026-10-16T01:00:00Z");
async function fixture() {
  const [story] = await sql`INSERT INTO stories(public_id,title,first_report_at,latest_at) VALUES(${randomUUID()},'合成矿山扩建',${now},${now}) RETURNING id`;
  const [fact] = await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${randomUUID()},${story!.id},'合成扩建获批') RETURNING id`;
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const source = randomUUID(),
      at = new Date(now.getTime() - 3600000),
      url = `https://example.invalid/${source}`;
    await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,created_at,last_ok_at) VALUES(${source},${`合成来源${i}`},'rss','T2','editorial','2020-01-01',${now})`;
    const { articleId } = await upsertMaterial({
      sourceId: source,
      url,
      title: "合成扩建公告",
      bodyText: "合成数据用来验证同一事件的当前有效热度。",
      language: "zh",
      publishedAt: at,
      discoveredAt: at,
      via: "fetch",
    });
    await confirmGroupingFixture(articleId);
    await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${fact!.id},${articleId},'report',1)`;
    await sql`INSERT INTO publications(article_id,title,summary,source_id,channel,url,discovered_at,published_at,timeline_at,sort_at,visible_after,selected,eligible,fact_id,story_id)
      VALUES(${articleId},'合成扩建获批','合成公开摘要',${source},'news',${url},${at},${at},${at},${at},${at},false,true,${fact!.id},${story!.id})`;
    await sql`INSERT INTO story_signals(story_id,article_id,participant_key,source_id,kind,observed_at) VALUES(${story!.id},${articleId},${`source:${source}`},${source},'editorial',${at})`;
    ids.push({ articleId, source });
  }
  return { storyId: Number(story!.id), factId: Number(fact!.id), ids };
}
async function ranking(storyId: number) {
  const result = await computeHotRanking(now);
  const [row] = await sql`SELECT entries FROM hot_rankings WHERE id=${result.id}`;
  return (row!.entries as Array<{ storyId: number; participantCount: number; reportCount: number; trend: string; representativeItemId: string }>).find(
    (entry) => entry.storyId === storyId,
  );
}
for (const change of ["withdrawal", "isolated", "regroup-pending", "standalone"] as const)
  test(`hot ranking drops ${change} evidence before counting independent participants`, async () => {
    const f = await fixture(),
      item = f.ids[1]!;
    assert.equal((await ranking(f.storyId))!.participantCount, 2);
    if (change === "withdrawal") await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${item.articleId}`;
    if (change === "isolated") await sql`UPDATE sources SET participation_mode='isolated' WHERE id=${item.source}`;
    if (change === "regroup-pending") await sql`UPDATE articles SET grouping_status='pending' WHERE id=${item.articleId}`;
    if (change === "standalone") await sql`INSERT INTO grouping_overrides(article_id) VALUES(${item.articleId})`;
    assert.equal(await ranking(f.storyId), undefined, "one remaining independent participant must not keep an event on the hot list");
  });

async function addReport(storyId: number, factId: number, hoursAgo: number, tier = "T2") {
  const source = randomUUID(),
    at = new Date(now.getTime() - hoursAgo * 3600000),
    url = `https://example.invalid/${source}`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,created_at,last_ok_at) VALUES(${source},'合成比较来源','rss',${tier},'editorial','2020-01-01',${now})`;
  const { articleId } = await upsertMaterial({
    sourceId: source,
    url,
    title: "合成比较报道",
    bodyText: "合成对照新闻。",
    language: "zh",
    publishedAt: at,
    discoveredAt: at,
    via: "fetch",
  });
  await confirmGroupingFixture(articleId);
  await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${factId},${articleId},'report',1)`;
  await sql`INSERT INTO publications(article_id,title,summary,source_id,channel,url,discovered_at,published_at,timeline_at,sort_at,visible_after,selected,eligible,fact_id,story_id,representative_priority)
    VALUES(${articleId},'合成比较报道','合成公开摘要',${source},'news',${url},${at},${at},${at},${at},${at},false,true,${factId},${storyId},${tier === "T1" ? 0 : 3})`;
  await sql`INSERT INTO story_signals(story_id,article_id,participant_key,source_id,kind,observed_at) VALUES(${storyId},${articleId},${`source:${source}`},${source},'editorial',${at})`;
  return articleId;
}
test("trend comparison includes attention 48 to 54 hours ago instead of incorrectly calling the event new", async () => {
  const f = await fixture();
  await addReport(f.storyId, f.factId, 50);
  const row = await ranking(f.storyId);
  assert.equal(row!.participantCount, 2);
  assert.equal(row!.trend, "up");
});
test("a single authoritative follow-up cannot replace the most widely reported fact in the hot link", async () => {
  const f = await fixture();
  const [followup] = await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${randomUUID()},${f.storyId},'合成后续说明') RETURNING id`;
  const one = await addReport(f.storyId, Number(followup!.id), 0.5, "T1");
  const row = await ranking(f.storyId);
  assert.notEqual(row!.representativeItemId, one);
  assert.ok(f.ids.some((item) => item.articleId === row!.representativeItemId));
});

test("event details share the published participation snapshot and a withdrawn member invalidates the old board immediately", async () => {
  const { loadStoryDetail, loadHot } = await import("@amp/backend/publication/stories");
  const f = await fixture();
  await computeHotRanking(now);
  assert.equal((await loadStoryDetail(f.storyId, now))!.whyHot.participants48h, 2);
  await sql`UPDATE publications SET visibility='withdrawn',revision=revision+1 WHERE article_id=${f.ids[1]!.articleId}`;
  const [identity] = await sql`SELECT public_id::text AS id FROM stories WHERE id=${f.storyId}`;
  assert.ok(!(await loadHot()).entries.some((entry) => entry.story.publicId === identity!.id));
  const invalid = (await loadStoryDetail(f.storyId, now))!;
  assert.equal(invalid.whyHot.participants48h, 1);
  assert.equal(invalid.whyHot.observationComplete, true);
  assert.equal(invalid.whyHot.rank, null);
  await computeHotRanking(now);
  assert.equal((await loadStoryDetail(f.storyId, now))!.whyHot.participants48h, 1);
});

test("explicit withdrawal of a discussion signal hides its old participation immediately even without a public article page", async () => {
  const { setVisibility } = await import("@amp/backend/admin/content");
  const { loadHot } = await import("@amp/backend/publication/stories");
  const { ensureQueue } = await import("@amp/backend/jobs/queue");
  await ensureQueue("events.hot-refresh");
  const f = await fixture(),
    source = randomUUID(),
    url = `https://example.invalid/${source}`;
  await sql`INSERT INTO sources(id,name,kind,participation_mode,last_ok_at,created_at) VALUES(${source},'合成讨论来源','rss','hot_signal',${now},'2020-01-01')`;
  const { articleId } = await upsertMaterial({
    sourceId: source,
    url,
    title: "合成讨论线索",
    bodyText: "合成讨论线索的原文，不生成公开详情页。",
    language: "zh",
    publishedAt: new Date(now.getTime() - 3600000),
    discoveredAt: new Date(now.getTime() - 3600000),
    via: "fetch",
  });
  await confirmGroupingFixture(articleId);
  await sql`INSERT INTO story_signals(story_id,article_id,participant_key,source_id,kind,observed_at) VALUES(${f.storyId},${articleId},${`source:${source}`},${source},'signal',${new Date(now.getTime() - 3600000)})`;
  assert.equal((await ranking(f.storyId))!.participantCount, 3);
  await setVisibility(articleId, { visibility: "withdrawn", reason: "PRIVATE_SIGNAL_REASON", version: 0 }, "synthetic");
  const [projected] = await sql`SELECT operator_withdrawn FROM publications WHERE article_id=${articleId}`;
  assert.equal(projected!.operator_withdrawn, true);
  const [identity] = await sql`SELECT public_id::text AS id FROM stories WHERE id=${f.storyId}`;
  const view = await loadHot();
  assert.ok(!view.entries.some((entry) => entry.story.publicId === identity!.id));
  assert.ok(!JSON.stringify(view).includes("PRIVATE_SIGNAL_REASON"));
  assert.equal((await ranking(f.storyId))!.participantCount, 2);
});

test("unchanged evidence does not rewrite every observation and charts exclude withdrawn or newly added participants", async () => {
  const { snapshotHeat } = await import("@amp/backend/events/hot");
  const { publicHeatSeries, comparableHeatSeries } = await import("../packages/backend/src/events/participation-read.ts");
  const f = await fixture();
  await computeHotRanking(now);
  const before = await sql`SELECT article_id,qualified_at,xmin::text FROM story_signals WHERE story_id=${f.storyId} ORDER BY article_id`;
  await computeHotRanking(now);
  assert.deepEqual(await sql`SELECT article_id,qualified_at,xmin::text FROM story_signals WHERE story_id=${f.storyId} ORDER BY article_id`, before);
  await snapshotHeat(now);
  const first = await publicHeatSeries(f.storyId, now);
  assert.ok(first.length);
  await sql`UPDATE publications SET visibility='withdrawn',revision=revision+1 WHERE article_id=${f.ids[1]!.articleId}`;
  const reduced = await publicHeatSeries(f.storyId, now);
  assert.equal(reduced.at(-1)!.participants, 1);
  assert.ok(reduced.at(-1)!.heat < first.at(-1)!.heat);
  const hours = [new Date(now.getTime() - 2 * 3600000), new Date(now.getTime() - 3600000), now];
  const base = {
    story_id: f.storyId,
    article_id: "synthetic",
    source_id: "old",
    kind: "editorial" as const,
    qualified_fact_id: f.factId,
    material_revision: 1,
    source_date_version: "0",
    publication_revision: 1,
  };
  const old = { ...base, participant_key: "old", source_since: new Date("2020-01-01"), observed_at: new Date(now.getTime() - 3 * 3600000) };
  const added = { ...base, participant_key: "added", source_since: new Date(now.getTime() - 86400000), observed_at: new Date(now.getTime() - 3600000) };
  assert.deepEqual(
    comparableHeatSeries(hours, [old, added]),
    comparableHeatSeries(hours, [old]),
    "an expanded source set does not masquerade as a rise in the comparable chart",
  );
});

test("publication pause stops a new ranking and resuming allows the same evidence to be processed", async () => {
  const { changeSystemLaneControl, RuntimeControlPaused } = await import("../packages/backend/src/operations/lane-controls.ts");
  const control = { lane: "news" as const, switches: ["publication" as const], reason: "Synthetic publication hold", actor: "synthetic" };
  const [before] = await sql`SELECT count(*)::int AS n FROM hot_rankings`;
  await changeSystemLaneControl({ ...control, action: "pause", expected: { publication: 0 }, expiresAt: new Date(Date.now() + 3600000).toISOString() });
  await assert.rejects(computeHotRanking(now), RuntimeControlPaused);
  assert.equal((await sql`SELECT count(*)::int AS n FROM hot_rankings`)[0]!.n, before!.n);
  await changeSystemLaneControl({ ...control, action: "resume", expected: { publication: 1 } });
  assert.ok((await computeHotRanking(now)).id);
});
