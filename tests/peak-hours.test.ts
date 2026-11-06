import assert from "node:assert/strict";
import { test } from "node:test";
import { isProviderPeak, nextOffPeakStart, PROVIDER_PEAK_WINDOWS_UTC } from "../packages/backend/src/providers/peak-hours.ts";

const at = (iso: string) => new Date(iso);

test("DeepSeek peak windows are weekday 01:00–04:00 and 06:00–10:00 UTC; everything else, weekends included, is off-peak", () => {
  assert.deepEqual(
    PROVIDER_PEAK_WINDOWS_UTC.map((w) => [w.startHour, w.endHour]),
    [
      [1, 4],
      [6, 10],
    ],
  );
  // 2026-11-05 is a Thursday.
  for (const iso of ["2026-11-05T01:00:00Z", "2026-11-05T03:59:59.999Z", "2026-11-05T06:00:00Z", "2026-11-05T09:30:00Z"])
    assert.equal(isProviderPeak(at(iso)), true, iso);
  for (const iso of ["2026-11-05T00:59:59.999Z", "2026-11-05T04:00:00Z", "2026-11-05T05:59:59Z", "2026-11-05T10:00:00Z", "2026-11-05T23:00:00Z"])
    assert.equal(isProviderPeak(at(iso)), false, iso);
  // Saturday and Sunday are off-peak all day; Monday and Friday are weekdays.
  for (const iso of ["2026-11-07T02:00:00Z", "2026-11-08T07:00:00Z"]) assert.equal(isProviderPeak(at(iso)), false, iso);
  assert.equal(isProviderPeak(at("2026-11-09T02:00:00Z")), true);
  assert.equal(isProviderPeak(at("2026-11-06T09:59:00Z")), true);
});

test("nextOffPeakStart returns the end of the current peak window, or the same instant when already off-peak", () => {
  assert.equal(nextOffPeakStart(at("2026-11-05T01:15:00Z")).toISOString(), "2026-11-05T04:00:00.000Z");
  assert.equal(nextOffPeakStart(at("2026-11-05T06:00:00Z")).toISOString(), "2026-11-05T10:00:00.000Z");
  assert.equal(nextOffPeakStart(at("2026-11-05T09:59:59.999Z")).toISOString(), "2026-11-05T10:00:00.000Z");
  assert.equal(nextOffPeakStart(at("2026-11-05T04:30:00Z")).toISOString(), "2026-11-05T04:30:00.000Z");
  assert.equal(nextOffPeakStart(at("2026-11-07T07:00:00Z")).toISOString(), "2026-11-07T07:00:00.000Z");
  for (let minute = 0; minute < 7 * 24 * 60; minute += 7) {
    const now = new Date(Date.UTC(2026, 10, 2) + minute * 60_000),
      next = nextOffPeakStart(now);
    assert.equal(isProviderPeak(next), false);
    assert.ok(next.getTime() >= now.getTime() && next.getTime() - now.getTime() <= 4 * 3_600_000);
  }
  assert.throws(() => isProviderPeak(new Date(Number.NaN)));
});
