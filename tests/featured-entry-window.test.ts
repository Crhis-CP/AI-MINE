// Featured entrance window (CHRIS 2026-10-10): three Beijing calendar months by archive date.
// Older picks leave the homepage list and keep the 精选 mark on 全部矿业动态. Daily issues are not rewritten.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { addCalendarMonths, beijingMidnight } from "@amp/contracts/time";
import { closeDb, sql } from "@amp/backend/db";
import { featuredEntryCondition, listedCondition } from "../packages/backend/src/publication/items.ts";
import { loadTimeline } from "@amp/backend/publication/timeline";
import { loadPool } from "@amp/backend/publication/pool";

const SOURCE = `test-featured-window-${tag()}`;
const NOW = new Date("2026-10-10T04:00:00.000Z");
const cutoff = beijingMidnight(addCalendarMonths("2026-10-10", -3));

after(async () => {
  await closeDb();
});

test("three calendar months clamp the day and use Beijing dates", () => {
  assert.equal(addCalendarMonths("2026-10-10", -3), "2026-07-10");
  assert.equal(addCalendarMonths("2026-03-31", -1), "2026-02-28");
  assert.equal(addCalendarMonths("2024-03-31", -1), "2024-02-29");
  assert.equal(addCalendarMonths("2026-01-15", -1), "2025-12-15");
  assert.equal(cutoff.toISOString(), "2026-07-09T16:00:00.000Z");
});

test("the homepage query uses the window and daily composition does not", () => {
  const timeline = readFileSync(new URL("../packages/backend/src/publication/timeline.ts", import.meta.url), "utf8");
  const compose = readFileSync(new URL("../packages/backend/src/reports/compose.ts", import.meta.url), "utf8");

  assert.match(timeline, /selectedCondition/);
  assert.doesNotMatch(compose, /featuredEntryCondition|addCalendarMonths/);
});

async function item(name: string, timeline: Date, discovered: Date) {
  const id = `${SOURCE}-${name}`;
  const url = `https://example.invalid/${id}`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, language, body_text, raw)
    VALUES (${id}, ${SOURCE}, ${id}, ${url}, ${name}, ${discovered}, ${timeline}, 'zh', 'body', '{}')`;
  await sql`INSERT INTO publications (article_id, title, source_id, channel, url, discovered_at, timeline_at, sort_at,
      visibility, eligible, selected, selection_candidate, visible_after, tags)
    VALUES (${id}, ${name}, ${SOURCE}, 'news', ${url}, ${discovered}, ${timeline}, ${discovered}, 'public', true,
      true, true, ${timeline}, ${[]})`;
}

test("picks older than three Beijing months leave the featured entrance and stay listed", async () => {
  await sql`INSERT INTO sources (id, name, kind, config) VALUES (${SOURCE}, 'Featured window fixture', 'rss', '{}')`;
  const recentCrawl = NOW;
  await item("inside", new Date("2026-10-09T00:00:00.000Z"), recentCrawl);
  await item("cutoff-day", cutoff, recentCrawl);
  await item("day-before", new Date(cutoff.getTime() - 86_400_000), recentCrawl);
  await item("archive-2020", new Date("2020-03-01T00:00:00.000Z"), recentCrawl);

  const featured = await sql<{ title: string }[]>`
    SELECT p.title FROM publications p
    WHERE p.source_id = ${SOURCE} AND ${featuredEntryCondition(NOW)}
    ORDER BY p.title`;
  assert.deepEqual(
    featured.map((row) => row.title),
    ["cutoff-day", "inside"],
  );

  const listed = await sql<{ title: string; selected: boolean }[]>`
    SELECT p.title, p.selected FROM publications p
    WHERE p.source_id = ${SOURCE} AND ${listedCondition(NOW)}
    ORDER BY p.title`;
  assert.deepEqual(
    listed.map((row) => [row.title, row.selected]),
    [
      ["archive-2020", true],
      ["cutoff-day", true],
      ["day-before", true],
      ["inside", true],
    ],
  );

  const timeline = await loadTimeline({ channel: "all", category: null, tag: null, now: NOW });
  assert.deepEqual(
    timeline.cards.map((card) => card.item.title).sort(),
    ["cutoff-day", "inside"],
    "actual grouped homepage uses the same calendar-window boundary",
  );

  const pool = await loadPool({ channel: "all", category: null, tag: null, topic: null, now: NOW });
  const inPool = new Map(pool.items.map((entry) => [entry.title, entry.selected]));
  assert.equal(inPool.get("archive-2020"), true);
  assert.equal(inPool.get("day-before"), true);

  const dailyStart = new Date("2026-10-09T00:00:00.000Z");
  const dailyEnd = new Date("2026-10-10T00:00:00.000Z");
  const [daily] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM publications p
    WHERE p.source_id = ${SOURCE}
      AND p.title = 'archive-2020'
      AND p.visibility = 'public' AND p.selected AND NOT p.backfill
      AND (
        (p.visible_after <= p.timeline_at AND p.timeline_at >= ${dailyStart} AND p.timeline_at < ${dailyEnd})
        OR (p.visible_after > p.timeline_at AND p.visible_after >= ${dailyStart} AND p.visible_after < ${dailyEnd})
      )`;
  assert.equal(daily?.n, 0);
});
