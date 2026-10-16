import { test } from "node:test";
import assert from "node:assert/strict";
import { FeedItemSummary, PoolResponse, TimelineCard } from "../src/http/public.ts";
import { normalizeSourceTime } from "../src/time-assertion.ts";
const legacy = {
  id: "item",
  title: "合成矿业新闻",
  summary: null,
  reason: null,
  publishedAt: null,
  timelineAt: "2026-10-15T01:00:00Z",
  category: null,
  tags: [],
  score: null,
  selected: false,
  channel: "news",
  source: { name: "合成来源" },
};
const day = normalizeSourceTime(
  {
    meaning: "published",
    raw: "2026-10-14",
    local_date: "2026-10-14",
    local_time: null,
    timezone: null,
    utc: null,
    precision: "date",
    basis: "来源标注日期",
    condition_text: null,
  },
  { instantBasis: null, timezoneEvidence: null },
);
test("legacy feed fields remain valid and absent time evidence stays absent", () => {
  const parsed = FeedItemSummary.parse(legacy);
  assert.deepEqual(parsed, legacy);
  assert.equal("sourceTime" in parsed, false);
  assert.equal(PoolResponse.shape.items.safeParse([legacy]).success, true);
  assert.equal(TimelineCard.shape.item.safeParse(legacy).success, true);
});
test("optional source dates preserve their precision without an invented source clock", () => {
  const item = FeedItemSummary.parse({ ...legacy, sourceTime: day, firstPublicAt: "2026-10-15T01:02:00Z" });
  assert.equal(item.sourceTime?.precision, "date");
  assert.equal(item.sourceTime?.utc, null);
  assert.equal(item.sourceTime?.local_date, "2026-10-14");
  assert.notEqual(item.sourceTime?.local_date, item.firstPublicAt?.slice(0, 10));
  assert.equal(FeedItemSummary.safeParse({ ...legacy, sourceTime: { ...day, utc: "2026-10-14T00:00:00Z" } }).success, false);
  assert.equal(FeedItemSummary.parse({ ...legacy, sourceTime: null }).sourceTime, null);
});
