// When a fact happened (events.fact_timing) and the event order of public news (publication.event_rank), as the event
// shadow's job and the back-fill write them (packages/backend/src/pipeline/events/timing.ts, pipeline/rank/project.ts):
// claims join and leave, an old report is filed on its event day, a fresh one keeps its place, nothing a reader sees
// changes, and the back-fill's dry run writes nothing.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { addDays, beijingDate, beijingMidnight } from "@amp/contracts/time";
import { closeDb, sql } from "@amp/backend/db";
import { stopBoss } from "@amp/backend/jobs/queue";
import { observeFactTiming, readFactTiming } from "../packages/backend/src/pipeline/events/timing.ts";
import { eventOrderBackfillPage, projectEventOrder } from "../packages/backend/src/pipeline/rank/project.ts";
import { readEventRanks, storyFreshness } from "../packages/backend/src/pipeline/rank/read.ts";
import { body, fact, hoursAgo, join, report, shadowSource, unique } from "./event-shadow-fixture.ts";

after(async () => {
  await stopBoss();
  await closeDb();
});

/** A Beijing calendar day `days` before today, and the way a Chinese report writes it. */
const day = (days: number) => addDays(beijingDate(new Date()), -days);
const written = (d: string) => `${Number(d.slice(0, 4))}年${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日`;
const timing = async (factId: number) =>
  (
    await sql<{ occurred_on: string | null; occurred_basis: string; members: number; first_article_id: string }[]>`
    SELECT occurred_on::text,occurred_basis,members,first_article_id FROM events.fact_timing WHERE fact_id=${factId}`
  )[0];
const rank = async (articleId: string) =>
  (
    await sql<
      {
        freshness: string;
        freshness_basis: string;
        occurred_on: string | null;
        anchor_at: Date | null;
        importance: number;
        decided_at: Date;
        updated_at: Date;
      }[]
    >`
    SELECT freshness,freshness_basis,occurred_on::text,anchor_at,importance,decided_at,updated_at FROM publication.event_rank WHERE article_id=${articleId}`
  )[0];

test("a fact's day: a bare claim stays a claim, a member writing its day makes it checked, two members agree, and members leaving move it", async () => {
  const source = await shadowSource();
  const claimed = day(20),
    checked = day(10);
  const storyStart = hoursAgo(48);
  const first = await report({ source, titleZh: unique(), body: body(), publishedAt: storyStart, occurredAt: claimed });
  const f = await fact("合成事实时间", [first], storyStart);
  assert.deepEqual(await observeFactTiming([f.factId]), [f.factId]);
  assert.deepEqual({ ...(await timing(f.factId)) }, { occurred_on: claimed, occurred_basis: "claimed", members: 1, first_article_id: first });

  const second = await report({
    source,
    titleZh: unique(),
    body: `${body()}公司于${written(checked)}发布公告。`,
    publishedAt: hoursAgo(24),
    occurredAt: checked,
  });
  await join(f.factId, second);
  assert.deepEqual(await observeFactTiming([f.factId]), [f.factId]);
  assert.deepEqual([(await timing(f.factId))!.occurred_on, (await timing(f.factId))!.occurred_basis], [checked, "verified"], "a day written in the text wins");
  assert.deepEqual(await observeFactTiming([f.factId]), [], "nothing changed, nothing moves");
  const [view] = await readFactTiming([f.factId]);
  assert.equal(view!.storyFirstReportedAt?.getTime(), storyStart.getTime(), "the story's first report comes with it");
  assert.equal(view!.firstReportedAt.getTime(), storyStart.getTime(), "the founder's own time");

  await sql`DELETE FROM fact_articles WHERE article_id=${second}`;
  const third = await report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(12), occurredAt: claimed });
  await join(f.factId, third);
  assert.deepEqual(await observeFactTiming([f.factId]), [f.factId]);
  assert.deepEqual(
    { ...(await timing(f.factId)) },
    { occurred_on: claimed, occurred_basis: "agreed", members: 2, first_article_id: first },
    "two members claim one day",
  );

  await sql`DELETE FROM fact_articles WHERE fact_id=${f.factId}`;
  assert.deepEqual(await observeFactTiming([f.factId]), [f.factId]);
  assert.equal(await timing(f.factId), undefined, "a fact with no member left has no timing");
});

test("the event order: an old report is filed on its event day, a fresh one keeps its place, and nothing a reader sees changes", async () => {
  const source = await shadowSource();
  const eventDay = day(30);
  const old = await report({ source, titleZh: unique(), body: `${body()}该矿于${written(eventDay)}停产。`, publishedAt: hoursAgo(2), occurredAt: eventDay });
  const fresh = await report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(1) });
  const oldFact = await fact("合成旧闻", [old]);
  const freshFact = await fact("合成新闻", [fresh]);
  await observeFactTiming([oldFact.factId, freshFact.factId]);
  const before = JSON.stringify([await sql`SELECT * FROM publications ORDER BY article_id`, await sql`SELECT * FROM selected_ledger ORDER BY seq`]);

  assert.equal(await projectEventOrder(old), "written");
  assert.equal(await projectEventOrder(fresh), "written");
  const o = (await rank(old))!,
    n = (await rank(fresh))!;
  assert.deepEqual([o.freshness, o.freshness_basis, o.occurred_on], ["old", "own_date", eventDay]);
  assert.equal(o.anchor_at?.getTime(), beijingMidnight(eventDay).getTime(), "filed on its event day, a Beijing midnight");
  assert.deepEqual([n.freshness, n.freshness_basis, n.anchor_at], ["new", "no_evidence", null]);
  assert.equal(Number(n.importance) - Number(o.importance), 30, "old news loses 30; outlet counts are no input");
  assert.equal(
    JSON.stringify([await sql`SELECT * FROM publications ORDER BY article_id`, await sql`SELECT * FROM selected_ledger ORDER BY seq`]),
    before,
    "publications, seats, sort times and the selected ledger are untouched",
  );

  assert.equal(await projectEventOrder(fresh), "unchanged", "running it again changes nothing");
  assert.deepEqual([(await rank(fresh))!.decided_at, (await rank(fresh))!.updated_at], [n.decided_at, n.updated_at]);
  // A report of the same fact four days earlier makes the fresh one a late report: its class moves, and with it decided_at.
  const fourDaysAgo = hoursAgo(96);
  const earlier = await report({ source, titleZh: unique(), body: body(), publishedAt: fourDaysAgo });
  await join(freshFact.factId, earlier);
  assert.deepEqual(await observeFactTiming([freshFact.factId]), [freshFact.factId]);
  assert.equal(await projectEventOrder(fresh), "written");
  const late = (await rank(fresh))!;
  assert.deepEqual([late.freshness, late.freshness_basis], ["old", "late_report"]);
  assert.ok(late.decided_at > n.decided_at, "decided_at moves with the class");
  assert.equal(late.anchor_at?.getTime(), fourDaysAgo.getTime(), "filed where the fact was first reported");

  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${old}`;
  assert.equal(await projectEventOrder(old), "removed", "a report no longer public loses its row");
  assert.equal(await rank(old), undefined);

  const ranks = await readEventRanks([fresh, old, "missing"]);
  assert.deepEqual([...ranks.keys()], [fresh]);
  assert.equal(ranks.get(fresh)!.freshness, "old");
  const stories = await storyFreshness([freshFact.storyId, oldFact.storyId, -1], hoursAgo(200));
  assert.deepEqual(stories.get(freshFact.storyId), { fresh: false, latestFreshArticleId: null }, "a story whose only report is old news is stale");
  assert.equal(stories.has(oldFact.storyId), false, "a story without rows is unknown, not stale");
});

test("the back-fill: the dry run computes the same rows and writes nothing; with --apply it writes them", async () => {
  const source = await shadowSource();
  const ids = [
    await report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(5) }),
    await report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(4) }),
    await report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(3) }),
  ];
  const shared = await fact("合成回填事实", ids);
  const since = hoursAgo(6);
  const count = async () =>
    (
      await sql<{ ranks: number; timings: number }[]>`SELECT (SELECT count(*)::int FROM publication.event_rank) AS ranks,
        (SELECT count(*)::int FROM events.fact_timing) AS timings`
    )[0]!;
  const pages = async (apply: boolean) => {
    const totals = { seen: 0, written: 0, classes: { new: 0, follow_up: 0, old: 0 } };
    let after: { at: Date; id: string } | null = null;
    do {
      const page = await eventOrderBackfillPage({ since, after, limit: 2, apply });
      totals.seen += page.seen;
      totals.written += page.written;
      for (const k of ["new", "follow_up", "old"] as const) totals.classes[k] += page.classes[k];
      after = page.next;
    } while (after);
    return totals;
  };
  // Other tests of this file leave public reports in the window too; the assertions hold whatever they are.
  await sql`DELETE FROM publication.event_rank`;
  const before = await count();
  const dry = await pages(false);
  assert.ok(dry.seen >= 3 && dry.written === 0 && dry.classes.new >= 3);
  assert.deepEqual(await count(), before, "the dry run writes nothing, neither order nor timing");
  const applied = await pages(true);
  assert.deepEqual(applied, { seen: dry.seen, written: dry.seen, classes: dry.classes }, "the rows the dry run counted, written");
  assert.equal((await count()).ranks, dry.seen);
  for (const id of ids) assert.equal((await rank(id))?.freshness, "new");
  assert.equal((await timing(shared.factId))!.members, 3, "the facts' timing is written first");
  assert.equal((await pages(true)).written, 0, "a second run changes nothing");
});
