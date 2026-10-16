import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import "./setup.ts";
import { dbOf, closeDb } from "@amp/backend/db";
import { stopBoss } from "@amp/backend/jobs/queue";
import { paidRequest, BudgetExceededError, ProviderRejectedError } from "@amp/backend/providers/receipts";
import { installUsageFixtureForService } from "./usage-protection-fixture.ts";
import { modelBudgetService, ensureModelBudget } from "../packages/backend/src/providers/model-budget.ts";
const sql = dbOf("ai-gateway");
const services = ["quota-connection-a", "quota-connection-b"];
before(async () => {
  for (const service of services) await installUsageFixtureForService(service);
});
after(async () => {
  await stopBoss();
  await closeDb();
});
const request = (service: string, identity: string, bucket = "model:fixture.invalid") => ({
  service,
  budgetService: bucket,
  purpose: "quota_test",
  identity,
  subject: `synthetic:${identity}`,
  lane: "news" as const,
});
test("known providers and multiple endpoint paths share one service independently of model or credential", () => {
  assert.equal(modelBudgetService("https://api.deepseek.com/v1"), "deepseek");
  assert.equal(modelBudgetService("https://api.deepseek.com/chat/completions", "llm"), "deepseek");
  assert.equal(modelBudgetService("https://fixture.invalid/v1"), modelBudgetService("https://fixture.invalid/compatible/v1"));
  assert.equal(modelBudgetService("https://api.xiaomimimo.com/v1"), "mimo");
  assert.notEqual(modelBudgetService("https://fixture.invalid/v1"), modelBudgetService("https://other.invalid/v1"));
});
test("concurrent connections share the cap, paid results remain reusable, and explicit zero is never reset", async () => {
  const bucket = "model:fixture.invalid";
  await ensureModelBudget(bucket);
  await sql`UPDATE budgets SET per_minute=1,per_hour=1,per_day=1 WHERE service=${bucket}`;
  let calls = 0;
  const send = async () => {
    calls++;
    return { response: { ok: true } };
  };
  const requests = services.map((service, index) => request(service, `parallel-${index}`));
  const result = await Promise.allSettled(requests.map((input) => paidRequest(input, send)));
  assert.equal(calls, 1);
  assert.equal(result.filter((value) => value.status === "fulfilled").length, 1);
  assert.ok(result.some((value) => value.status === "rejected" && value.reason instanceof BudgetExceededError));
  const won = result.findIndex((value) => value.status === "fulfilled");
  await sql`UPDATE budgets SET per_minute=0 WHERE service=${bucket}`;
  assert.equal((await paidRequest(requests[won]!, send)).reused, true);
  assert.equal(calls, 1);
  await ensureModelBudget(bucket);
  assert.equal((await sql`SELECT per_minute FROM budgets WHERE service=${bucket}`)[0]!.per_minute, 0);
  await assert.rejects(paidRequest(request(services[1]!, "stopped"), send), BudgetExceededError);
  const rows = await sql`SELECT service,quota_service FROM receipt_attempts WHERE quota_service=${bucket}`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.service, requests[won]!.service, "billing identity is retained");
});
test("retries count once per actual send in rolling windows, including a send by another connection", async () => {
  const bucket = "model:retry.invalid";
  await ensureModelBudget(bucket);
  await sql`UPDATE budgets SET per_minute=2,per_hour=2,per_day=2 WHERE service=${bucket}`;
  let calls = 0;
  const input = request(services[0]!, "retry", bucket);
  await assert.rejects(
    paidRequest(input, async () => {
      calls++;
      throw new ProviderRejectedError("synthetic rejection", 429, true);
    }),
    ProviderRejectedError,
  );
  await paidRequest(input, async () => {
    calls++;
    return { response: { ok: true } };
  });
  await assert.rejects(
    paidRequest(request(services[1]!, "third", bucket), async () => {
      calls++;
      return { response: {} };
    }),
    BudgetExceededError,
  );
  assert.equal(calls, 2);
  await sql`UPDATE receipt_attempts SET started_at=now()-interval '25 hours' WHERE quota_service=${bucket}`;
  await paidRequest(request(services[1]!, "after-window", bucket), async () => {
    calls++;
    return { response: {} };
  });
  assert.equal(calls, 3);
});

test("matching old attempt snapshots are counted even when a quota blocks the next send, without rewriting cost or reuse identity", async () => {
  const bucket = "model:migrated.invalid",
    service = services[0]!;
  await ensureModelBudget(bucket);
  await sql`UPDATE budgets SET per_minute=1,per_hour=1,per_day=1 WHERE service=${bucket}`;
  const old = {
    service,
    lane: "news" as const,
    purpose: "quota_legacy",
    subject: "synthetic:quota-legacy",
    identity: "same old input",
    modelSnapshot: { connection_id: null, connection_revision: null, key_fingerprint: null, configuration_hash: "a".repeat(64) },
  };
  let calls = 0;
  const first = await paidRequest(old, async () => {
    calls++;
    return { response: { old: true }, cost: { amount: "0.12", currency: "CNY", basis: "actual" as const } };
  });
  await sql`UPDATE receipt_attempts SET quota_service=NULL WHERE id=${first.attemptId!}`;
  const [before] = await sql`SELECT logical_key FROM receipts WHERE id=${first.receiptId}`;
  await assert.rejects(
    paidRequest({ ...old, budgetService: bucket, identity: "next input" }, async () => {
      calls++;
      return { response: {} };
    }),
    BudgetExceededError,
  );
  assert.equal(calls, 1);
  const [attempt] = await sql`SELECT quota_service,service,cost,currency FROM receipt_attempts WHERE id=${first.attemptId!}`;
  assert.equal(attempt!.quota_service, bucket);
  assert.equal(attempt!.service, service);
  assert.equal(Number(attempt!.cost), 0.12);
  assert.equal(attempt!.currency, "CNY");
  assert.equal(
    (
      await paidRequest({ ...old, budgetService: bucket }, async () => {
        throw new Error("paid output must be reused");
      })
    ).receiptId,
    first.receiptId,
  );
  assert.equal((await sql`SELECT logical_key FROM receipts WHERE id=${first.receiptId}`)[0]!.logical_key, before!.logical_key);
});

test("the settings page reports the shared service total rather than separate connection totals", async () => {
  const { listBudgets } = await import("@amp/backend/admin/settings");
  const rows = await listBudgets(),
    row = rows.find((value) => value.service === "model:fixture.invalid");
  assert.equal(row!.used_day, 1);
  assert.equal(row!.used_hour, 1);
  assert.equal(row!.per_minute, 0);
});
