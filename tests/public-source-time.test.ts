import "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql, closeDb } from "@amp/backend/db";
import { upsertMaterial, updateMaterialSourceDate } from "@amp/backend/content/materials";
import { publishArticle } from "@amp/backend/publication/publish";
import { loadItemDetail, publicItemMetadata } from "@amp/backend/publication/detail";
import { v3Item } from "../packages/backend/src/publication/v3.ts";
import { stopBoss } from "@amp/backend/jobs/queue";
import { readSourceDateContext } from "@amp/backend/admin/sources";
import { observeSourceDate } from "../packages/backend/src/sources/date-extraction.ts";
import { grantDateFixture } from "./source-date-fixture.ts";
import { beijingDate } from "@amp/contracts/time";

after(async () => {
  await stopBoss();
  await closeDb();
});
async function fixture(raw?: string) {
  const sourceId = `public-time-${randomUUID()}`,
    url = `https://example.invalid/${sourceId}`,
    at = new Date();
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,config,site_fulltext) VALUES(${sourceId},'合成日期来源','rss','T1','editorial','{}',true)`;
  await grantDateFixture(sourceId, [url]);
  const context = (await readSourceDateContext(sourceId))!;
  const input = {
    sourceId,
    url,
    title: "矿山扩建公告",
    bodyText: "合成矿山扩建公告正文，提供明确的原文日期，用于独立验证公开时间，不访问真实模型。",
    language: "zh",
    bodyStatus: "ok" as const,
    via: "fetch" as const,
    discoveredAt: at,
  };
  const observation = raw ? { ...observeSourceDate(context, url, raw, "rss.pubDate"), basis: "PRIVATE_DATE_CONFIGURATION" } : undefined;
  const material = await upsertMaterial({
    ...input,
    ...(observation ? { sourceDateObservation: observation, permissionVersion: 1, expectedSourceDateVersion: 0 } : {}),
  });
  await publishArticle(material.articleId);
  return { ...material, input, context, observation, at };
}
test("a calendar day is published without inventing UTC midnight, with a separate first-public time", async () => {
  const day = beijingDate(new Date()),
    f = await fixture(day),
    result = await loadItemDetail(f.articleId);
  assert.equal(result.kind, "found");
  if (result.kind !== "found") return;
  assert.equal(result.detail.sourceTime!.precision, "date");
  assert.equal(result.detail.sourceTime!.local_date, day);
  assert.equal(result.detail.sourceTime!.utc, null);
  assert.equal(result.detail.publishedAt, null);
  assert.ok(result.detail.firstPublicAt);
  assert.ok(!JSON.stringify(result.detail.sourceTime).includes("PRIVATE_DATE_CONFIGURATION"));
  const machine = await v3Item(f.articleId);
  assert.equal(machine!.published_time.precision, "date");
  assert.equal(machine!.published_time.utc, null);
});
test("an explicitly stated midnight retains its real instant and second precision", async () => {
  const raw = `${beijingDate(new Date())}T00:00:00+08:00`,
    f = await fixture(raw),
    result = await loadItemDetail(f.articleId);
  assert.equal(result.kind, "found");
  if (result.kind !== "found") return;
  assert.equal(result.detail.sourceTime!.precision, "second");
  assert.equal(result.detail.publishedAt, new Date(raw).toISOString());
  assert.match(result.detail.sourceTime!.label, /00:00/);
  assert.notEqual(result.detail.firstPublicAt, result.detail.publishedAt);
});
test("a changed body or source configuration cannot reuse an older time assertion", async () => {
  const f = await fixture(beijingDate(new Date()));
  assert.ok((await publicItemMetadata(f.articleId))!.source_time);
  const updated = await upsertMaterial({ ...f.input, bodyText: f.input.bodyText + " 这是经过修订的正文。" });
  assert.equal(updated.revision, 2);
  assert.equal((await publicItemMetadata(f.articleId))!.source_time, null);
  await publishArticle(f.articleId);
  assert.equal((await publicItemMetadata(f.articleId))!.source_time, null);
  await updateMaterialSourceDate(f.articleId, 2, {
    sourceDateObservation: { ...f.observation!, observedAt: new Date().toISOString(), observationId: randomUUID() },
    permissionVersion: 1,
    expectedSourceDateVersion: 1,
  });
  await publishArticle(f.articleId);
  assert.ok((await publicItemMetadata(f.articleId))!.source_time);
  await sql`UPDATE sources SET source_date_config_hash=${"f".repeat(64)} WHERE id=${f.input.sourceId}`;
  assert.equal((await publicItemMetadata(f.articleId))!.source_time, null);
});
test("unknown legacy dates do not become a confirmed source timestamp when the projection is rebuilt", async () => {
  const f = await fixture();
  const [projection] = await sql`SELECT source_time,source_time_material_revision FROM publications WHERE article_id=${f.articleId}`;
  assert.equal(projection!.source_time, null);
  assert.equal(projection!.source_time_material_revision, 1);
  assert.equal((await publicItemMetadata(f.articleId))!.source_time, null);
});

test("RSS and both API generations preserve date precision; historical sync never replays withdrawn or corrected copy", async () => {
  const { selectedSnapshot, selectedChanges, v1Items } = await import("@amp/backend/publication/v1");
  const { itemFeed } = await import("@amp/backend/publication/feeds");
  const { scopeVersion, scopeOutput, scopeReceipt } = await import("./scope-fixture.ts");
  const { confirmGroupingFixture } = await import("./grouping-fixture.ts");
  const { confirmedManualEdit } = await import("./confirmed-manual-fixture.ts");
  const { setVisibility } = await import("@amp/backend/admin/content");
  const empty = await selectedSnapshot({ limit: 1000, page: null });
  const f = await fixture(beijingDate(new Date()));
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected,prompt_version,receipt_ids,output)
    VALUES(${f.articleId},1,'rule','pass','company_project','合成矿山扩建公告','合成扩建项目的可核对摘要',90,true,${scopeVersion},${[await scopeReceipt(f.articleId)]},${sql.json(scopeOutput)})`;
  await confirmGroupingFixture(f.articleId);
  await publishArticle(f.articleId);
  const now = new Date();
  const api = await v1Items({ mode: "selected", window: "all", by: "published", category: null, q: null, limit: 100, cursor: null }, now);
  assert.equal(api.items.find((item) => item.id === f.articleId)!.publishedAt, null);
  assert.equal((await selectedSnapshot({ limit: 1000, page: null }, now)).items.find((item) => item.id === f.articleId)!.publishedAt, null);
  const rss = await itemFeed("selected", null, now);
  const item = rss.match(/<item>[\s\S]*?<\/item>/g)!.find((item) => item.includes(f.articleId))!;
  assert.match(item, /<dc:date>\d{4}-\d{2}-\d{2}<\/dc:date>/);
  assert.doesNotMatch(item, /<pubDate>/);
  assert.match(item, /<amp:first-public-at>/);
  await confirmedManualEdit(f.articleId, { fields: { title: "已核对的合成扩建消息" }, reason: "synthetic correction", version: 0 }, "test");
  const corrected = await selectedChanges({ cursor: empty.cursor, limit: 1000 });
  assert.ok(corrected.changes.filter((change) => change.op === "upsert").every((change) => change.item!.title === "已核对的合成扩建消息"));
  await setVisibility(f.articleId, { visibility: "withdrawn", reason: "synthetic withdrawal", version: 1 }, "test");
  const hidden = await selectedChanges({ cursor: empty.cursor, limit: 1000 });
  assert.ok(hidden.changes.every((change) => change.op === "remove"));
  assert.ok(!JSON.stringify(hidden).includes("扩建消息"));
});

test("server time repair fills existing metadata without re-scoring, changing copy or inventing historical first publication", async () => {
  const { repairPublicationTimes } = await import("@amp/backend/publication/publish");
  const f = await fixture(beijingDate(new Date()));
  const [before] = await sql`SELECT first_public_at,selected,score FROM publications WHERE article_id=${f.articleId}`;
  await sql`UPDATE publications SET title='必须保留的人工展示标题',source_time=NULL,source_time_material_revision=NULL WHERE article_id=${f.articleId}`;
  assert.ok((await repairPublicationTimes()).changed >= 1);
  const [after] = await sql`SELECT title,source_time,first_public_at,selected,score FROM publications WHERE article_id=${f.articleId}`;
  assert.equal(after!.title, "必须保留的人工展示标题");
  assert.equal(after!.source_time.precision, "date");
  assert.deepEqual({ first_public_at: after!.first_public_at, selected: after!.selected, score: after!.score }, before);
  assert.equal((await repairPublicationTimes()).changed, 0);
  await sql`UPDATE sources SET source_date_config_hash=${"e".repeat(64)} WHERE id=${f.input.sourceId}`;
  assert.ok((await repairPublicationTimes()).changed >= 1);
  assert.equal((await repairPublicationTimes()).checked, 0, "a rejected configuration remains unknown instead of looping indefinitely");
  assert.equal((await publicItemMetadata(f.articleId))!.source_time, null);
});

test("model inputs keep a date-only source day without an invented clock or private parsing context", async () => {
  const { loadAnalyzeInput, buildMaterial } = await import("../packages/backend/src/editorial/input.ts");
  const { buildScoreInput } = await import("../packages/backend/src/editorial/analyze.ts");
  const { renderContext, translateInputOf, buildArticlePrompt } = await import("../packages/backend/src/editorial/writing.ts");
  const day = beijingDate(new Date());
  const f = await fixture(day);
  const input = (await loadAnalyzeInput(f.articleId))!;
  assert.equal(input.sourceTime!.local_date, day);
  assert.equal(input.sourceTime!.utc, null);
  for (const rendered of [buildMaterial(input), buildScoreInput(input), renderContext(input)]) {
    assert.ok(rendered.includes(day));
    assert.ok(!rendered.includes("PRIVATE_DATE_CONFIGURATION"));
    assert.ok(!rendered.includes("00:00"));
  }
  const translated = buildArticlePrompt(translateInputOf(input));
  assert.ok(translated.includes(day));
});
test("unconfirmed source dates never turn discovery or legacy sorting anchors into publication facts", async () => {
  const { loadAnalyzeInput } = await import("../packages/backend/src/editorial/input.ts");
  const { buildScoreInput } = await import("../packages/backend/src/editorial/analyze.ts");
  const { renderContext, translateInputOf, buildArticlePrompt } = await import("../packages/backend/src/editorial/writing.ts");
  const f = await fixture();
  await sql`UPDATE articles SET published_at='2026-01-02T03:04:05Z',discovered_at='2026-01-03T04:05:06Z' WHERE id=${f.articleId}`;
  const input = (await loadAnalyzeInput(f.articleId))!;
  assert.equal(input.sourceTime, null);
  for (const rendered of [buildScoreInput(input), renderContext(input), buildArticlePrompt(translateInputOf(input))]) {
    assert.ok(!rendered.includes("2026-01-02"));
    assert.ok(!rendered.includes("2026-01-03"));
  }
});
test("relative source dates use the original local day across time zones", async () => {
  const { buildArticlePrompt } = await import("../packages/backend/src/editorial/writing.ts");
  const { normalizeSourceTime } = await import("@amp/contracts/time-assertion");
  const sourceTime = normalizeSourceTime(
    {
      meaning: "published",
      raw: "2026-01-02T23:30:00-05:00",
      local_date: "2026-01-02",
      local_time: "23:30:00",
      timezone: "America/New_York",
      utc: "2026-01-03T04:30:00Z",
      precision: "second",
      basis: "来源时区",
      condition_text: null,
    },
    { instantBasis: "explicit", timezoneEvidence: "明确时区" },
  );
  const prompt = buildArticlePrompt({
    title: "合成新闻",
    text: "今天发布的合成矿业公告",
    sourceKind: "rss",
    sourceTime,
    publishedAt: new Date(sourceTime.utc!),
  });
  assert.ok(prompt.includes("2026-01-02"));
  assert.ok(!prompt.includes("2026-01-03"));
});
