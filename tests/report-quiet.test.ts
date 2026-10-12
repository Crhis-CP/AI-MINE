// An empty report window stays missing. The 08:00 boundary is not extended, and a quiet sentence is not published.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("an empty daily window is not published, and today's window still ends at 08:00", () => {
  const paper = readFileSync(new URL("../apps/web/app/features/report/ReportPaper.tsx", import.meta.url), "utf8");
  const compose = readFileSync(new URL("../packages/backend/src/reports/compose.ts", import.meta.url), "utf8");
  assert.doesNotMatch(paper, /今日安静/);
  assert.doesNotMatch(compose, /今日安静|dailyWindow|sameDayArchive|QUIET_ISSUE/);
  assert.match(compose, /ordered\.length === 0 && flashes\.length === 0\) return/);
  assert.match(compose, /beijingMidnight\(date\)\.getTime\(\) \+ 8 \* 3600 \* 1000/);
  assert.match(compose, /!exists && \(await freshDailyCount\(d\)\) > 0/);
  assert.doesNotMatch(compose, /todayMissingKeys/);
});
