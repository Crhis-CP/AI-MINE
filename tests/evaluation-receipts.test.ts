import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { sql, closeDb } from "@amp/backend/db";
import { chatJson } from "@amp/backend/providers/llm";
import { autoReleaseUnknownReceipts } from "@amp/backend/admin/runs";
import { stopBoss } from "@amp/backend/jobs/queue";
import { boundEvaluationFixture } from "./bound-eval-fixture.ts";
import { materialFixturePermit } from "./model-source-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";

const provider = await stub(() => ({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
await installUsageFixtureForModel("deepseek-flash");
after(async () => {
  await stopBoss();
  await provider.close();
  await closeDb();
});
async function fixture() {
  const marker = tag();
  const f = await boundEvaluationFixture({
    title: marker,
    body: `Synthetic mining material ${marker}`,
    source: marker,
    tier: "T1",
    kind: "rss",
    firstParty: true,
    publishedAt: "2026-10-20T00:00:00Z",
  });
  const request = { system: "Return the synthetic boolean", user: f.analysisInput.bodyText!, promptVersion: "synthetic-evaluation-isolation-v1" };
  const call = async (usagePurpose: "production" | "evaluation") =>
    chatJson({
      model: "deepseek-flash",
      purpose: "prefilter_article",
      subject: `article:${f.analysisInput.id}@1`,
      sourceIds: [f.analysisInput.sourceId!],
      ...request,
      schema: z.object({ ok: z.boolean() }),
      usagePurpose,
      fallbackPermit: await materialFixturePermit(f.analysisInput.id, request),
    });
  return { ...f, call };
}

test("evaluation and production own distinct unknown states while evaluation reuses itself", async () => {
  const f = await fixture(),
    hits = provider.hits();
  const production = await f.call("production"),
    evaluation = await f.call("evaluation"),
    repeated = await f.call("evaluation");
  assert.notEqual(evaluation.receiptId, production.receiptId);
  assert.equal(repeated.receiptId, evaluation.receiptId);
  assert.equal(repeated.reused, true);
  assert.equal(provider.hits(), hits + 2);
  const [row] = await sql`SELECT request FROM receipts WHERE id=${evaluation.receiptId}`;
  assert.equal(row.request.receipt_scope, "evaluation-v1");
});

test("releasing an isolated evaluation receipt never resets an unrelated failed production article", async () => {
  const f = await fixture(),
    result = await f.call("evaluation");
  await sql`UPDATE articles SET processing_state='failed',processing_error='unrelated production failure' WHERE id=${f.analysisInput.id}`;
  await sql`UPDATE receipts SET status='unknown',updated_at=now()-interval '31 minutes' WHERE id=${result.receiptId}`;
  await sql`UPDATE receipt_attempts SET status='unknown',error='synthetic unknown result' WHERE receipt_id=${result.receiptId}`;
  const resumed = await autoReleaseUnknownReceipts();
  assert.equal(resumed.released, 1);
  assert.equal(resumed.requeued, 0);
  const [article] = await sql`SELECT processing_state,processing_error FROM articles WHERE id=${f.analysisInput.id}`;
  assert.deepEqual(article, { processing_state: "failed", processing_error: "unrelated production failure" });
  assert.equal((await sql`SELECT status FROM receipt_attempts WHERE receipt_id=${result.receiptId}`)[0].status, "unknown");
  assert.equal((await autoReleaseUnknownReceipts()).released, 0);
});
