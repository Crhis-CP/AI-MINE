import { stub } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { stopBoss } from "@amp/backend/jobs/queue";
import { composeDaily } from "@amp/backend/reports/compose";
import { loadReport } from "@amp/backend/publication/reports";
import { reconcileReport } from "../packages/backend/src/reports/reconcile.ts";
import { requestReportRevision } from "../packages/backend/src/reports/revision-state.ts";
import { historyMaterial } from "./report-history-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";

let answerOverview = "矿山扩建获批。";
let afterAnswer: (() => Promise<void>) | null = null;
const provider = await stub(async () => {
  await afterAnswer?.();
  return {
    choices: [{ message: { content: JSON.stringify({ overview: answerOverview, sections: {} }) } }],
    usage: { prompt_tokens: 20, completion_tokens: 10 },
  };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "synthetic-key";
await installUsageFixtureForModel("deepseek-flash");
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});
test("historical monthly composition keeps its paid result when material changes in flight and reuses unchanged inputs", async () => {
  const material = await historyMaterial("2020-08-31", "矿山扩建获批");
  await composeDaily("2020-09-01");
  await requestReportRevision("monthly", "2020-08", "synthetic", [material]);
  afterAnswer = async () => {
    await sql`UPDATE articles SET revision=revision+1 WHERE id=${material}`;
  };
  const first = await reconcileReport("monthly", "2020-08");
  assert.equal(first.status, "stale");
  assert.equal(await loadReport("monthly", "2020-08"), null);
  const [receipt] = await sql`SELECT response,status FROM receipts WHERE subject='report:monthly:2020-08'`;
  assert.ok(receipt.response, "received answer is retained even when it cannot be published");
  assert.notEqual(receipt.status, "failed");
  afterAnswer = null;
  // Restore the same synthetic binding to demonstrate free reuse of its already received answer.
  await sql`UPDATE articles SET revision=revision-1 WHERE id=${material}`;
  await requestReportRevision("monthly", "2020-08", "synthetic retry", [material]);
  const hits = provider.hits();
  assert.equal((await reconcileReport("monthly", "2020-08")).status, "reconciled");
  const report = (await loadReport("monthly", "2020-08"))!;
  assert.ok(report.stories.some((entry) => entry.itemId === material));
  assert.equal(provider.hits(), hits);
  await requestReportRevision("monthly", "2020-08", "synthetic duplicate", [material]);
  assert.equal((await reconcileReport("monthly", "2020-08")).status, "unchanged");
  assert.equal((await loadReport("monthly", "2020-08"))!.revision, report.revision);
  assert.equal(provider.hits(), hits);
  await sql`UPDATE reports SET origin='manual' WHERE kind='monthly' AND key='2020-08'`;
  await requestReportRevision("monthly", "2020-08", "synthetic manual protection", [material]);
  assert.equal((await reconcileReport("monthly", "2020-08")).status, "preserved_manual");
  assert.equal(provider.hits(), hits);
});

test("rejected historical prose retries within the existing receipt bound and stops asking for automatic recovery at exhaustion", async () => {
  const material = await historyMaterial("2020-06-30", "矿山扩建获批");
  await composeDaily("2020-07-01");
  answerOverview = "";
  await requestReportRevision("monthly", "2020-06", "synthetic rejected prose", [material]);
  // Two unrelated paused turns must not consume any output retry allowance.
  await sql`UPDATE ops.lane_controls SET paused=true,reason='synthetic replay pause',actor='synthetic-test',expires_at=now()+interval '1 hour' WHERE lane='news' AND switch='publication' AND holder='owner'`;
  for (let attempt = 0; attempt < 2; attempt++) {
    await sql`UPDATE reports.reconciliation_jobs SET state='pending',lease_until=NULL WHERE kind='monthly' AND key='2020-06'`;
    await assert.rejects(reconcileReport("monthly", "2020-06"), /paused/);
  }
  await sql`UPDATE ops.lane_controls SET paused=false WHERE lane='news' AND switch='publication' AND holder='owner'`;
  for (let attempt = 0; attempt < 4; attempt++) {
    await sql`UPDATE reports.reconciliation_jobs SET state='pending',next_attempt_at=now() WHERE kind='monthly' AND key='2020-06'`;
    await reconcileReport("monthly", "2020-06");
    if (attempt === 0)
      assert.equal(
        (await sql`SELECT state FROM reports.reconciliation_jobs WHERE kind='monthly' AND key='2020-06'`)[0].state,
        "retry",
        "paused worker turns cannot exhaust output attempts",
      );
    const [receipt] = await sql`SELECT id,status FROM receipts WHERE subject='report:monthly:2020-06'`;
    assert.equal(receipt.status, "failed", "an unusable overview cannot become a completed reusable answer");
    await sql`UPDATE receipt_attempts SET finished_at=now()-interval '6 minutes' WHERE receipt_id=${receipt.id}`;
  }
  const [job] = await sql`SELECT state,result,message FROM reports.reconciliation_jobs WHERE kind='monthly' AND key='2020-06'`;
  assert.equal(job.state, "done");
  assert.equal(job.result, "waiting");
  assert.match(job.message, /人工/);
  const [count] = await sql`SELECT count(*)::int AS n FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id WHERE r.subject='report:monthly:2020-06'`;
  assert.equal(count.n, 3, "the existing three-response gateway bound is retained");
  answerOverview = "矿山扩建获批。";
  const july = await historyMaterial("2020-07-31", "矿山扩建获批");
  await composeDaily("2020-08-01");
  answerOverview = "无依据的99999吨。";
  await requestReportRevision("monthly", "2020-07", "synthetic grounding", [july]);
  await reconcileReport("monthly", "2020-07");
  await sql`UPDATE receipt_attempts SET finished_at=now()-interval '6 minutes' WHERE receipt_id IN(SELECT id FROM receipts WHERE subject='report:monthly:2020-07')`;
  answerOverview = "矿山扩建获批。";
  await requestReportRevision("monthly", "2020-07", "synthetic valid retry", [july]);
  await reconcileReport("monthly", "2020-07");
  assert.equal((await sql`SELECT status FROM receipts WHERE subject='report:monthly:2020-07'`)[0].status, "completed");
  assert.equal((await sql`SELECT state FROM reports.reconciliation_jobs WHERE kind='monthly' AND key='2020-07'`)[0].state, "done");
});

test("report prose preserves a later operative condition within the output schema bound", async () => {
  const material = await historyMaterial("2020-04-30", "矿山扩建获批，开工仍须另行许可");
  await composeDaily("2020-05-01");
  answerOverview = "矿山扩建获批。".repeat(40) + "开工仍须另行许可。";
  await requestReportRevision("monthly", "2020-04", "synthetic complete conditional prose", [material]);
  assert.equal((await reconcileReport("monthly", "2020-04")).status, "reconciled");
  const [saved] = await sql`SELECT content->>'overview' AS overview FROM reports WHERE kind='monthly' AND key='2020-04'`;
  assert.equal(saved.overview, answerOverview, "the length preference must not delete the last qualifying sentence");
});
