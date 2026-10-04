// Paid requests: an answer already received is reused, every request actually sent counts against the
// budget (retries of one logical request included), an unresolved answer is never bought again, and the
// valve stops calls before they are sent.
import { gate, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { z } from "zod";
import { createDatabaseAccess } from "@amp/config";
import { SCHEDULES } from "../apps/worker/src/schedules.ts";
import { buildApp } from "../apps/api/src/app.ts";
import { config } from "@amp/backend/config";
import { closeDb, dbOf } from "@amp/backend/db";
import { chatJson, ModelOutputError } from "@amp/backend/providers/llm";
import { embeddingsAvailable } from "@amp/backend/providers/embeddings";
import { BudgetExceededError, completeReceipt, markStalePendingReceipts, paidRequest, ReceiptUnknownError } from "@amp/backend/providers/receipts";
import { autoReleaseUnknownReceipts, releaseReceipt } from "@amp/backend/admin/runs";
import { upsertMaterial } from "@amp/backend/content/materials";
import { hasPrefilterReceipt } from "../packages/backend/src/providers/receipt-evidence.ts";
import { stopBoss } from "@amp/backend/jobs/queue";

const sql = dbOf("ai-gateway");

const usage = { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 };
let answer: (hit: number) => string = () => '{"ok":true}';
const provider = await stub((hit) => ({ id: `stub-${hit}`, choices: [{ message: { content: answer(hit) } }], usage }));
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";

const ask = (subject: string) =>
  chatJson({
    model: "deepseek-flash",
    purpose: "invariant_test",
    subject,
    promptVersion: "t1",
    system: "s",
    user: `input ${subject}`,
    schema: z.object({ ok: z.boolean() }),
  });

let savedBudget: { per_minute: number; per_hour: number; per_day: number } | undefined;
before(async () => {
  [savedBudget] = await sql<
    { per_minute: number; per_hour: number; per_day: number }[]
  >`SELECT per_minute, per_hour, per_day FROM budgets WHERE service = 'deepseek'`;
});
after(async () => {
  if (savedBudget)
    await sql`UPDATE budgets SET per_minute = ${savedBudget.per_minute}, per_hour = ${savedBudget.per_hour}, per_day = ${savedBudget.per_day} WHERE service = 'deepseek'`;
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("the migrations seed a budget for every paid service", async () => {
  const rows = await sql<{ service: string }[]>`SELECT service FROM budgets`;
  const services = new Set(rows.map((r) => r.service));
  for (const s of ["jina", "dajiala", "zhipu", "deepseek", "mimo", "dashscope"]) assert.ok(services.has(s), `no budget for ${s}`);
});

test("an answer already received is reused instead of bought again", async () => {
  answer = () => '{"ok":true}';
  const subject = `reuse-${tag()}`;
  const before = provider.hits();
  const first = await ask(subject);
  const second = await ask(subject);
  assert.equal(provider.hits() - before, 1);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.receiptId, first.receiptId);
});

test("retries of unusable answers stop at the budget, and every request sent is counted", async () => {
  answer = () => "sorry, not json";
  const subject = `budget-${tag()}`;
  // Leave room for exactly two more requests in every window.
  const [c] = await sql<{ minute: number; hour: number; day: number }[]>`
    SELECT count(*) FILTER (WHERE started_at > now() - interval '1 minute')::int AS minute,
           count(*) FILTER (WHERE started_at > now() - interval '1 hour')::int AS hour,
           count(*)::int AS day
    FROM receipt_attempts WHERE service = 'deepseek' AND origin = 'live' AND started_at > now() - interval '1 day'`;
  await sql`UPDATE budgets SET per_minute = ${c!.minute + 2}, per_hour = ${c!.hour + 2}, per_day = ${c!.day + 2} WHERE service = 'deepseek'`;

  const before = provider.hits();
  const outcomes: string[] = [];
  const unusableReceiptIds: number[] = [];
  for (let i = 0; i < 5; i++) {
    // What a job retry does: the same logical request again.
    await ask(subject).then(
      () => outcomes.push("ok"),
      (error: unknown) => {
        if (error instanceof ModelOutputError) {
          assert.ok(error.receiptId, "a paid unusable response exposes its receipt");
          unusableReceiptIds.push(error.receiptId);
          outcomes.push("unusable");
        } else {
          outcomes.push(error instanceof BudgetExceededError ? "budget" : String(error));
        }
      },
    );
  }
  assert.equal(provider.hits() - before, 2, "requests sent");
  assert.deepEqual(outcomes, ["unusable", "unusable", "budget", "budget", "budget"]);
  assert.equal(new Set(unusableReceiptIds).size, 1, "retries keep the same logical receipt");
  const attempts = await sql<{ status: string; tokens: number }[]>`
    SELECT a.status, (a.usage->>'total_tokens')::int AS tokens
    FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id WHERE r.subject = ${subject} ORDER BY a.attempt`;
  assert.deepEqual(
    attempts.map((a) => a.tokens),
    [100, 100],
    "each attempt keeps its own usage",
  );
});

test("with the valve off nothing is sent", async () => {
  config.modelCallsEnabled = false;
  try {
    const before = provider.hits();
    await assert.rejects(ask(`valve-${tag()}`), /disabled/);
    assert.equal(provider.hits(), before);
    process.env.DASHSCOPE_API_KEY = "test-key";
    assert.equal(embeddingsAvailable(), false);
  } finally {
    config.modelCallsEnabled = true;
    delete process.env.DASHSCOPE_API_KEY;
  }
});

test("a sent request timing out stays unknown beyond 30 minutes and cannot be bought again", async () => {
  const req = { service: "invariant-unbudgeted", purpose: "invariant_test", subject: `lost-${tag()}`, identity: { lost: tag() } };
  const started = gate(),
    finish = gate(),
    abort = new AbortController();
  const remote = await stub(async () => {
    started.open();
    await finish.promise;
    return { ok: true };
  });
  const lost = async () => ({ response: await (await fetch(remote.url, { signal: abort.signal })).json() });
  try {
    const first = assert.rejects(paidRequest(req, lost), /timeout/);
    await started.promise;
    abort.abort(new Error("fixture timeout after sending"));
    await first;
    await sql`UPDATE receipts SET updated_at=now()-interval '31 minutes' WHERE subject=${req.subject}`;
    for (const now of [Date.now(), Date.now() + 32 * 86400_000]) {
      assert.deepEqual(await autoReleaseUnknownReceipts(now), { released: 0, requeued: 0 });
      await assert.rejects(paidRequest(req, lost), ReceiptUnknownError);
    }
    const recovery = (await SCHEDULES.find((schedule) => schedule.name === "ops.recover")!.run()) as { released: { released: number; requeued: number } };
    assert.deepEqual(recovery.released, { released: 0, requeued: 0 });
    const rows =
      await sql`SELECT r.status, a.status AS attempt, a.cost FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id WHERE r.subject=${req.subject}`;
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [{ status: "unknown", attempt: "unknown", cost: null }],
    );
    assert.equal(remote.hits(), 1);
  } finally {
    finish.open();
    await remote.close();
  }
});

async function stoppedArticle(purpose: string, needsBody = false) {
  const key = tag();
  const sourceId = `recovery-${key}`;
  await sql`INSERT INTO sources (id, name, kind, config) VALUES (${sourceId}, 'Recovery', 'rss', '{"fetchPublicContent":true}')`;
  const { articleId } = await upsertMaterial({
    sourceId,
    url: `https://example.com/recovery-${key}`,
    title: "Recovery",
    via: "fetch",
    bodyStatus: needsBody ? "pending" : "ok",
    bodyText: needsBody ? undefined : "body",
  });
  const subject = needsBody ? `article:${articleId}` : `article:${articleId}@1`;
  const request = { service: "invariant-unbudgeted", purpose, subject, identity: { key } };
  await assert.rejects(paidRequest(request, () => Promise.reject(new Error("socket hang up after sending"))));
  await sql`UPDATE articles SET processing_state = 'failed', processing_attempts = 3,
    processing_retry_at = now() + interval '1 hour', processing_error = 'receipt outcome unknown' WHERE id = ${articleId}`;
  const [receipt] = await sql<{ id: number }[]>`SELECT id FROM receipts WHERE subject = ${subject}`;
  return { articleId, receiptId: receipt!.id, request };
}

test("only documented non-billing requeues the failed articles of all five analysis steps", async () => {
  const ids: string[] = [];
  for (const purpose of ["prefilter_article", "score_article", "understand_article", "summarize_article", "structure_article"]) {
    const { articleId, receiptId } = await stoppedArticle(purpose);
    ids.push(articleId);
    await sql`UPDATE receipts SET updated_at = now() - interval '31 minutes' WHERE id = ${receiptId}`;
    assert.deepEqual(await autoReleaseUnknownReceipts(), { released: 0, requeued: 0 });
    assert.equal((await sql`SELECT processing_state FROM articles WHERE id=${articleId}`)[0].processing_state, "failed");
    assert.equal((await releaseReceipt(receiptId, { billed: false, note: "provider console confirms no charge" }, "test"))?.requeued, true);
  }
  const rows = await sql<{ state: string; attempts: number; retry: Date | null; error: string | null }[]>`
    SELECT processing_state AS state, processing_attempts AS attempts, processing_retry_at AS retry, processing_error AS error
    FROM articles WHERE id = ANY(${ids}::text[])`;
  assert.equal(rows.length, ids.length);
  for (const row of rows) assert.deepEqual(row, { state: "new", attempts: 0, retry: null, error: null });
  const jobs = await sql`SELECT id FROM pgboss.job WHERE name = 'content.analyze' AND data->>'articleId' = ANY(${ids}::text[])`;
  assert.equal(jobs.length, ids.length, "each article has a real processing job");
  assert.deepEqual(await autoReleaseUnknownReceipts(), { released: 0, requeued: 0 }, "a released receipt is not queued twice");
});

test("manual release resumes pending body reads and leaves unrelated article work alone", async () => {
  const body = await stoppedArticle("body_fallback", true);
  const result = await releaseReceipt(body.receiptId, { billed: false, note: "checked the provider" }, "test");
  assert.equal(result?.requeued, true);
  const jobs = await sql<{ name: string }[]>`SELECT name FROM pgboss.job WHERE data->>'articleId' = ${body.articleId}`;
  assert.deepEqual(
    jobs.map((j) => j.name),
    ["content.extract-body"],
    "the unfinished body is fetched before analysis",
  );
  const { articleId, receiptId } = await stoppedArticle("translate_body");
  assert.equal((await releaseReceipt(receiptId, { billed: false, note: "checked the provider" }, "test"))?.requeued, false);
  const [article] = await sql<{ state: string }[]>`SELECT processing_state AS state FROM articles WHERE id = ${articleId}`;
  assert.equal(article!.state, "failed", "translation is not a reason to rerun the editorial pipeline");
});

test("applied prefilter proof reuses parsed evidence without making a provider call", async () => {
  const expected = { promptVersion: "synthetic-v1", systemHash: "system-fixture", userHash: tag() };
  const receipt = await paidRequest({ service: "fixture", purpose: "prefilter_article", identity: expected, requestSummary: expected }, async () => ({
    response: { choices: [{ message: { content: '{"label":" pass ","reason":"synthetic"}' } }] },
  }));
  assert.equal(await hasPrefilterReceipt([receipt.receiptId], expected), false, "received is not yet applied");
  await completeReceipt(sql, receipt.receiptId);
  assert.equal(await hasPrefilterReceipt([receipt.receiptId], expected), true);
  assert.equal(await hasPrefilterReceipt([], expected), false);
  assert.equal(await hasPrefilterReceipt([receipt.receiptId], { ...expected, userHash: "different" }), false);
  await sql`UPDATE receipts SET purpose = 'score_article' WHERE id = ${receipt.receiptId}`;
  assert.equal(await hasPrefilterReceipt([receipt.receiptId], expected), false);
});

test("manual HTTP resolution rejects billed/invalid inputs and commits audit, receipt and one queue job atomically", async () => {
  const stopped = await stoppedArticle("prefilter_article");
  const saved = { host: config.privateHost, admin: config.devAdmin };
  config.privateHost = "private.receipt.test";
  config.devAdmin = { displayName: "Receipt test" };
  const app = await buildApp("private-api");
  const post = (payload: object) =>
    app.inject({
      method: "POST",
      url: `/api/admin/receipts/${stopped.receiptId}/release`,
      headers: { "x-forwarded-host": "private.receipt.test", "x-csrf-token": "dev" },
      payload,
    });
  const state = async () => (await sql`SELECT status FROM receipts WHERE id=${stopped.receiptId}`)[0].status;
  try {
    const billed = await post({ billed: true, note: "provider console shows charge; amount is unresolved" });
    assert.equal(billed.statusCode, 409);
    assert.equal(billed.json().code, "conflict");
    for (const payload of [{}, { billed: false, note: " " }, { billed: "false", note: "not a boolean" }]) {
      const response = await post(payload);
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().code, "invalid_request");
    }
    assert.equal(await state(), "unknown");
    await sql.unsafe(`CREATE FUNCTION fail_receipt_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture audit failure'; END$$;
      CREATE TRIGGER fail_receipt_audit BEFORE INSERT ON audit_log FOR EACH ROW WHEN (NEW.action='receipt.release') EXECUTE FUNCTION fail_receipt_audit()`);
    try {
      assert.equal((await post({ billed: false, note: "provider confirms no charge" })).statusCode, 500);
      assert.equal(await state(), "unknown");
      assert.equal((await sql`SELECT status FROM receipt_attempts WHERE receipt_id=${stopped.receiptId}`)[0].status, "unknown");
      assert.equal((await sql`SELECT processing_state FROM articles WHERE id=${stopped.articleId}`)[0].processing_state, "failed");
      assert.equal((await sql`SELECT count(*)::int AS n FROM pgboss.job WHERE data->>'articleId'=${stopped.articleId}`)[0].n, 0);
    } finally {
      await sql.unsafe("DROP TRIGGER fail_receipt_audit ON audit_log; DROP FUNCTION fail_receipt_audit()");
    }
    const responses = await Promise.all([
      post({ billed: false, note: "provider confirms no charge" }),
      post({ billed: false, note: "provider confirms no charge" }),
    ]);
    assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 409]);
    assert.equal(responses.find((r) => r.statusCode === 200)!.json().requeued, true);
    assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action='receipt.release' AND subject=${`receipt:${stopped.receiptId}`}`)[0].n, 1);
    assert.equal((await sql`SELECT count(*)::int AS n FROM pgboss.job WHERE data->>'articleId'=${stopped.articleId}`)[0].n, 1);
    let sent = 0;
    const call = async () => {
      sent++;
      return { response: { ok: true } };
    };
    assert.equal((await paidRequest(stopped.request, call)).reused, false);
    assert.equal((await paidRequest(stopped.request, call)).reused, true);
    assert.equal(sent, 1, "one new paid attempt only after confirmed non-billing; then reuse");
  } finally {
    await app.close();
    config.privateHost = saved.host;
    config.devAdmin = saved.admin;
  }
});

test("stale recovery keeps unresolved attempts but never overwrites a concurrently saved response", async () => {
  const req = { service: "invariant-unbudgeted", purpose: "invariant_test", subject: `stale-${tag()}`, identity: { stale: tag() } };
  const started = gate(),
    answerReady = gate();
  const calling = paidRequest(req, async () => {
    started.open();
    await answerReady.promise;
    return { response: { late: true } };
  });
  await started.promise;
  await sql`UPDATE receipts SET updated_at=now()-interval '11 minutes' WHERE subject=${req.subject}`;
  await markStalePendingReceipts();
  assert.equal((await sql`SELECT status FROM receipts WHERE subject=${req.subject}`)[0].status, "unknown");
  assert.deepEqual(await autoReleaseUnknownReceipts(Date.now() + 3600_000), { released: 0, requeued: 0 });
  answerReady.open();
  await calling;
  assert.equal(
    (
      await paidRequest(req, async () => {
        throw new Error("must reuse");
      })
    ).reused,
    true,
  );
  await sql`UPDATE receipts SET status='pending', updated_at=now()-interval '11 minutes' WHERE subject=${req.subject}`;
  const access = createDatabaseAccess("test", { DATABASE_URL: process.env.DATABASE_URL!, DATABASE_POOL_MAX: "1" }, () => {});
  const locked = gate(),
    unlock = gate();
  const writer = access.dbFor("worker").begin(async (tx) => {
    await tx`UPDATE receipts SET status='received', updated_at=now() WHERE subject=${req.subject}`;
    locked.open();
    await unlock.promise;
  });
  try {
    await locked.promise;
    const recovered = markStalePendingReceipts();
    const timeout = Symbol("blocked");
    const result = await Promise.race([recovered, new Promise((resolve) => setTimeout(() => resolve(timeout), 1000))]);
    unlock.open();
    await writer;
    await recovered;
    assert.notEqual(result, timeout, "recovery skips a result writer's row lock");
    assert.equal((await sql`SELECT status FROM receipts WHERE subject=${req.subject}`)[0].status, "received");
  } finally {
    unlock.open();
    await writer;
    await access.close();
  }
});
