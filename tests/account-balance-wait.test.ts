import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { ACCOUNT_WAIT_SECONDS, afterFailure, reviveAccountFailures } from "@amp/backend/jobs/content";
import { accountOutOfMoney, providerRejection } from "../packages/backend/src/providers/provider-errors.ts";
import { ProviderRejectedError } from "@amp/backend/providers/receipts";

after(closeDb);

// The message the Owner's alert carried on 2026-11-12.
const BODY = '{"error":{"message":"Insufficient Balance","type":"unknown_error","param":null,"code":"invalid_request_error"}}';

test("only an out-of-money refusal is told apart: a wrong key or a ban is not cured by topping up", () => {
  const broke = providerRejection("deepseek", 402, BODY);
  assert.equal(broke.retryable, false);
  assert.equal(accountOutOfMoney(broke.message), true);
  assert.equal(
    accountOutOfMoney('deepseek HTTP 402: {"code":"invalid_request_error","message":"Insufficient Balance (request_id: 0372'),
    true,
    "as cut off in an alert",
  );
  assert.equal(accountOutOfMoney('dashscope HTTP 400: {"code":"PrepaidBillOverdue","message":"x"}'), true);
  assert.equal(accountOutOfMoney("zhipu HTTP 429: 账户已欠费，请充值"), true);
  for (const other of [
    'deepseek HTTP 401: {"code":"invalid_api_key","message":"Authentication Fails"}',
    "deepseek HTTP 403: forbidden",
    "deepseek HTTP 500: upstream",
    "Quotes must occur in the source",
    null,
    "",
  ])
    assert.equal(accountOutOfMoney(other), false, String(other));
});

test("while the account is empty an article waits without using attempts; after a top-up it goes on, and earlier failures revive", async () => {
  await sql`INSERT INTO sources(id, name, kind, tier, config) VALUES('synthetic-balance', 'Synthetic Balance', 'rss', 'T2', '{}'::jsonb)`;
  const make = async (n: number) =>
    (
      await upsertMaterial({
        sourceId: "synthetic-balance",
        url: `https://fixture.invalid/balance/${n}`,
        title: `Synthetic ${n}`,
        bodyText: "Synthetic body about a copper project permit.",
        bodyStatus: "ok",
        language: "en",
        publishedAt: new Date(),
        via: "fetch",
      })
    ).articleId;
  const waiting = await make(1);
  const failure = providerRejection("deepseek", 402, BODY);
  const error = new ProviderRejectedError(failure.message, 402, failure.retryable, failure.failureKind);
  // Three hours of an empty account: far more refusals than the ordinary retry ladder allows.
  for (let i = 0; i < 20; i++) assert.equal((await afterFailure(waiting, error, 1)).state, "waiting");
  const [row] = await sql`SELECT processing_state, processing_attempts, processing_retry_at, processing_error FROM articles WHERE id = ${waiting}`;
  assert.equal(row!.processing_state, "new");
  assert.equal(row!.processing_attempts, 0);
  const wait = (row!.processing_retry_at as Date).getTime() - Date.now();
  assert.ok(wait > (ACCOUNT_WAIT_SECONDS - 30) * 1000 && wait <= ACCOUNT_WAIT_SECONDS * 1000, "looks again in about ten minutes");
  assert.match(row!.processing_error, /Insufficient Balance/);

  // A refusal that is not about money still fails at once, as before.
  const banned = await make(2);
  const denied = providerRejection("deepseek", 401, '{"error":{"message":"Authentication Fails","code":"invalid_api_key"}}');
  assert.equal((await afterFailure(banned, new ProviderRejectedError(denied.message, 401, denied.retryable, denied.failureKind), 1)).state, "failed");

  // Articles failed for lack of money before this change (or by another path) come back by themselves; others do not.
  const legacy = await make(3);
  const old = await make(4);
  const other = await make(5);
  await sql`UPDATE articles SET processing_state = 'failed', processing_attempts = 1, processing_error = ${failure.message} WHERE id IN (${legacy}, ${old})`;
  await sql`UPDATE articles SET discovered_at = now() - interval '20 days' WHERE id = ${old}`;
  await sql`UPDATE articles SET processing_state = 'failed', processing_attempts = 6, processing_error = 'Quotes must occur in the source' WHERE id = ${other}`;
  assert.deepEqual(await reviveAccountFailures(), { revived: 1 });
  const states = Object.fromEntries(
    (await sql`SELECT id, processing_state, processing_attempts FROM articles WHERE id IN (${legacy}, ${old}, ${other}, ${banned})`).map((r) => [
      r.id,
      `${r.processing_state}/${r.processing_attempts}`,
    ]),
  );
  assert.deepEqual(states, { [legacy]: "new/0", [old]: "failed/1", [other]: "failed/6", [banned]: "failed/1" });
  assert.deepEqual(await reviveAccountFailures(), { revived: 0 }, "nothing left to revive");
});
