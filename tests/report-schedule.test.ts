import { upsertMaterial } from "@amp/backend/content/materials";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import "./setup.ts";
import { closeDb, sql } from "@amp/backend/db";
import { stopBoss } from "@amp/backend/jobs/queue";
import { catchUpReports, composeWeekly, dueDaily, dueWeekly, dueMonthly, editionTime } from "@amp/backend/reports/compose";
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
test("catch-up writes the current daily before more than eight old gaps and retains missing-period failures", async () => {
  await sql`INSERT INTO sources(id,name,kind,participation_mode) VALUES('catch-up-test','合成补刊来源','rss','editorial')`;
  for (const day of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 19, 26]) {
    const at = new Date(`2020-01-${String(day).padStart(2, "0")}T12:00Z`);
    const { articleId } = await upsertMaterial({
      sourceId: "catch-up-test",
      url: `https://example.invalid/catch-up/${day}`,
      title: "合成普通新闻",
      publishedAt: at,
      discoveredAt: at,
      via: "fetch",
    });
    await sql`INSERT INTO publications(article_id,title,summary,url,source_id,channel,discovered_at,timeline_at,sort_at,selected,eligible,score)
      VALUES(${articleId},'合成普通新闻','已评分未入选',${`https://example.invalid/catch-up/${day}`},'catch-up-test','news',${at},${at},${at},false,true,20)`;
  }
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at,origin)
    VALUES('daily','2020-01-02','2020-01-01','2020-01-02','{}',now(),'rule'),
      ('weekly','2020-W02','2020-01-06','2020-01-12','{}',now(),'rule')`;
  const result = await catchUpReports(new Date("2020-01-20T01:00Z"));
  assert.deepEqual(result.generated, ["daily:2020-01-20", ...[3, 4, 5, 6, 7, 8, 9].map((day) => `daily:2020-01-${String(day).padStart(2, "0")}`)]);
  assert.equal((await sql`SELECT origin FROM reports WHERE kind='daily' AND key='2020-01-03'`)[0]!.origin, "rule");
  assert.equal(
    (await sql`SELECT 1 FROM reports WHERE kind='daily' AND key='2020-01-10'`).length,
    0,
    "the shared eight-write allowance also covers the current issue",
  );
  await assert.rejects(
    catchUpReports(new Date("2020-01-27T01:00Z")),
    /weekly:2020-W03 failed; daily:2020-01-27, daily:2020-01-10, daily:2020-01-11, daily:2020-01-12 written/,
    "a missing period fails honestly after unrelated current and historical dailies are written",
  );
  assert.equal((await sql`SELECT 1 FROM reports WHERE kind='weekly' AND key='2020-W03'`).length, 0);
  assert.equal((await sql`SELECT 1 FROM reports WHERE kind='daily' AND key='2020-01-13'`).length, 0, "an unjudged issue is never counted as written");
});

test("empty weeks skip only complete quiet dailies, with no paid writing or empty public issue", async () => {
  const before = await sql`SELECT id FROM receipts ORDER BY id`;
  await assert.rejects(composeWeekly("2021-W01"), /no daily entries/);
  for (let day = 4; day <= 9; day++) {
    const key = `2021-01-${String(day).padStart(2, "0")}`;
    await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at,origin)
      VALUES('daily',${key},${editionTime(key)},${editionTime(key)},${sql.json({ sections: [], flashes: [] })},now(),'rule')`;
  }
  await assert.rejects(composeWeekly("2021-W01"), /no daily entries/, "one missing daily is not quiet");
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at,origin)
    VALUES('daily','2021-01-10','2021-01-09','2021-01-10',${sql.json({ sections: [], flashes: [] })},now(),'rule')`;
  assert.deepEqual(await composeWeekly("2021-W01"), { key: "2021-W01", entries: 0 });
  await assert.rejects(composeWeekly("2021-W01", "operator requested rebuild"), /no daily entries/);
  await sql`UPDATE reports SET content=${sql.json({ sections: [{ label: "企业与项目", items: [{ itemId: "no-longer-public" }] }] })} WHERE kind='daily' AND key='2021-01-10'`;
  await assert.rejects(composeWeekly("2021-W01"), /no daily entries/, "a formerly carried entry losing public eligibility is not an originally quiet period");
  assert.equal((await sql`SELECT id FROM reports WHERE kind='weekly' AND key='2021-W01'`).length, 0);
  assert.deepEqual([...(await sql`SELECT id FROM receipts ORDER BY id`)], [...before]);
});
