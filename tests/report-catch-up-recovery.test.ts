import { stub } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { stopBoss } from "@amp/backend/jobs/queue";
import { catchUpReports, composeDaily } from "@amp/backend/reports/compose";
import { loadReport } from "@amp/backend/publication/reports";
import { ackReportChangeNotifications, reportChangeNotifications } from "@amp/backend/publication/groups";
import { historyMaterial } from "./report-history-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";

const provider = await stub(() => ({
  choices: [{ message: { content: JSON.stringify({ overview: "矿山扩建获批。", sections: {} }) } }],
  usage: { prompt_tokens: 20, completion_tokens: 10 },
}));
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "synthetic-key";
await installUsageFixtureForModel("deepseek-flash");
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("normal catch-up finds historical months even when no monthly issue has ever been stored", async () => {
  const material = await historyMaterial("2020-01-17", "矿山扩建获批");
  await composeDaily("2020-01-18");
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at,origin)
    SELECT 'daily',to_char(day,'YYYY-MM-DD'),day-interval '1 day',day,
      ${sql.json({ sections: [], flashes: [], lead: { title: "今日无大事发生", leadParagraph: "合成已完成评判的安静日报。" } })},day,'rule'
    FROM generate_series('2020-01-18'::date,'2020-04-02'::date,interval '1 day') day ON CONFLICT DO NOTHING`;
  // The service launched later; reliable historical dailies were added afterwards.
  await sql`UPDATE reports.calendar SET first_daily='2020-04-01'`;
  // Simulate restart with the original daily archive but no pending work from its creation.
  await sql`DELETE FROM reports.reconciliation_jobs`;
  const result = await catchUpReports(new Date("2020-04-02T03:00Z"));
  assert.ok(result.generated.includes("monthly:2020-01"), JSON.stringify(result));
  const report = (await loadReport("monthly", "2020-01"))!;
  assert.ok(report.stories.some((entry) => entry.itemId === material));
  assert.equal(await loadReport("monthly", "2019-12"), null, "do not backfill before the actual archive");
  assert.equal(await loadReport("monthly", "2020-04"), null, "do not publish the current month early");
  const hits = provider.hits();
  assert.deepEqual(await catchUpReports(new Date("2020-04-02T03:30Z")), { generated: [] });
  assert.equal(provider.hits(), hits, "the same period and input must not be bought again");
});

test("catch-up queues an empty or corrupt stored month once and the normal worker repairs it", async () => {
  await sql`DELETE FROM reports.reconciliation_jobs`;
  await sql`DELETE FROM reports`;
  await sql`DELETE FROM reports.calendar`;
  const material = await historyMaterial("2020-05-17", "矿山扩建获批");
  await composeDaily("2020-05-18");
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at,origin)
    VALUES('monthly','2020-05','2020-04-30T16:00Z','2020-05-31T16:00Z','{"themes":"broken"}',now(),'rule')`;
  await sql`DELETE FROM reports.reconciliation_jobs`;
  await sql.begin(async (tx) => ackReportChangeNotifications(await reportChangeNotifications(200), tx));
  // Missing unrelated quiet-day evidence must not prevent this known damaged edition being queued.
  await catchUpReports(new Date("2020-06-02T03:00Z")).catch(() => {});
  const [job] = await sql`SELECT generation,state FROM reports.reconciliation_jobs WHERE kind='monthly' AND key='2020-05'`;
  assert.equal(job?.state, "pending", "row existence must not hide a broken issue");
  await catchUpReports(new Date("2020-06-02T03:30Z")).catch(() => {});
  assert.equal((await sql`SELECT generation FROM reports.reconciliation_jobs WHERE kind='monthly' AND key='2020-05'`)[0]?.generation, job.generation);
  const { getBoss } = await import("@amp/backend/jobs/queue");
  const { registerReportCorrectionJobs, enqueuePendingReportCorrections } = await import("@amp/backend/reports/compose");
  await registerReportCorrectionJobs(await getBoss());
  await enqueuePendingReportCorrections();
  const deadline = Date.now() + 10_000;
  let repaired = false;
  while (Date.now() < deadline) {
    const [row] = await sql`SELECT content FROM reports WHERE kind='monthly' AND key='2020-05'`;
    if (
      Array.isArray(row?.content?.themes) &&
      row.content.themes.some((theme: { storyRefs: { itemId: string }[] }) => theme.storyRefs.some((entry) => entry.itemId === material))
    ) {
      repaired = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(repaired, JSON.stringify(await sql`SELECT kind,key,state,message FROM reports.reconciliation_jobs`));
  assert.ok((await loadReport("monthly", "2020-05"))!.stories.some((entry) => entry.itemId === material));
});

test("a newly damaged completed edition requeues without resetting active retries or manual-review stops", async () => {
  for (const [key, result] of [
    ["2020-06", "revised"],
    ["2020-07", "waiting"],
  ]) {
    await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at,origin)
      VALUES('monthly',${key},${`${key}-01`},${`${key}-28`},'{"themes":"broken"}',now(),'rule')`;
    await sql`INSERT INTO reports.reconciliation_jobs(kind,key,period_start,period_end,reason_code,evidence,state,result)
      VALUES('monthly',${key},${`${key}-01`},${`${key}-28`},'synthetic_previous','[]','done',${result}) ON CONFLICT(kind,key) DO UPDATE SET state='done',result=${result}`;
  }
  await catchUpReports(new Date("2020-08-02T03:00Z")).catch(() => {});
  assert.equal((await sql`SELECT state FROM reports.reconciliation_jobs WHERE kind='monthly' AND key='2020-06'`)[0]?.state, "pending");
  assert.equal((await sql`SELECT state FROM reports.reconciliation_jobs WHERE kind='monthly' AND key='2020-07'`)[0]?.state, "done");
  await sql`UPDATE reports.reconciliation_jobs SET state='retry',next_attempt_at='2100-01-01T00:00:00Z',attempts=3 WHERE kind='monthly' AND key='2020-06'`;
  await catchUpReports(new Date("2020-08-02T03:30Z")).catch(() => {});
  const [kept] = await sql`SELECT state,attempts,next_attempt_at FROM reports.reconciliation_jobs WHERE kind='monthly' AND key='2020-06'`;
  assert.equal(kept.state, "retry");
  assert.equal(kept.attempts, 3);
  assert.equal(kept.next_attempt_at.toISOString(), "2100-01-01T00:00:00.000Z");
});
