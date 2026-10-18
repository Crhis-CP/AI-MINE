import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { sql, closeDb } from "@amp/backend/db";
import { upsertMaterial } from "../packages/backend/src/content/materials.ts";
import { previewPublicationDateCorrection, correctPublicationDate, rerun } from "@amp/backend/admin/content";
import { materialSourceTime as readTime } from "../packages/backend/src/content/date-evidence.ts";
import { grantDateFixture } from "./source-date-fixture.ts";
import { stopBoss } from "@amp/backend/jobs/queue";

after(async () => {
  await stopBoss();
  await closeDb();
});
async function fixture() {
  const sourceId = `date-${randomUUID()}`,
    url = `https://${sourceId}.invalid/item`;
  await sql`INSERT INTO sources(id,name,kind,config,enabled) VALUES(${sourceId},'合成日期来源','rss',${sql.json({ feedUrl: `https://${sourceId}.invalid/feed`, language: "zh" })},true)`;
  await grantDateFixture(sourceId, [`https://${sourceId}.invalid`]);
  const now = new Date(),
    published = new Date(now.getTime() - 3600000);
  const { articleId } = await upsertMaterial({
    sourceId,
    url,
    title: "日期校正合成材料",
    language: "zh",
    bodyText: "这是一段合成测试原文，不使用真实文章。",
    bodyHtml: "<p>这是一段合成测试原文，不使用真实文章。</p>",
    publishedAt: published,
    discoveredAt: now,
    via: "fetch",
  });
  await sql`UPDATE articles SET processing_state='analyzed',grouping_status='complete',grouping_input_revision=revision,selection_adds_value=true WHERE id=${articleId}`;
  return { articleId, sourceId, published };
}
test("verified date-only correction is atomic, durable, preserves revision and retracts without buying processing", async () => {
  const { articleId, sourceId } = await fixture();
  const target = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const intent = { publishedAt: target, evidence: "已核对原文页面的日期行，仅提供日历日期。" };
  const plan = (await previewPublicationDateCorrection(articleId, intent))!;
  assert.equal(plan.after.sourceTime?.utc, null);
  assert.equal(plan.after.sourceTime?.precision, "date");
  const localDay = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const offsetPlan = (await previewPublicationDateCorrection(articleId, { ...intent, publishedAt: `${localDay}T23:30:00.123456-03:00` }))!;
  assert.equal(offsetPlan.after.sourceTime?.local_date, localDay);
  assert.equal(offsetPlan.after.sourceTime?.local_time, "23:30:00.123456");
  assert.notEqual(offsetPlan.after.sourceTime?.utc?.slice(0, 10), localDay);

  const key = randomUUID(),
    input = { ...intent, version: plan.version, hash: plan.hash, reason: "更正误读的时分" };
  const before = (await sql`SELECT revision,processing_state,body_text,discovered_at FROM articles WHERE id=${articleId}`)[0];
  const receiptCount = (await sql`SELECT count(*) AS n FROM receipts`)[0].n;
  const result = await correctPublicationDate(articleId, input, key, "test:date");
  assert.equal(result?.status, "corrected");
  assert.deepEqual(await correctPublicationDate(articleId, input, key, "test:date"), result);
  await assert.rejects(correctPublicationDate(articleId, { ...input, publishedAt: null }, key, "test:date"), /同一个请求/);
  const time = await readTime({ articleId, sourceId, revision: 1, configHash: "" }, 0, Date.now());
  assert.equal(time?.local_date, target);
  assert.equal(time?.utc, null);
  assert.deepEqual((await sql`SELECT revision,processing_state,body_text,discovered_at FROM articles WHERE id=${articleId}`)[0], before);
  assert.equal((await sql`SELECT count(*) AS n FROM receipts`)[0].n, receiptCount);
  const future = { publishedAt: "2999-10-01", evidence: "不可信的未来日期" };
  await assert.rejects(previewPublicationDateCorrection(articleId, future), /未来/);
  const other = await fixture();
  const retract = { publishedAt: null, evidence: "原文没有发布时间，旧时间实际为抓取时间。" };
  const preview = (await previewPublicationDateCorrection(other.articleId, retract))!;
  assert.equal(preview.archive, true);
  await sql`INSERT INTO grouping_overrides(article_id,reason,actor) VALUES(${other.articleId},'人工保留','test')`;
  await assert.rejects(
    correctPublicationDate(other.articleId, { ...retract, hash: preview.hash, version: preview.version, reason: "撤回错误日期" }, randomUUID(), "test:date"),
    /人工归组/,
  );
  await sql`DELETE FROM grouping_overrides WHERE article_id=${other.articleId}`;

  await correctPublicationDate(
    other.articleId,
    { ...retract, hash: preview.hash, version: preview.version, reason: "撤回错误日期" },
    randomUUID(),
    "test:date",
  );
  assert.equal(await readTime({ articleId: other.articleId, sourceId: other.sourceId, revision: 1, configHash: "" }, 0, Date.now()), null);
});
test("an undated historical material accepts verified old dates without entering recent news", async () => {
  const { articleId, sourceId } = await fixture();
  await sql`UPDATE articles SET published_at=NULL,published_at_claim=NULL,backfill=true,backfill_reason='unknown-publication-time' WHERE id=${articleId}`;
  const oldDay = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
  const intent = { publishedAt: oldDay, evidence: "原文公布的历史日历日期，现已人工核实。" };
  const plan = (await previewPublicationDateCorrection(articleId, intent))!;
  assert.equal(plan.mode, "history");
  assert.equal(plan.after.backfill, true);
  assert.equal(plan.after.sourceTime?.precision, "date");
  const result = await correctPublicationDate(
    articleId,
    { ...intent, version: plan.version, hash: plan.hash, reason: "补录已核实历史日期" },
    randomUUID(),
    "test:date",
  );
  assert.equal(result?.status, "corrected");
  assert.equal((await readTime({ articleId, sourceId, revision: 1, configHash: "" }, 0, Date.now()))?.local_date, oldDay);
  const [row] = await sql`SELECT backfill,revision,timeline_at FROM articles WHERE id=${articleId}`;
  assert.equal(row.backfill, true);
  assert.equal(row.revision, 1);
  assert(row.timeline_at.getTime() < Date.now() - 7 * 86400000);
  await assert.rejects(previewPublicationDateCorrection(articleId, { ...intent, publishedAt: new Date().toISOString() }), /不能.*刷入/);
});

test("stale preview and unsettled work cannot change dates; repeated analysis command stays idempotent after queue completion", async () => {
  const { articleId } = await fixture();
  const intent = { publishedAt: new Date(Date.now() - 7200000).toISOString(), evidence: "原文明确的带时区发布时间" };
  const plan = (await previewPublicationDateCorrection(articleId, intent))!;
  await sql`UPDATE articles SET updated_at=now()+interval '1 second' WHERE id=${articleId}`;
  await assert.rejects(
    correctPublicationDate(articleId, { ...intent, version: plan.version, hash: plan.hash, reason: "校正" }, randomUUID(), "test:date"),
    /重新预览/,
  );
  await sql`UPDATE articles SET processing_state='new' WHERE id=${articleId}`;
  assert.equal((await previewPublicationDateCorrection(articleId, intent))?.ready, false);
  const key = randomUUID();
  const first = await rerun(articleId, "analyze", key, "test:date", { reason: "复核本稿" });
  assert.ok(first && "jobId" in first);
  await sql`UPDATE articles SET processing_state='analyzed',processing_attempts=2 WHERE id=${articleId}`;
  assert.deepEqual(await rerun(articleId, "analyze", key, "test:date"), first);
  assert.equal((await sql`SELECT processing_attempts FROM articles WHERE id=${articleId}`)[0].processing_attempts, 2);
  assert.equal((await sql`SELECT reason FROM audit_log WHERE request_id=${key}`)[0].reason, "复核本稿");
});
