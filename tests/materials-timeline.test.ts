// The timeline rule for a source that states only the day (PG-01; AGENTS rule 12): the item goes on that
// day at its start (after the day's timed items) with no time of day invented, an old day is history and
// never news of the day it was found, and exact times keep the existing rule.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@amp/backend/db";
import { decideTimeline, sourceDayStart } from "@amp/backend/content/materials";

after(async () => {
  await closeDb();
});

const found = new Date("2026-10-05T20:30:00Z"); // 2026-10-06 04:30 in Beijing

test("a source day is Beijing midnight of that date; anything else is no day", () => {
  assert.equal(sourceDayStart("2026-10-06")!.toISOString(), "2026-10-05T16:00:00.000Z");
  for (const bad of [null, undefined, "", "2026-10", "06/10/2026"]) assert.equal(sourceDayStart(bad), null, String(bad));
});

test("a day-only item goes on its stated day; an old day is history, a new source's import stays history", () => {
  const firstImport = decideTimeline(null, found, "first-import", sourceDayStart("2026-08-27"));
  assert.deepEqual([firstImport.publishedAt, firstImport.timelineAt.toISOString(), firstImport.backfill], [null, "2026-08-26T16:00:00.000Z", true]);
  const today = decideTimeline(null, found, null, sourceDayStart("2026-10-06"));
  assert.deepEqual([today.timelineAt.toISOString(), today.backfill], ["2026-10-05T16:00:00.000Z", false], "today's day-only item is today's news");
  const stale = decideTimeline(null, found, null, sourceDayStart("2026-09-20"));
  assert.deepEqual([stale.timelineAt.toISOString(), stale.backfill, stale.backfillReason], ["2026-09-19T16:00:00.000Z", true, "stale-on-discovery"]);
});

test("exact times keep the rule; a stated day after discovery is ignored", () => {
  const exact = new Date(found.getTime() - 3600_000);
  assert.deepEqual(decideTimeline(exact, found, null, sourceDayStart("2026-08-27")).timelineAt, found, "a live timed item stays at discovery");
  assert.deepEqual(decideTimeline(exact, found, "first-import").timelineAt, exact, "a timed backfill is archived by its time");
  assert.deepEqual(decideTimeline(null, found, null, sourceDayStart("2026-10-08")).timelineAt, found);
  assert.deepEqual(decideTimeline(null, found).timelineAt, found);
});
