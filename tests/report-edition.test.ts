import { confirmGroupingFixture } from "./grouping-fixture.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { stub } from "./setup.ts";
import { sql, closeDb } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { stopBoss } from "@amp/backend/jobs/queue";
import { composeDaily } from "@amp/backend/reports/compose";
import { loadReport } from "@amp/backend/publication/reports";
import { dailyMemory, periodEntries } from "../packages/backend/src/reports/edition.ts";

const provider = await stub(() => {
  throw new Error("Rule daily must not call a model");
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "synthetic-key";
before(async () => {
  for (const id of ["official", "press-a", "press-b", "press-c"])
    await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES(${id},${id},'rss',${id === "official" ? "T1" : "T2"},'editorial')`;
});
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});
async function story() {
  const [s] = await sql`INSERT INTO stories(public_id,title) VALUES(${randomUUID()},'合成矿山扩建') RETURNING id`;
  const facts = [];
  for (const title of ["扩建获批", "施工启动"])
    facts.push((await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${randomUUID()},${s!.id},${title}) RETURNING id,public_id`)[0]!);
  return { id: Number(s!.id), facts };
}
async function report(source: string, date: string, title: string, fact?: { id: number; public_id: string }, storyId?: number, selected = true) {
  const at = new Date(`${date}T12:00:00Z`),
    url = `https://example.invalid/${randomUUID()}`;
  const { articleId } = await upsertMaterial({
    sourceId: source,
    url,
    title,
    bodyText: "只用于离线验证的矿山扩建材料。",
    language: "zh",
    bodyStatus: "ok",
    publishedAt: at,
    discoveredAt: at,
    via: "fetch",
  });
  await sql`INSERT INTO publications(article_id,title,summary,source_id,channel,url,discovered_at,published_at,timeline_at,sort_at,visible_after,selected,eligible,category,score,first_party,representative_priority,fact_id,story_id)
    VALUES(${articleId},${title},${`${title}的已核实摘要`},${source},'news',${url},${at},${at},${at},${at},${at},${selected},true,'company_project',80,${source === "official"},${source === "official" ? 0 : 3},${fact?.id ?? null},${storyId ?? null})`;
  if (fact) await sql`INSERT INTO fact_articles(article_id,fact_id,role) VALUES(${articleId},${fact.id},'report')`;
  if (selected) await confirmGroupingFixture(articleId);
  return articleId;
}
test("daily folds new facts of one event, chooses authority and publishes a rule lead without any model", async () => {
  const event = await story();
  const lead = await report("official", "2020-09-01", "矿山扩建获批", event.facts[0] as never, event.id);
  await report("press-a", "2020-09-01", "同一次扩建获批的转载", event.facts[0] as never, event.id);
  await report("press-b", "2020-09-01", "另一来源报道扩建获批", event.facts[0] as never, event.id, false);
  const related = await report("press-c", "2020-09-01", "矿山扩建启动施工", event.facts[1] as never, event.id);
  assert.deepEqual(await composeDaily("2020-09-02"), { key: "2020-09-02", entries: 1 });
  const view = (await loadReport("daily", "2020-09-02"))!;
  assert.equal(view.leadItemId, lead);
  assert.equal(view.lead!.title, "矿山扩建获批");
  assert.equal(view.stories.length, 1);
  assert.equal(view.stories[0]!.sources, 4);
  assert.equal(view.stories[0]!.related?.[0]?.itemId, related);
  assert.equal(view.stories[0]!.related?.[0]?.available, true);
  assert.equal(provider.hits(), 0);
  const memory = await dailyMemory("2020-09-03");
  assert.ok(memory.keys.has(`a:${related}`));
  assert.ok(memory.keys.has(String(event.facts[1]!.public_id)));
  const duplicate = await report("press-a", "2020-09-02", "第二天重复扩建消息", event.facts[1] as never, event.id);
  await composeDaily("2020-09-03");
  const repeated = (await loadReport("daily", "2020-09-03"))!;
  assert.equal(repeated.stories.length, 0);
  assert.equal(repeated.flashes.length, 0);
  assert.ok(!repeated.highlights.some((entry) => entry.itemId === duplicate));
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${related}`;
  const withdrawn = (await loadReport("daily", "2020-09-02"))!;
  assert.equal(withdrawn.stories[0]!.related?.[0]?.available, false);
  assert.equal(withdrawn.stories[0]!.related?.[0]?.sourceUrl, "");
  assert.equal(withdrawn.lead, null);
});
test("weekly candidates come only from daily main entries and resolve current public wording", async () => {
  const main = await report("official", "2020-10-01", "日报已刊的扩建消息");
  const flash = await report("press-a", "2020-10-01", "日报简讯");
  await report("press-b", "2020-10-01", "原始精选但未进日报");
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at,origin) VALUES('daily','2020-10-02','2020-10-01','2020-10-02',${sql.json({ leadItemId: main, sections: [{ label: "企业与项目", items: [{ itemId: main, sources: 3 }] }], flashes: [{ itemId: flash }] })},now(),'model')`;
  await sql`UPDATE publications SET title='更正后的扩建消息' WHERE article_id=${main}`;
  const period = await periodEntries("2020-10-01", "2020-10-07");
  assert.equal(period.issues, 1);
  assert.deepEqual(
    period.entries.map((entry) => entry.itemId),
    [main],
  );
  assert.equal(period.entries[0]!.title, "更正后的扩建消息");
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${main}`;
  assert.deepEqual((await periodEntries("2020-10-01", "2020-10-07")).entries, []);
});

test("missed official news needs three current independent participants; moved, unconfirmed and isolated evidence cannot qualify", async () => {
  const { dailyEdition } = await import("../packages/backend/src/reports/edition.ts");
  const { confirmGroupingFixture } = await import("./grouping-fixture.ts");
  const event = await story(),
    date = "2020-11-01";
  const ids = [];
  for (const source of ["official", "press-a", "press-b"]) {
    const id = await report(source, date, `合成未精选扩建 ${source}`, event.facts[0] as never, event.id, false);
    ids.push(id);
    await confirmGroupingFixture(id);
    await sql`UPDATE fact_articles SET input_revision=1 WHERE article_id=${id}`;
    await sql`INSERT INTO story_signals(story_id,article_id,participant_key,source_id,kind,observed_at) VALUES(${event.id},${id},${`old:${source}`},${source},'editorial','2020-11-01T12:00Z')`;
  }
  const edition = () => dailyEdition("2020-11-02", new Date("2020-11-01T00:00Z"), new Date("2020-11-02T00:00Z"));
  assert.equal((await edition()).entries[0]!.entry.fillIn, true);
  await sql`UPDATE sources SET owner_entity_id='same-owner' WHERE id IN ('press-a','press-b')`;
  assert.equal((await edition()).entries.length, 0, "multiple entries owned by one participant cannot raise coverage");
  await sql`UPDATE sources SET owner_entity_id=NULL WHERE id IN ('press-a','press-b')`;
  await sql`UPDATE sources SET participation_mode='isolated' WHERE id='press-b'`;
  assert.equal((await edition()).entries.length, 0);
  await sql`UPDATE sources SET participation_mode='editorial' WHERE id='press-b'`;
  await sql`UPDATE articles SET grouping_status='pending' WHERE id=${ids[2]!}`;
  assert.equal((await edition()).entries.length, 0);
  await confirmGroupingFixture(ids[2]!);
  await sql`UPDATE publications SET selected=true,visible_after='2020-11-02T00:01Z' WHERE article_id=${ids[2]!}`;
  assert.equal((await edition()).entries.length, 0, "selection after cutoff must wait for the next issue");
  await sql`UPDATE publications SET selected=false WHERE article_id=${ids[2]!}`;
  await sql`UPDATE fact_articles SET fact_id=${event.facts[1]!.id} WHERE article_id=${ids[2]!}`;
  assert.equal((await edition()).entries.length, 0, "an old signal cannot remain attached to its former fact");
});

test("confirmed discussion signals contribute attention without becoming report facts or bypassing an explicit withdrawal", async () => {
  const { reportEventEvidence } = await import("../packages/backend/src/events/report-context.ts");
  const { confirmGroupingFixture } = await import("./grouping-fixture.ts");
  const event = await story();
  await sql`INSERT INTO sources(id,name,kind,participation_mode) VALUES('discussion-source','合成讨论来源','rss','hot_signal')`;
  const { articleId } = await upsertMaterial({
    sourceId: "discussion-source",
    url: "https://example.invalid/discussion",
    title: "合成矿山事件的讨论",
    publishedAt: new Date("2020-12-01T12:00Z"),
    discoveredAt: new Date("2020-12-01T12:00Z"),
    via: "fetch",
  });
  await confirmGroupingFixture(articleId);
  await sql`INSERT INTO story_signals(story_id,article_id,participant_key,source_id,kind,observed_at) VALUES(${event.id},${articleId},'old-key','discussion-source','signal','2020-12-01T12:00Z')`;
  const read = () => reportEventEvidence([event.id], [], new Date("2020-12-02T00:00Z"));
  const value = await read();
  assert.equal(value.signals.length, 1);
  assert.equal(value.signals[0]!.fact_id, null);
  assert.equal(value.signals[0]!.kind, "signal");
  await sql`INSERT INTO editorial_overrides(article_id,visibility,fields) VALUES(${articleId},'withdrawn','{}')`;
  assert.equal((await read()).signals.length, 0);
});

test("a quiet report waits when a nominated public article is still awaiting grouping", async () => {
  const id = await report("official", "2020-12-10", "合成待确认的高分候选");
  await sql`UPDATE articles SET grouping_status='pending' WHERE id=${id}`;
  await sql`UPDATE publications SET selected=false,selection_candidate=true WHERE article_id=${id}`;
  await composeDaily("2020-12-11");
  assert.equal(await loadReport("daily", "2020-12-11"), null);
  await confirmGroupingFixture(id);
  await sql`UPDATE articles SET selection_adds_value=false WHERE id=${id}`;
  await composeDaily("2020-12-11");
  assert.equal((await loadReport("daily", "2020-12-11"))!.lead!.title, "今日无大事发生");
});
