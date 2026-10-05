import { gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { runBodyTranslation } from "../packages/backend/src/editorial/translation-runtime.ts";
import {
  paidRequest,
  completeReceipt,
  markStalePendingReceipts,
  ReceiptAttemptSupersededError,
  ReceiptOutputLimitError,
  settleTranslationResponse,
  rejectReceivedResponse,
} from "@amp/backend/providers/receipts";
import { receiptObservedVersion, releaseReceipt } from "@amp/backend/admin/runs";
const sql = dbOf("enrichment"),
  T = tag(),
  source = `attempt-probe-${T}`;
const recipe = { id: T, model: "deepseek-flash", promptVersion: T, system: "SELF_AUTHORED attempt identity probe" };
let hits = 0;
let held: { asked: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>> } | null = null;
const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", async () => {
    hits++;
    const h = held;
    h?.asked.open();
    if (h) await h.release.promise;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ text: "合成中文", extra: true }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    );
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
before(async () => {
  await sql`INSERT INTO sources(id,name,kind,site_fulltext)VALUES(${source},'Attempt probe','rss',true)`;
});
after(async () => {
  held?.release.open();
  await new Promise<void>((r) => server.close(() => r()));
  await closeDb();
});
async function material(name: string) {
  return upsertMaterial({
    sourceId: source,
    url: `https://fixture.invalid/${T}/${name}`,
    title: name,
    language: "en",
    bodyText: `${name} ${T}`,
    bodyHtml: `<p>${name} ${T}</p>`,
    bodyStatus: "ok",
    via: "fetch",
  });
}
async function state(id: string, start: number) {
  const r = (
    await sql`SELECT id,status,attempts,response_attempt_id::text,response IS NOT NULL AS response_kept,usage FROM receipts WHERE subject LIKE ${`article:${id}@1#%`}`
  )[0];
  const s = (await sql`SELECT receipt_id,attempt_id,state,failed_attempts FROM enrichment.translation_segments WHERE article_id=${id}`)[0];
  const attempts = r
    ? await sql`SELECT id::text,attempt,status,output_rejected_at,response FROM receipt_attempts WHERE receipt_id=${r.id} ORDER BY attempt`
    : [];
  return { hits: hits - start, receipt: r ? { ...r } : null, checkpoint: s ? { ...s } : null, attempts: attempts.map((x) => ({ ...x })) };
}

// Synthetic elapsed time preserves the retry/stop windows without a real five-minute wait.
async function coolArticle(id: string) {
  await sql`UPDATE receipt_attempts SET finished_at=now()-interval '6 minutes'
    WHERE output_rejected_at IS NOT NULL AND receipt_id IN (SELECT id FROM receipts WHERE subject LIKE ${`article:${id}@1#%`})`;
}

test("second attempt received before checkpoint then restart cannot buy a fourth bad response", async () => {
  const { articleId } = await material("second-attempt-stop"),
    start = hits,
    phases: Record<string, unknown> = {};
  await runBodyTranslation(articleId, recipe);
  phases.first = await state(articleId, start);
  await coolArticle(articleId);
  held = { asked: gate(), release: gate() };
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {initializeDb,closeDb} from '@amp/backend/db';
    import {shutdownSignal} from '@amp/backend/jobs/queue';
    import {runBodyTranslation,TranslationInterruptedError} from './packages/backend/src/editorial/translation-runtime.ts';
    await initializeDb('test');process.on('SIGTERM',()=>{shutdownSignal.abort();process.send({stopped:true})});
    try {await runBodyTranslation(process.argv[1],JSON.parse(process.argv[2]))}
    catch(e){if(!(e instanceof TranslationInterruptedError))throw e}
    finally{await closeDb();process.disconnect()}
  `,
      articleId,
      JSON.stringify(recipe),
    ],
    { env: process.env, stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const stopped = gate();
  let stderr = "";
  child.on("message", (m) => {
    if (m && typeof m === "object" && "stopped" in m) stopped.open();
  });
  child.stderr!.on("data", (c) => (stderr += c));
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (c) => (c === 0 ? resolve() : reject(new Error(stderr))));
  });
  await Promise.race([held.asked.promise, done.then(() => assert.fail("no second request"))]);
  child.kill("SIGTERM");
  await stopped.promise;
  held.release.open();
  held = null;
  await done;
  phases.stopped = await state(articleId, start);
  await runBodyTranslation(articleId, recipe);
  phases.reused = await state(articleId, start);
  for (let n = 0; n < 3; n++) {
    await coolArticle(articleId);
    await runBodyTranslation(articleId, recipe);
  }
  phases.final = await state(articleId, start);
  console.log("SECOND_ATTEMPT_PROBE=" + JSON.stringify(phases));
  assert.equal(hits - start, 3, "a received second attempt is not identified by receipts.id alone");
});

test("checkpoint rollback preserves received response and cannot enable an uncounted retry", async () => {
  const { articleId } = await material("rejection-gap"),
    start = hits,
    name = `probe_gap_${T}`,
    phases: Record<string, unknown> = {};
  await sql`CREATE FUNCTION ${sql(name)}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'checkpoint unavailable'; END$$`;
  await sql`CREATE TRIGGER ${sql(name)} BEFORE INSERT ON enrichment.translation_segments FOR EACH ROW EXECUTE FUNCTION ${sql(name)}()`;
  try {
    await assert.rejects(runBodyTranslation(articleId, recipe), /checkpoint unavailable/);
    phases.gap = await state(articleId, start);
  } finally {
    await sql`DROP TRIGGER ${sql(name)} ON enrichment.translation_segments`;
    await sql`DROP FUNCTION ${sql(name)}()`;
  }
  for (let n = 0; n < 4; n++) {
    await coolArticle(articleId);
    await runBodyTranslation(articleId, recipe);
  }
  phases.final = await state(articleId, start);
  console.log("NONATOMIC_PROBE=" + JSON.stringify(phases));
  assert.equal(hits - start, 3, "receipt rejection and durable attempt accounting need the same transaction");
  assert.equal((phases.gap as { receipt: { status: string } }).receipt.status, "received");
});

const request = (name: string, limited = true) => ({
  service: "fixture-attempts",
  purpose: "translate_body",
  subject: `${name}-${T}`,
  identity: { name, T },
  ...(limited ? { maxRejectedOutputs: 3 as const } : {}),
});
const outcome = (marker: string, cost = 1.25) => ({
  response: { marker },
  usage: { prompt_tokens: 10, completion_tokens: 10 },
  cost: { amount: cost, currency: "USD", basis: "actual" as const },
});
async function versionFor(id: number) {
  const [row] = await sql<{ receiptId: string; attempts: number; updatedAtUtc: string }[]>`SELECT id::text AS "receiptId",attempts,
    pg_catalog.to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAtUtc" FROM receipts WHERE id=${id}`;
  return receiptObservedVersion(row!);
}

test("actual response pointers bind cached identity; duplicate settlement is idempotent and rollback leaves raw data received", async () => {
  const req = request("settlement");
  let calls = 0;
  const first = await paidRequest(req, async () => {
    calls++;
    return outcome("first");
  });
  assert.match(first.attemptId!, /^[1-9][0-9]*$/);
  const cached = await paidRequest(req, async () => assert.fail("must reuse"));
  assert.equal(cached.attemptId, first.attemptId);
  assert.equal(cached.reused, true);
  const unrelated = await paidRequest(request("unrelated"), async () => outcome("other"));
  assert.equal(
    await sql.begin((tx) => settleTranslationResponse(tx, { receiptId: first.receiptId, attemptId: unrelated.attemptId }, { accepted: true })),
    null,
  );
  const failure = new Error("atomic settlement rollback");
  await assert.rejects(
    sql.begin(async (tx) => {
      assert.deepEqual(await settleTranslationResponse(tx, first, { accepted: false, reason: "bad output" }), { rejected: 1 });
      throw failure;
    }),
    (e) => e === failure,
  );
  const [before] =
    await sql`SELECT r.status,a.output_rejected_at,a.response,a.usage,a.cost FROM receipts r JOIN receipt_attempts a ON a.id=r.response_attempt_id WHERE r.id=${first.receiptId}`;
  assert.equal(before.status, "received");
  assert.equal(before.output_rejected_at, null);
  assert.deepEqual(before.response, { marker: "first" });
  assert.equal(before.cost, 1.25);
  const rejected = await Promise.all([1, 2].map(() => sql.begin((tx) => settleTranslationResponse(tx, first, { accepted: false, reason: "bad output" }))));
  assert.deepEqual(rejected, [{ rejected: 1 }, { rejected: 1 }]);
  await sql`UPDATE receipt_attempts SET finished_at=now()-interval '6 minutes' WHERE id=${first.attemptId}`;
  const second = await paidRequest(req, async () => {
    calls++;
    return outcome("second", 2.5);
  });
  assert.equal(second.receiptId, first.receiptId);
  assert.notEqual(second.attemptId, first.attemptId);
  assert.equal(await sql.begin((tx) => settleTranslationResponse(tx, first, { accepted: true })), null, "old attempt cannot complete a newer one");
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${second.receiptId}`)[0].status, "received");
  await rejectReceivedResponse(first.receiptId, "late parse rejection", first.attemptId);
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${second.receiptId}`)[0].status, "received");
  assert.deepEqual(await sql.begin((tx) => settleTranslationResponse(tx, second, { accepted: true })), { rejected: 1 });
  const [settled] = await sql`SELECT updated_at::text FROM receipts WHERE id=${second.receiptId}`;
  assert.deepEqual(await sql.begin((tx) => settleTranslationResponse(tx, second, { accepted: true })), { rejected: 1 });
  assert.equal((await sql`SELECT updated_at::text FROM receipts WHERE id=${second.receiptId}`)[0].updated_at, settled.updated_at);
  const all = await sql`SELECT id::text,response,usage,cost FROM receipt_attempts WHERE receipt_id=${first.receiptId} ORDER BY attempt`;
  assert.deepEqual(
    all.map((r) => r.response),
    [{ marker: "first" }, { marker: "second" }],
  );
  assert.deepEqual(
    all.map((r) => r.cost),
    [1.25, 2.5],
  );
  assert.equal(calls, 2);
  await sql`UPDATE receipts r SET response_attempt_id=a.id,response=a.response FROM receipt_attempts a WHERE r.id=${second.receiptId} AND a.id=${first.attemptId}`;
  await assert.rejects(
    paidRequest(req, async () => assert.fail("known stale cache is not a new request")),
    ReceiptAttemptSupersededError,
  );
  await sql`UPDATE receipts r SET response_attempt_id=NULL,response=a.response FROM receipt_attempts a WHERE r.id=${second.receiptId} AND a.id=${second.attemptId}`;
  assert.equal((await paidRequest(req, async () => assert.fail("unbound history does not authorize a retry"))).attemptId, null, "never guess MAX(attempt id)");
  assert.equal(await sql.begin((tx) => settleTranslationResponse(tx, { receiptId: second.receiptId, attemptId: null }, { accepted: true })), null);
  await sql`UPDATE receipts SET status='failed' WHERE id=${second.receiptId}`;
  assert.equal((await paidRequest(req, async () => assert.fail("unbound failed history cannot enable a new payment"))).attemptId, null);
});

test("late old provider return is retained on its own attempt and never delivered as a normal result over new pending work", async () => {
  const req = request("late-provider"),
    entered = gate(),
    oldAnswer = gate(),
    newEntered = gate(),
    newAnswer = gate();
  const old = paidRequest(req, async () => {
    entered.open();
    await oldAnswer.promise;
    return outcome("old", 1.25);
  });
  await entered.promise;
  const [row] = await sql`SELECT id FROM receipts WHERE subject=${req.subject}`;
  await sql`UPDATE receipts SET updated_at=now()-interval '11 minutes' WHERE id=${row.id}`;
  await markStalePendingReceipts();
  await releaseReceipt(
    row.id,
    { billed: false, note: "SELF_AUTHORED provider non-billing evidence for the concurrency fixture", version: await versionFor(row.id) },
    "fixture",
  );
  const newer = paidRequest(req, async () => {
    newEntered.open();
    await newAnswer.promise;
    return outcome("new", 2.5);
  });
  await newEntered.promise;
  const oldChain = assert.rejects(
    old.then(async (result) => {
      await completeReceipt(sql, result.receiptId);
      return result;
    }),
    ReceiptAttemptSupersededError,
  );
  oldAnswer.open();
  await oldChain;
  const [pending] = await sql`SELECT status,attempts,response,response_attempt_id FROM receipts WHERE id=${row.id}`;
  assert.equal(pending.status, "pending");
  assert.equal(pending.attempts, 2);
  assert.equal(pending.response, null);
  assert.deepEqual((await sql`SELECT response FROM receipt_attempts WHERE receipt_id=${row.id} AND attempt=1`)[0].response, { marker: "old" });
  newAnswer.open();
  const current = await newer;
  assert.deepEqual(current.response, { marker: "new" });
  assert.equal((await paidRequest(req, async () => assert.fail("must reuse new result"))).attemptId, current.attemptId);
  assert.deepEqual(
    (await sql`SELECT response FROM receipt_attempts WHERE receipt_id=${row.id} ORDER BY attempt`).map((r) => r.response),
    [{ marker: "old" }, { marker: "new" }],
  );
});

test("translation output cap is checked before a new claim and legacy callers keep the default behavior", async () => {
  for (const limited of [true, false]) {
    const req = request(`limit-${limited}`, limited);
    let calls = 0;
    for (let n = 0; n < 3; n++) {
      const received = await paidRequest(req, async () => {
        calls++;
        return outcome(`bad-${n}`);
      });
      await sql.begin((tx) => settleTranslationResponse(tx, received, { accepted: false, reason: "known bad output" }));
      if (limited) await sql`UPDATE receipt_attempts SET finished_at=now()-interval '6 minutes' WHERE id=${received.attemptId}`;
    }
    if (limited)
      await assert.rejects(
        paidRequest(req, async () => {
          calls++;
          return outcome("fourth");
        }),
        ReceiptOutputLimitError,
      );
    else
      await paidRequest(req, async () => {
        calls++;
        return outcome("fourth");
      });
    assert.equal(calls, limited ? 3 : 4);
    assert.equal((await sql`SELECT attempts FROM receipts WHERE subject=${req.subject}`)[0].attempts, limited ? 3 : 4);
  }
});
