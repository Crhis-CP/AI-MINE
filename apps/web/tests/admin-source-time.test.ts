// The admin pages show a source's own time the way the reader site does (Owner 2026-10-05: 只显示日期;
// TASK-0058): a source that gave only the date is kept at the start of that Beijing day (TASK-0040), so the
// article's 原文时间 and 时间轴 and the trial-fetch samples show that date alone, never "00:00".
// Pure functions; no web build needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bj, bjSource } from "../app/features/admin/format.ts";

const dayStart = "2026-09-23T16:00:00.000Z"; // 2026-09-24 00:00:00 in Beijing

test("exactly 00:00:00 in Beijing is the date alone, with and without the year", () => {
  assert.equal(bjSource(dayStart, true), "2026-09-24");
  assert.equal(bjSource(dayStart), "09-24");
  assert.equal(bjSource(new Date(dayStart), true), "2026-09-24");
});

test("any other time is written to the minute, the same as bj()", () => {
  const cases: Array<[string, string]> = [
    ["2026-09-23T16:01:00.000Z", "2026-09-24 00:01"],
    ["2026-09-23T16:00:30.000Z", "2026-09-24 00:00"], // 30 seconds past midnight is a real time
    ["2026-09-24T00:00:00.000Z", "2026-09-24 08:00"], // UTC midnight is 08:00 in Beijing
    ["2026-09-24T02:51:00.000Z", "2026-09-24 10:51"],
  ];
  for (const [iso, shown] of cases) {
    assert.equal(bjSource(iso, true), shown);
    assert.equal(bjSource(iso, true), bj(iso, true));
    assert.equal(bjSource(iso), bj(iso));
  }
});

test("empty and invalid values are a dash, as in bj()", () => {
  for (const value of [null, undefined, "", "not a date"]) {
    assert.equal(bjSource(value, true), "—");
    assert.equal(bjSource(value, true), bj(value, true));
  }
});
