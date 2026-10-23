import { test } from "node:test";
import assert from "node:assert/strict";
import { UsagePrice } from "../src/http/usage-protection.ts";

const price = {
  service: "synthetic-model",
  model: "test",
  configuration_hash: null,
  currency: "CNY",
  input_per_million_micros: "2000000",
  output_per_million_micros: "8000000",
  per_request_micros: null,
  max_request_micros: null,
  image_input_token_bound: null,
  protocol_input_token_allowance: 0,
  basis_url: "https://example.invalid/pricing",
  observed_on: "2026-10-23",
  valid_until: "2026-10-24",
};
const window = {
  starts_at: "2026-10-22T16:00:00Z",
  ends_at: "2026-10-23T00:00:00Z",
  input_per_million_micros: "1000000",
  cache_hit_input_per_million_micros: "20000.01",
  output_per_million_micros: "4000000",
};

test("legacy prices stay byte-for-byte shaped and empty windows do not invent cache pricing", () => {
  assert.deepEqual(UsagePrice.parse(price), price);
  assert.deepEqual(UsagePrice.parse({ ...price, rate_windows: [] }), { ...price, rate_windows: [] });
  assert.deepEqual(UsagePrice.parse({ ...price, cache_hit_input_per_million_micros: null }), { ...price, cache_hit_input_per_million_micros: null });
  assert.equal(UsagePrice.parse({ ...price, cache_hit_input_per_million_micros: "0" }).cache_hit_input_per_million_micros, "0");
});

test("explicit UTC windows preserve decimal rates and allow adjacent boundaries through the inclusive Beijing validity day", () => {
  const value = {
    ...price,
    cache_hit_input_per_million_micros: "40000.02",
    rate_windows: [window, { ...window, starts_at: window.ends_at, ends_at: "2026-10-24T16:00:00Z", cache_hit_input_per_million_micros: null }],
  };
  assert.deepEqual(UsagePrice.parse(value), value);
});

test("malformed, reversed, overlapping, unordered and out-of-validity windows are rejected", () => {
  for (const patch of [
    { starts_at: window.ends_at },
    { starts_at: "2026-10-22T15:59:59Z" },
    { ends_at: "2026-10-24T16:00:01Z" },
    { starts_at: "2026-10-23T00:00:00+08:00" },
    { starts_at: "2026-10-23T00:00:00.001Z" },
    { ends_at: "2026-02-30T00:00:00Z" },
    { input_per_million_micros: null },
    { cache_hit_input_per_million_micros: undefined },
    { cache_hit_input_per_million_micros: "-1" },
    { output_per_million_micros: "1.001" },
  ])
    assert.equal(UsagePrice.safeParse({ ...price, rate_windows: [{ ...window, ...patch }] }).success, false, JSON.stringify(patch));
  const bounded = Array.from({ length: 129 }, (_, i) => ({
    ...window,
    starts_at: new Date(Date.parse(window.starts_at) + i * 1000).toISOString().replace(".000", ""),
    ends_at: new Date(Date.parse(window.starts_at) + (i + 1) * 1000).toISOString().replace(".000", ""),
  }));
  assert.equal(UsagePrice.safeParse({ ...price, rate_windows: bounded.slice(0, 128) }).success, true);
  for (const windows of [
    [window, { ...window, starts_at: "2026-10-22T20:00:00Z" }],
    [{ ...window, starts_at: window.ends_at, ends_at: "2026-10-23T08:00:00Z" }, window],
    bounded,
  ])
    assert.equal(UsagePrice.safeParse({ ...price, rate_windows: windows }).success, false);
});

test("new token rates require base token prices while request-only legacy prices and date checks remain", () => {
  const fixed = { ...price, input_per_million_micros: null, output_per_million_micros: null, per_request_micros: "5" };
  assert.deepEqual(UsagePrice.parse(fixed), fixed);
  assert.equal(UsagePrice.safeParse({ ...fixed, cache_hit_input_per_million_micros: "1" }).success, false);
  assert.equal(UsagePrice.safeParse({ ...fixed, rate_windows: [window] }).success, false);
  for (const observed_on of ["2026-02-30", "2026-10-24", "2026-08-01"]) assert.equal(UsagePrice.safeParse({ ...price, observed_on }).success, false);
});
