import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { closeDb, dbOf } from "@amp/backend/db";
import { buildMonthlyUsage, reconcileMonthlyUsage, monthlyUsageReports, usageMonthPeriod } from "../packages/backend/src/operations/usage-monthly.ts";
import { recordLocalReuse } from "../packages/backend/src/providers/usage-accounting.ts";
import { paidRequest } from "@amp/backend/providers/receipts";
const sql = dbOf("ai-gateway"),
  now = new Date("2026-10-09T00:00:00Z");
after(closeDb);
async function attempt(input: {
  status?: string;
  cost?: string;
  basis?: string;
  currency?: string;
  usage?: Record<string, unknown>;
  origin?: string;
  at?: string;
  lane?: string;
  subject?: string;
}) {
  const [receipt] =
    await sql`INSERT INTO receipts(logical_key,service,purpose,subject,status,request) VALUES(${randomUUID()},'synthetic','structure',${input.subject ?? "article:synthetic@1"},'completed',${sql.json(input.lane ? { lane: input.lane } : {})}) RETURNING id`;
  await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,origin,status,cost,cost_basis,currency,usage,started_at) VALUES(${receipt.id},1,'synthetic','synthetic-model',${input.origin ?? "live"},${input.status ?? "received"},${input.cost ?? null},${input.basis ?? null},${input.currency ?? null},${sql.json((input.usage ?? null) as never)},${new Date(input.at ?? "2026-09-10T00:00:00Z")})`;
  return Number(receipt.id);
}
test("monthly physical accounting keeps currencies, actual/estimated/unknown amounts and cache absence separate", async () => {
  assert.equal(usageMonthPeriod("2026-09").start.toISOString(), "2026-08-31T16:00:00.000Z");
  assert.equal(usageMonthPeriod("2026-12").end.toISOString(), "2026-12-31T16:00:00.000Z");
  await assert.rejects(buildMonthlyUsage("2026-10", now), /still open/);
  await attempt({
    lane: "news",
    cost: "0.123456",
    basis: "actual",
    currency: "USD",
    usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 64 } },
  });
  await attempt({
    lane: "policy",
    cost: "0.200000",
    basis: "estimated",
    currency: "USD",
    usage: { prompt_tokens: 200, completion_tokens: 10, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 200 },
  });
  await attempt({ cost: "1.000001", basis: "actual", currency: "CNY" });
  await attempt({ status: "unknown" });
  await attempt({ status: "pending" });
  await attempt({ cost: "999", basis: "actual", currency: "USD", origin: "replay" });
  await attempt({ cost: "999", basis: "actual", currency: "USD", at: "2026-09-30T16:00:00Z" });
  const report = await buildMonthlyUsage("2026-09", now);
  assert.equal(report.totals.calls, 5);
  assert.equal(report.totals.unknown, 1);
  assert.equal(report.totals.pending, 1);
  assert.equal(report.totals.unpriced_calls, 2);
  assert.deepEqual(report.totals.amounts, [
    { currency: "CNY", actual: "1.000001", estimated: "0.000000" },
    { currency: "USD", actual: "0.123456", estimated: "0.200000" },
  ]);
  assert.equal(report.totals.provider_cache_tokens, 64);
  assert.equal(report.totals.provider_cache_reported_calls, 2);
  assert.equal(report.totals.provider_cache_miss_tokens, 200);
  assert.equal(report.totals.cache_pair_reported_calls, 1);
  assert.equal(report.totals.cache_hit_rate, 0);
  assert.equal(report.totals.token_reported_calls, 2);
  assert.equal(report.by_lane.find((g) => g.key === "unknown")!.totals.calls, 3);
  assert.equal(report.local_reuse.recorded_count, null);
  assert.equal(report.local_reuse.coverage, "none");
  await sql`UPDATE ai.usage_observation SET reuse_started_at='2026-09-01T00:00:00+08:00'`;
  await sql.begin((tx) => recordLocalReuse(tx, { service: "synthetic", purpose: "structure", lane: "news" }, new Date("2026-09-10Z")));
  const observed = await buildMonthlyUsage("2026-09", now);
  assert.equal(observed.local_reuse.recorded_count, 1);
  assert.equal(observed.local_reuse.coverage, "complete");
  assert.equal(observed.totals.calls, 5, "a local reuse does not become another physical paid call");
});
test("a month is delivered once, reconciliation revises history and unknown delivery is not resent", async () => {
  let calls = 0;
  const send = async () => {
    calls++;
    return "sent" as const;
  };
  await Promise.all([reconcileMonthlyUsage("2026-09", now, send), reconcileMonthlyUsage("2026-09", now, send)]);
  assert.equal(calls, 1);
  await sql`UPDATE receipt_attempts SET cost=0.5,cost_basis='actual',currency='USD',status='received' WHERE status='unknown'`;
  const corrected = await reconcileMonthlyUsage("2026-09", new Date("2026-10-09T01:00Z"), send);
  assert.equal(corrected.revision, 2);
  assert.equal(corrected.updated_after_issue, true);
  assert.equal(corrected.notification_state, "sent");
  assert.equal(calls, 1);
  const uncertain = await reconcileMonthlyUsage("2026-08", now, async () => {
    throw new Error("Synthetic delivery timeout");
  });
  assert.equal(uncertain.notification_state, "unknown");
  await reconcileMonthlyUsage("2026-08", now, send);
  assert.equal(calls, 1);
  assert.equal((await monthlyUsageReports()).length, 2);
});

test("actual receipt reuse increments the local counter atomically without another physical attempt", async () => {
  let calls = 0;
  const request = {
    service: "synthetic-local-reuse",
    model: "synthetic",
    purpose: "structure",
    lane: "policy" as const,
    subject: "policy:synthetic-reuse",
    identity: { input: "synthetic-only" },
  };
  const run = () =>
    paidRequest(request, async () => {
      calls++;
      return { response: { ok: true }, usage: { prompt_tokens: 1, completion_tokens: 1 } };
    });
  const first = await run();
  assert.equal(first.reused, false);
  const cached = await Promise.all(Array.from({ length: 8 }, run));
  assert.ok(cached.every((r) => r.reused));
  assert.equal(calls, 1);
  const [counter] = await sql`SELECT sum(count)::int n FROM ai.local_reuse_daily WHERE service='synthetic-local-reuse' AND lane='policy'`;
  assert.equal(counter.n, 8);
  const [attempts] = await sql`SELECT count(*)::int n FROM receipt_attempts WHERE receipt_id=${first.receiptId}`;
  assert.equal(attempts.n, 1);
});
