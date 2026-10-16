import assert from "node:assert/strict";
import { test } from "node:test";
import { StoryFollowupsResponse } from "../src/http/public.ts";
import type { StoryFollowup } from "../src/site.ts";
import { normalizeSourceTime } from "../src/time-assertion.ts";
const representative = { id: "synthetic", title: "合成进展", source: { name: "合成来源" }, timelineAt: "2026-10-16T01:00:00Z" };
const value = (extra: object = {}) => ({ items: [{ factId: "fact", representative: { ...representative, ...extra } }], more: false });
test("a follow-up keeps legacy time ordering and accepts explicit source date precision without adding defaults", () => {
  assert.ok(!("sourceTime" in StoryFollowupsResponse.parse(value()).items[0]!.representative));
  const time = normalizeSourceTime(
    {
      meaning: "published",
      raw: "2026-10-15",
      local_date: "2026-10-15",
      local_time: null,
      timezone: null,
      utc: null,
      precision: "date",
      basis: "原文日期",
      condition_text: null,
    },
    { instantBasis: null, timezoneEvidence: null },
  );
  const parsed = StoryFollowupsResponse.parse(value({ sourceTime: time }));
  assert.equal(parsed.items[0]!.representative.timelineAt, representative.timelineAt);
  const followup: StoryFollowup = parsed.items[0]!;
  assert.equal(followup.representative.sourceTime!.utc, null);
  assert.throws(() => StoryFollowupsResponse.parse(value({ sourceTime: { ...time, utc: "2026-10-15T00:00:00Z" } })));
});
