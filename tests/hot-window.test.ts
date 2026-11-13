// The hot list's window (TASK-0642, Owner 2026-11-13): 72 hours every day, and every qualified event listed.
// Until then the window was 48 hours, 72 only on Beijing Saturday to Monday (TASK-0599), and the list stopped at 10.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HOT_MAX_ENTRIES, HOT_RULE_VERSION, hotWindowHours } from "../packages/backend/src/events/hot.ts";

test("the hot window is 72 hours on every day of the week", () => {
  // 2026-11-09 is a Monday. Times are UTC; Beijing is UTC+8.
  for (let day = 0; day < 7; day++) {
    for (const hour of [0, 4, 15, 16, 23]) {
      const at = new Date(Date.UTC(2026, 10, 9 + day, hour, 30));
      assert.equal(hotWindowHours(at), 72, at.toISOString());
    }
  }
});

test("the rule version names the 72-hour window and the uncapped list", () => {
  assert.equal(HOT_RULE_VERSION, "heat-v4-72h-halflife24h-all");
  assert.ok(HOT_MAX_ENTRIES >= 50, "the list is bounded only against runaway data");
});
