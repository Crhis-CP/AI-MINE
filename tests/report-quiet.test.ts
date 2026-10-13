// A scored window with no new selection is still a dated issue; missing judging stays pending.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { stub, tag } from "./setup.ts";
import { ensureModelSourceFixture } from "./model-source-fixture.ts";
import { scopeVersion, scopeOutput, scopeReceipt } from "./scope-fixture.ts";
import { dbOf, closeDb } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { publishArticle } from "@amp/backend/publication/publish";
import { composeDaily, catchUpReports, candidates } from "@amp/backend/reports/compose";
import { loadReport, listReports, v1Daily } from "@amp/backend/publication/reports";
import { dailyFeed } from "@amp/backend/publication/feeds";
import { stopBoss } from "@amp/backend/jobs/queue";
import { changeSystemLaneControl } from "../packages/backend/src/operations/lane-controls.ts";

const sql = dbOf("reports"),
  source = `quiet-${tag()}`;
const provider = await stub(() => {
  throw new Error("Quiet issues must never call a model");
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
before(async () => {
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at) VALUES(${source},'Quiet fixture','rss','T1','editorial','2100-01-01')`;
  await ensureModelSourceFixture(source, ["https://example.com/source"]);
});
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});
async function judged(label: string, at: string, score: number | null = 20) {
  const { articleId } = await upsertMaterial({
    sourceId: source,
    url: `https://example.com/${source}/${label}`,
    title: `矿业资讯 ${label}`,
    bodyText: `自编矿业资讯正文 ${label}`,
    language: "zh",
    bodyStatus: "ok",
    publishedAt: new Date(at),
    discoveredAt: new Date(at),
    via: "fetch",
  });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected,prompt_version,receipt_ids,output)
    VALUES(${articleId},1,'rule','pass','company_project',${`标题 ${label}`},'普通资讯摘要',${score},false,${scopeVersion},${[await scopeReceipt(articleId)]},${sql.json(scopeOutput)})`;
  assert.equal((await publishArticle(articleId, { now: new Date(at) }))?.selected, false);
  return articleId;
}
test("no selected news yields a dated quiet issue across archive, detail, API and RSS without a model", async () => {
  await judged("quiet", "2020-07-02T12:00:00Z");
  assert.deepEqual(await candidates(new Date("2020-07-02Z"), new Date("2020-07-03Z")), []);
  assert.deepEqual(await composeDaily("2020-07-03"), { key: "2020-07-03", entries: 0 });
  const report = (await loadReport("daily", "2020-07-03"))!;
  assert.equal(report.lead!.title, "今日无大事发生");
  assert.equal(report.generationStatus, "summary");
  assert.equal(report.windowStart, "2020-07-02T00:00:00.000Z");
  assert.equal(report.windowEnd, "2020-07-03T00:00:00.000Z");
  assert.deepEqual(report.stories, []);
  assert.deepEqual(report.flashes, []);
  assert.ok((await listReports("daily")).some((r) => r.key === report.key && r.title === report.lead!.title));
  assert.equal((await v1Daily("latest"))!.report.lead!.title, "今日无大事发生");
  assert.match(await dailyFeed(), /今日无大事发生/);
  assert.equal(provider.hits(), 0);
  assert.equal((await sql`SELECT model FROM reports WHERE key='2020-07-03'`)[0]!.model, null);
  await Promise.all([composeDaily(report.key), composeDaily(report.key)]);
  assert.equal((await loadReport("daily", report.key))!.revision, report.revision);
  assert.equal((await sql`SELECT count(*)::int n FROM report_revisions`)[0]!.n, 0);
});
test("no completed scores stays missing and does not fabricate a quiet day", async () => {
  await judged("unscored", "2020-07-03T12:00:00Z", null);
  await composeDaily("2020-07-04");
  assert.equal(await loadReport("daily", "2020-07-04"), null);
  assert.equal(provider.hits(), 0);
});
test("hourly catch-up publishes a judged quiet day and keeps an unjudged gap; 08:00 boundary is unchanged", async () => {
  await judged("at-boundary", "2020-07-04T00:00:00Z");
  const early = await catchUpReports(new Date("2020-07-04T23:59:59Z"), 2);
  assert.ok(!early.generated.includes("daily:2020-07-05"));
  assert.equal(await loadReport("daily", "2020-07-04"), null);
  const due = await catchUpReports(new Date("2020-07-05T00:00:00Z"), 2);
  assert.deepEqual(due.generated, ["daily:2020-07-05"]);
  assert.equal((await loadReport("daily", "2020-07-05"))!.lead!.title, "今日无大事发生");
  assert.deepEqual((await catchUpReports(new Date("2020-07-05T00:01:00Z"), 2)).generated, []);
  assert.equal(provider.hits(), 0);
});
test("withdrawn, ineligible and backfill scores cannot establish a quiet issue", async () => {
  for (const flag of ["withdrawn", "ineligible", "backfill"] as const) {
    const id = await judged(flag, "2020-07-05T12:00:00Z");
    if (flag === "withdrawn") await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${id}`;
    if (flag === "ineligible") await sql`UPDATE publications SET eligible=false WHERE article_id=${id}`;
    if (flag === "backfill") await sql`UPDATE publications SET backfill=true WHERE article_id=${id}`;
  }
  await composeDaily("2020-07-06");
  assert.equal(await loadReport("daily", "2020-07-06"), null);
});
test("publication pause prevents quiet publication; concurrent retries save only one edition", async () => {
  await judged("paused", "2020-07-06T12:00:00Z");
  const control = { lane: "news" as const, switches: ["publication" as const], reason: "test", actor: "test" };
  await changeSystemLaneControl({ ...control, action: "pause", expected: { publication: 0 }, expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  await assert.rejects(composeDaily("2020-07-07"));
  assert.equal(await loadReport("daily", "2020-07-07"), null);
  await changeSystemLaneControl({ ...control, action: "resume", expected: { publication: 1 } });
  await Promise.all([composeDaily("2020-07-07"), composeDaily("2020-07-07")]);
  assert.equal((await loadReport("daily", "2020-07-07"))!.revision, 1);
  assert.equal(provider.hits(), 0);
});
