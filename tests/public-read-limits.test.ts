import assert from "node:assert/strict";
import { test } from "node:test";
import { publicReadLimiter } from "../apps/api/src/http/public-limits.ts";
test("anonymous read limits are per client and recover at the next window", () => {
  let now = 1_000;
  const limited = publicReadLimiter("synthetic-key", 2, () => now);
  assert.equal(limited("a"), 0);
  assert.equal(limited("a"), 0);
  assert.equal(limited("a"), 59);
  assert.equal(limited("b"), 0);
  now = 60_000;
  assert.equal(limited("a"), 0);
});
