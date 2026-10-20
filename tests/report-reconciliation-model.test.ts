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

let afterAnswer: (() => Promise<void>) | null = null;
const provider = await stub(async () => {
  await afterAnswer?.();
  return {
    choices: [{ message: { content: JSON.stringify({ overview: "矿山扩建获批。", sections: {} }) } }],
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
