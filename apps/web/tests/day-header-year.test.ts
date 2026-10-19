import assert from "node:assert/strict";
import { test } from "node:test";
import { beijingDate, monthDay } from "@amp/contracts/time";

test("timeline day headers distinguish archive years while keeping this year's dates concise", () => {
  assert.equal(monthDay("2026-10-05", "2026-10-19"), "10月5日");
  assert.equal(monthDay("2019-02-19", "2026-10-19"), "2019年2月19日");
  assert.equal(monthDay("2027-01-03", "2026-12-31"), "2027年1月3日");
  assert.equal(monthDay("2025-12-31", beijingDate("2025-12-31T16:01:00Z")), "2025年12月31日");
});

test("calendar labels without a comparison date remain month and day", () => {
  assert.equal(monthDay("2019-02-19"), "2月19日");
});
