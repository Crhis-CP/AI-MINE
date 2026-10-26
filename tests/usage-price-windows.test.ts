import "./setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { beijingDate } from "@amp/contracts/time";
import { priceQuote, settleQuotedCost, usagePriceId, type Price, type UsageQuote } from "../packages/backend/src/providers/usage-pricing.ts";
import { authorizeUsageSend, reserveUsageAttempt } from "../packages/backend/src/providers/usage-protection.ts";
import { paidRequest } from "@amp/backend/providers/receipts";
import { buildMonthlyUsage } from "../packages/backend/src/operations/usage-monthly.ts";

const price: Price = {
  service: "window-fixture",
  model: "",
  configuration_hash: null,
  currency: "CNY",
  input_per_million_micros: "2000000",
  cache_hit_input_per_million_micros: "40000",
  output_per_million_micros: "8000000",
  per_request_micros: null,
  max_request_micros: null,
  image_input_token_bound: null,
  protocol_input_token_allowance: 0,
  basis_url: "https://example.invalid/price",
  observed_on: "2026-10-23",
  valid_until: "2026-10-24",
  rate_windows: [
    {
      starts_at: "2026-10-23T00:00:00Z",
      ends_at: "2026-10-23T08:00:00Z",
      input_per_million_micros: "1000000",
      cache_hit_input_per_million_micros: "20000",
      output_per_million_micros: "4000000",
    },
  ],
};
const usage = { prompt_tokens: 1000, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400, completion_tokens: 100 };
const input = { service: price.service, bounds: { input_tokens: 1000, output_tokens: 100 } };
const id = usagePriceId(price.service, "", null);
const store = (p = price, version = 1) =>
  sql`INSERT INTO ai.usage_prices(id,version,price) VALUES(${id},${version},${sql.json(p)}) ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,price=EXCLUDED.price`;
const at = async (instant: string) => (await priceQuote(sql, input, new Date(instant))).quote!;
async function pending(quote: UsageQuote, legacyTask?: { key: string; limit_micros: string }) {
  const key = crypto.randomUUID();
  const [r] = await sql`INSERT INTO receipts(logical_key,service,purpose,status) VALUES(${key},'window-fixture','fixture_capability','pending') RETURNING id`;
  const [a] = await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,status) VALUES(${r!.id},1,'window-fixture','pending') RETURNING id::text`;
  await sql.begin((tx) =>
    reserveUsageAttempt(
      tx,
      a!.id,
      Number(r!.id),
      { context: { lane: "news", capability: "fixture_capability", sourceIds: [], object: null }, logicalKey: key, quote, configVersion: 0 },
      new Date(quote.quoted_at!),
    ),
  );
  if (legacyTask) await sql`UPDATE ai.usage_attempts SET task_key=${legacyTask.key},task_limit_micros=${legacyTask.limit_micros} WHERE attempt_id=${a!.id}`;
  return a!.id;
}
beforeEach(async () => {
  await sql`TRUNCATE receipts CASCADE`;
  await sql`TRUNCATE ai.usage_prices,ai.usage_sums,ai.usage_control_versions,ai.usage_protection_events`;
  await store();
});
after(closeDb);

test("quotes freeze the selected window and version; boundary completion and later price changes cannot reprice them", async () => {
  const base = await at("2026-10-22T23:59:59Z"),
    discounted = await at("2026-10-23T00:00:00Z"),
    end = await at("2026-10-23T08:00:00Z");
  assert.equal(base.rate_window, null);
  assert.deepEqual(discounted.rate_window, price.rate_windows![0]);
  assert.equal(end.rate_window, null);
  assert.equal(discounted.quoted_at, "2026-10-23T00:00:00.000Z");
  assert.equal(settleQuotedCost(base, usage, null)?.micros, 1624n);
  assert.equal(settleQuotedCost(discounted, usage, null)?.micros, 812n);
  await store({ ...price, input_per_million_micros: "999000000" }, 2);
  assert.equal(discounted.price_version, 1);
  assert.equal(settleQuotedCost(discounted, usage, null)?.micros, 812n);
  assert.equal(settleQuotedCost(JSON.parse(JSON.stringify(discounted)), usage, null)?.micros, 812n);
  assert.equal((await priceQuote(sql, input, new Date("2026-10-24T16:00:00Z"))).quote, null);
});

test("cache evidence must be complete and conserved; legacy quotes and actual bills keep their meanings", async () => {
  const q = await at("2026-10-23T01:00:00Z");
  for (const patch of [
    { prompt_cache_hit_tokens: undefined },
    { prompt_cache_miss_tokens: undefined },
    { prompt_cache_miss_tokens: 401 },
    { prompt_cache_hit_tokens: -1 },
    { prompt_cache_hit_tokens: 0.5 },
    { prompt_tokens_details: { cached_tokens: 601 } },
    { prompt_tokens: undefined, total_tokens: 1100 },
    { input_tokens: 9999 },
    { input_tokens: 1000 },
    { output_tokens: 100 },
    { cache_read_input_tokens: 600 },
  ])
    assert.equal(settleQuotedCost(q, { ...usage, ...patch }, null), null);
  const legacy: UsageQuote = {
    price_id: id,
    price_version: 1,
    price: { ...price, cache_hit_input_per_million_micros: undefined, rate_windows: undefined },
    bounds: input.bounds,
    reserved_micros: "2800",
  };
  assert.equal(settleQuotedCost(legacy, usage, null)?.micros, 2800n);
  assert.equal(settleQuotedCost({ ...legacy, price }, usage, null), null);
  assert.equal(settleQuotedCost(q, null, { amount: "0", currency: "CNY", basis: "actual" })?.micros, 0n);
  assert.equal(settleQuotedCost(q, usage, { amount: "1", currency: "USD", basis: "actual" }), null);
});

test("actual advisory-lock waiting crosses the window before the dispatch snapshot is frozen", async (t) => {
  const attemptId = await pending(await at("2026-10-23T07:59:59Z"));
  let release!: () => void, ready!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    locked = new Promise<void>((resolve) => {
      ready = resolve;
    });
  const holder = sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('usage-protection'))`;
    ready();
    await gate;
  });
  await locked;
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-23T07:59:59Z") });
  const sending = sql.begin((tx) => authorizeUsageSend(tx, attemptId));
  try {
    const deadline = performance.now() + 3000;
    while (!(await sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory') AS blocked`)[0]!.blocked) {
      assert.ok(performance.now() < deadline, "dispatch must really wait on the advisory lock");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    t.mock.timers.setTime(Date.parse("2026-10-23T08:00:01Z"));
    release();
    assert.equal(await sending, null);
    const [row] = await sql`SELECT quote,reserved_micros::text FROM ai.usage_attempts WHERE attempt_id=${attemptId}`;
    assert.equal(row!.quote.quoted_at, "2026-10-23T08:00:01.000Z");
    assert.equal(row!.quote.rate_window, null);
    assert.equal(row!.reserved_micros, "2800");
  } finally {
    release();
    await holder;
    await sending;
    t.mock.timers.reset();
  }
});

test("reservation uses the larger cache rate and rounding happens after adding input and output", async () => {
  await store({ ...price, rate_windows: [], cache_hit_input_per_million_micros: "3000000" });
  assert.equal((await at("2026-10-23T01:00:00Z")).reserved_micros, "3800");
  await store({
    ...price,
    rate_windows: [],
    cache_hit_input_per_million_micros: null,
    input_per_million_micros: "500000",
    output_per_million_micros: "500000",
  });
  assert.equal(settleQuotedCost(await at("2026-10-23T01:00:00Z"), { prompt_tokens: 1, completion_tokens: 1 }, null)?.micros, 1n);
});

test("received content and free reuse survive unpriced cache usage; receipts use the same settled amount", async () => {
  const day = beijingDate(new Date()),
    tomorrow = beijingDate(new Date(Date.now() + 86400000));
  await store({ ...price, observed_on: day, valid_until: tomorrow, rate_windows: [] });
  let calls = 0;
  const req = (key: string) => ({
    service: input.service,
    costBounds: input.bounds,
    purpose: "fixture_capability",
    identity: { key },
    lane: "news" as const,
    usageContext: { lane: "news" as const, capability: "fixture_capability", sourceIds: [], object: null },
  });
  const good = await paidRequest(req("complete"), async () => ({ response: { ok: true }, usage }));
  const send = async () => {
    calls++;
    return {
      response: { ok: true },
      usage: { prompt_tokens: 1000, completion_tokens: 100 },
      cost: { amount: "99", currency: "CNY", basis: "estimated" as const },
    };
  };
  const bad = await paidRequest(req("missing"), send);
  assert.deepEqual(bad.response, { ok: true });
  assert.equal((await paidRequest(req("missing"), send)).reused, true);
  assert.equal(calls, 1);
  const rows =
    await sql`SELECT r.id,r.status,r.cost::text,r.cost_basis,u.state,u.settled_micros::text,u.quote FROM receipts r JOIN ai.usage_attempts u ON u.receipt_id=r.id ORDER BY r.id`;
  assert.equal(rows.find((r) => Number(r.id) === good.receiptId)!.cost, "0.001624");
  const unknown = rows.find((r) => Number(r.id) === bad.receiptId)!;
  assert.equal(unknown.status, "received");
  assert.equal(unknown.cost, null);
  assert.equal(unknown.state, "unknown");
  assert.match(unknown.quote.settlement_issue, /缓存/);
  assert.equal(rows.find((r) => Number(r.id) === good.receiptId)!.settled_micros, "1624");
  const report = await buildMonthlyUsage(day.slice(0, 7), new Date(Date.now() + 40 * 86400000));
  assert.equal(report.totals.amounts[0]!.estimated, "0.001624");
  assert.equal(report.totals.unpriced_calls, 1);
});

test("only an unsubmitted attempt updates its frozen window and reservation across a boundary", async () => {
  const q = await at("2026-10-22T23:59:59Z");
  const attemptId = await pending(q);
  assert.equal(await sql.begin((tx) => authorizeUsageSend(tx, attemptId, () => new Date("2026-10-23T00:00:00Z"))), null);
  const [sent] = await sql`SELECT quote,reserved_micros::text FROM ai.usage_attempts WHERE attempt_id=${attemptId}`;
  assert.equal(sent!.reserved_micros, "1400");
  assert.deepEqual(sent!.quote.rate_window, price.rate_windows![0]);
  await sql.begin((tx) => authorizeUsageSend(tx, attemptId, () => new Date("2026-10-23T08:00:00Z")));
  const [again] = await sql`SELECT quote FROM ai.usage_attempts WHERE attempt_id=${attemptId}`;
  assert.deepEqual(again!.quote, sent!.quote);
});

test("retired historical caps do not block repricing and remain recorded; expired prices stay unpriced", async () => {
  const q = await at("2026-10-23T01:00:00Z");
  const legacy = await pending(q, { key: "synthetic-window-cap", limit_micros: "2000" });
  assert.equal(await sql.begin((tx) => authorizeUsageSend(tx, legacy, () => new Date("2026-10-23T08:00:00Z"))), null);
  const [old] = await sql`SELECT submitted,reserved_micros::text,task_key,task_limit_micros::text FROM ai.usage_attempts WHERE attempt_id=${legacy}`;
  assert.equal(old!.submitted, true);
  assert.equal(old!.reserved_micros, "2800");
  assert.equal(old!.task_key, "synthetic-window-cap");
  assert.equal(old!.task_limit_micros, "2000");
  const ordinary = await pending(q);
  assert.equal(await sql.begin((tx) => authorizeUsageSend(tx, ordinary, () => new Date("2026-10-25T00:00:00Z"))), null);
  const [sent] = await sql`SELECT quote,submitted FROM ai.usage_attempts WHERE attempt_id=${ordinary}`;
  assert.equal(sent!.submitted, true);
  assert.match(sent!.quote.pricing_issue, /过期/);
  assert.equal(settleQuotedCost(sent!.quote, usage, null), null);
});
