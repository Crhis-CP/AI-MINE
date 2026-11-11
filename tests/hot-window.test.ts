// The hot list's window (TASK-0599, Owner 2026-11-08): 48 hours, but 72 on Beijing Saturday, Sunday and Monday,
// when overseas mining media publish little and a 48-hour window leaves the list nearly empty.
import assert from "node:assert/strict";
import { test } from "node:test";
import { hotWindowHours } from "../packages/backend/src/events/hot.ts";

test("the hot window is 72 hours on Beijing Saturday, Sunday and Monday, else 48", () => {
  // 2026-11-06 is a Friday. Times are UTC; Beijing is UTC+8.
  assert.equal(hotWindowHours(new Date("2026-11-06T15:59:00Z")), 48, "Friday 23:59 Beijing");
  assert.equal(hotWindowHours(new Date("2026-11-06T16:00:00Z")), 72, "Saturday 00:00 Beijing");
  assert.equal(hotWindowHours(new Date("2026-11-08T12:00:00Z")), 72, "Sunday 20:00 Beijing");
  assert.equal(hotWindowHours(new Date("2026-11-09T15:59:00Z")), 72, "Monday 23:59 Beijing");
  assert.equal(hotWindowHours(new Date("2026-11-09T16:00:00Z")), 48, "Tuesday 00:00 Beijing");
  assert.equal(hotWindowHours(new Date("2026-11-11T04:00:00Z")), 48, "Wednesday noon Beijing");
});
