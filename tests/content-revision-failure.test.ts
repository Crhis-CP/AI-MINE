import { gate, DROP_RESPONSE, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { sql, closeDb } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { afterFailure, recordExtractDeferral, queueProcessing, registerContentJobs } from "@amp/backend/jobs/content";
import { getBoss, stopBoss, QUEUES } from "@amp/backend/jobs/queue";
import { BudgetExceededError, ProviderRejectedError, ReceiptBusyError } from "@amp/backend/providers/receipts";
import { ModelOutputError } from "@amp/backend/providers/llm";
import { CrawlDeferred } from "../packages/backend/src/acquisition/crawl.ts";
import { ensureModelSourceFixture } from "./model-source-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";

const source = `revision-${tag()}`;
let held: { asked: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>>; unknown: boolean } | undefined;
const provider = await stub(async () => {
  const current = held;
  current?.asked.open();
  if (current) await current.release.promise;
  if (current?.unknown) return DROP_RESPONSE;
  return {
    model: "fixture",
    choices: [{ message: { content: JSON.stringify({ label: "BLOCK", reason: "synthetic scope" }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
});
process.env.DASHSCOPE_BASE_URL = `${provider.url}/v1`;
process.env.DASHSCOPE_API_KEY = "synthetic-key";
before(async () => {
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,enabled,next_fetch_at) VALUES(${source},'Revision fixture','rss','T1','editorial',true,'2100-01-01')`;
  await ensureModelSourceFixture(source, ["https://fixture.invalid/source"]);
  await installUsageFixtureForModel("qwen3.7-flash");
  await getBoss();
});
after(async () => {
  held?.release.open();
  await stopBoss();
  await provider.close();
  await closeDb();
});
const write = (key: string, title: string) =>
  upsertMaterial({
    sourceId: source,
    url: `https://fixture.invalid/${key}`,
    title,
    language: "en",
    bodyText: "Copper mine output and the stated project conditions. ".repeat(10),
    bodyStatus: "ok",
    via: "fetch",
  });
const snapshot = async (id: string) =>
  (
    await sql`SELECT revision,processing_state,processing_attempts,processing_error,processing_retry_at,processing_queued_at,body_status FROM articles WHERE id=${id}`
  )[0];

for (const state of ["new", "analyzed"])
  test(`late failure paths cannot change a newer ${state} material`, async () => {
    const key = tag(),
      { articleId } = await write(key, "original");
    await sql`UPDATE articles SET processing_attempts=7,processing_error='old error',processing_retry_at='2100-01-01',processing_queued_at=now() WHERE id=${articleId}`;
    await write(key, "updated");
    const fresh = await snapshot(articleId);
    assert.deepEqual(
      [fresh!.revision, fresh!.processing_attempts, fresh!.processing_error, fresh!.processing_retry_at, fresh!.processing_queued_at],
      [2, 0, null, null, null],
    );
    await sql`UPDATE articles SET processing_state=${state},processing_attempts=2,processing_error='new revision',processing_retry_at='2100-01-01',processing_queued_at='2100-01-02' WHERE id=${articleId}`;
    const before = await snapshot(articleId);
    for (const error of [
      new ProviderRejectedError("denied", 401, false),
      new ModelOutputError("invalid output"),
      new Error("transport failed"),
      new BudgetExceededError("fixture", "hour", 60),
      new ReceiptBusyError("busy"),
    ]) {
      assert.equal((await afterFailure(articleId, error, 1)).state, "stale");
      assert.deepEqual(await snapshot(articleId), before);
    }
    for (const reason of ["host_pacing", "source_reader_pending"]) {
      assert.equal(await recordExtractDeferral(articleId, new CrawlDeferred(new Date(Date.now() + 60000), "fixture", reason), 1), "stale");
      assert.deepEqual(await snapshot(articleId), before);
    }
  });

async function completed(id: string) {
  for (let n = 0; n < 100; n++) {
    const [job] = await sql`SELECT state FROM pgboss.job WHERE id=${id}`;
    if (job?.state === "completed") return;
    assert.notEqual(job?.state, "failed");
    await delay(100);
  }
  assert.fail("worker did not complete the bounded fixture job");
}

test("real workers retain old paid outcomes and allow the newer revision to continue", async () => {
  await registerContentJobs(await getBoss(), 1);
  for (const unknown of [true, false]) {
    const key = tag(),
      { articleId } = await write(key, "old input");
    held = { asked: gate<void>(), release: gate<void>(), unknown };
    const job = await queueProcessing(articleId, { step: "analyze" });
    assert.ok(job);
    await Promise.race([held.asked.promise, delay(10000).then(() => assert.fail("no model request"))]);
    await write(key, "new input");
    const before = await snapshot(articleId);
    held.release.open();
    await completed(job);
    held = undefined;
    assert.deepEqual(await snapshot(articleId), before, "old completion/failure must not clear or fail the new revision");
    const receipts = await sql`SELECT status,response FROM receipts WHERE subject=${`article:${articleId}@1`}`;
    assert.ok(receipts.length);
    if (unknown) assert.equal(receipts[0]!.status, "unknown");
    else assert.ok(receipts[0]!.response, "known paid output remains recorded even when stale");
    const next = await queueProcessing(articleId, { step: "analyze" });
    assert.ok(next);
    await completed(next);
    assert.equal((await snapshot(articleId))!.processing_state, "blocked");
    assert.equal((await sql`SELECT count(*)::int n FROM analyses WHERE article_id=${articleId} AND input_revision=2`)[0]!.n > 0, true);
  }
  assert.ok(await sql`SELECT 1 FROM pgboss.queue WHERE name=${QUEUES.analyze}`);
});
