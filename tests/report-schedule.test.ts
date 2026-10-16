import { upsertMaterial } from "@amp/backend/content/materials";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import "./setup.ts";
import { closeDb, sql } from "@amp/backend/db";
import { stopBoss } from "@amp/backend/jobs/queue";
import { catchUpReports, dueDaily, dueWeekly, dueMonthly, editionTime } from "@amp/backend/reports/compose";
import { expectedReportKey } from "../apps/web/app/features/report/report-period.ts";

after(async () => {
  await stopBoss();
  await closeDb();
});
test("scheduler and reader agree at Beijing daily, weekly and monthly boundaries", () => {
  for (const time of [
    "2026-10-12T07:59:59+08:00",
    "2026-10-12T08:00:00+08:00",
    "2026-10-12T09:59:59+08:00",
    "2026-10-12T10:00:00+08:00",
    "2026-01-01T10:29:59+08:00",
    "2026-01-01T10:30:00+08:00",
  ]) {
    const now = new Date(time);
    assert.equal(dueDaily(now), expectedReportKey("daily", now));
    assert.equal(dueWeekly(now), expectedReportKey("weekly", now));
    assert.equal(dueMonthly(now), expectedReportKey("monthly", now));
  }
  assert.equal(editionTime("2026-10-12").toISOString(), "2026-10-12T00:00:00.000Z");
});
test("catch-up revisits an old gap outside the former seven-day limit and does not count an unjudged issue as written", async () => {
  await sql`INSERT INTO sources(id,name,kind,participation_mode) VALUES('catch-up-test','合成补刊来源','rss','editorial')`;
  const { articleId } = await upsertMaterial({
    sourceId: "catch-up-test",
    url: "https://example.invalid/catch-up",
    title: "合成普通新闻",
    publishedAt: new Date("2020-01-02T12:00Z"),
    discoveredAt: new Date("2020-01-02T12:00Z"),
    via: "fetch",
  });
  await sql`INSERT INTO publications(article_id,title,summary,url,source_id,channel,discovered_at,timeline_at,sort_at,selected,eligible,score) VALUES(${articleId},'合成普通新闻','已评分未入选','https://example.invalid/catch-up','catch-up-test','news','2020-01-02T12:00Z','2020-01-02T12:00Z','2020-01-02T12:00Z',false,true,20)`;
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at,origin) VALUES('daily','2020-01-02','2020-01-01','2020-01-02','{}',now(),'rule')`;
  const result = await catchUpReports(new Date("2020-01-20T01:00Z"), 1);
  assert.deepEqual(result.generated, ["daily:2020-01-03"]);
  assert.equal((await sql`SELECT origin FROM reports WHERE key='2020-01-03'`)[0]!.origin, "rule");
  assert.deepEqual((await catchUpReports(new Date("2020-01-20T01:00Z"), 1)).generated, []);
});
