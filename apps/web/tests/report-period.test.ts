import assert from "node:assert/strict";
import { test } from "node:test";
import { expectedReportKey } from "../app/features/report/report-period.ts";

test("daily issue becomes due at Beijing 08:00", () => {
  assert.equal(expectedReportKey("daily", new Date("2026-10-12T07:59:59+08:00")), "2026-10-11");
  assert.equal(expectedReportKey("daily", new Date("2026-10-12T08:00:00+08:00")), "2026-10-12");
});
test("Monday 10:00 advances the previous complete ISO week", () => {
  assert.equal(expectedReportKey("weekly", new Date("2026-10-12T09:59:59+08:00")), "2026-W40");
  assert.equal(expectedReportKey("weekly", new Date("2026-10-12T10:00:00+08:00")), "2026-W41");
  assert.equal(expectedReportKey("weekly", new Date("2026-10-18T12:00:00+08:00")), "2026-W41");
});
test("monthly boundary uses 10:30 and handles the year transition", () => {
  assert.equal(expectedReportKey("monthly", new Date("2026-01-01T10:29:59+08:00")), "2025-11");
  assert.equal(expectedReportKey("monthly", new Date("2026-01-01T10:30:00+08:00")), "2025-12");
});
