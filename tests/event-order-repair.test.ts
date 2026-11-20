// The event order's hourly sweep (packages/backend/src/pipeline/events/order-repair.ts): facts changed without the event
// shadow's job (a re-merge, an editor's detach, a member outside the public pool, a story merge whose republish failed, a
// withdrawal) are brought up to date from what is stored now; a report moved to a later fact is projected only after
// that fact is recomputed; facts nothing changed keep their rows (decided_at stable); a run stops at its budget and its
// continuation goes on; switching off stops a sweep after its page; the hourly timer starts no second sweep. No model call.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { addDays, beijingDate } from "@amp/contracts/time";
import { detachFromFact, mergeStories, setVisibility } from "@amp/backend/admin/content";
import { closeDb, sql } from "@amp/backend/db";
import { registerEventJobs } from "@amp/backend/jobs/events";
import { type getBoss, stopBoss } from "@amp/backend/jobs/queue";
import { scheduledTasks } from "@amp/backend/modules";
import { publishArticle } from "@amp/backend/publication/publish";
import { SCHEDULES } from "../apps/worker/src/schedules.ts";
import {
  CONTINUE_AFTER_SECONDS,
  decidedSince,
  orderRepairQueue,
  REPAIR_WINDOW_HOURS,
  runOrderRepair,
  type SweepOptions,
  scheduleOrderRepair,
  sweepEventOrder,
  sweepWindow,
} from "../packages/backend/src/pipeline/events/order-repair.ts";
import { eventShadowEnabled } from "../packages/backend/src/pipeline/events/shadow.ts";
import { observeFactTiming } from "../packages/backend/src/pipeline/events/timing.ts";
import { computeEventRank, projectEventOrder } from "../packages/backend/src/pipeline/rank/project.ts";
import { body, fact, hoursAgo, liveDecision, report, shadowSource, unique } from "./event-shadow-fixture.ts";

before(async () => {
  await sql`UPDATE ops.lane_controls SET paused=false,revision=revision+1`;
});
after(async () => {
  await stopBoss();
  await closeDb();
});

const day = (days: number) => addDays(beijingDate(new Date()), -days);
const written = (d: string) => `${Number(d.slice(0, 4))}年${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日`;
const timing = async (factId: number) =>
  (
    await sql<{ story_id: number | null; occurred_basis: string; members: number; updated_at: Date }[]>`
    SELECT story_id,occurred_basis,members,updated_at FROM events.fact_timing WHERE fact_id=${factId}`
  )[0];
const rank = async (articleId: string) =>
  (
    await sql<{ fact_id: number | null; freshness: string; freshness_basis: string; decided_at: Date; updated_at: Date }[]>`
    SELECT fact_id,freshness,freshness_basis,decided_at,updated_at FROM publication.event_rank WHERE article_id=${articleId}`
  )[0];
/** The state the event shadow leaves: the facts' timing observed and these reports' rows projected. */
async function shadowed(facts: number[], reports: string[]) {
  await observeFactTiming(facts);
  for (const id of reports) await projectEventOrder(id);
}
const since = () => hoursAgo(REPAIR_WINDOW_HOURS);
/** A whole sweep in one run, as many pages as it takes (the switch is not what these tests are about). */
const sweep = (opts: SweepOptions = {}) => sweepEventOrder({ since: since(), after: null, budget: 1_000_000, enabled: async () => true, ...opts });
/** A report whose own text writes a day ten days ago: its fact's day is checked, and the fact's reports are old news. */
const checkedOld = (source: string, publishedAt: Date, discoveredAt = publishedAt) => {
  const d = day(10);
  return report({ source, titleZh: unique(), body: `${body()}公司于${written(d)}发布公告。`, publishedAt, discoveredAt, occurredAt: d });
};
/** What events/group.ts remergeSingleReportFacts does in its transaction, short of republishing the report. */
async function remerge(articleId: string, from: { factId: number }, into: { factId: number; storyId: number }) {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM fact_articles WHERE fact_id=${from.factId} AND article_id=${articleId}`;
    await tx`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${into.factId},${articleId},'report',1)`;
    await tx`INSERT INTO grouping_decisions(article_id,fact_id,story_id,verdict,candidates,input_revision,input_manifest)
      VALUES(${articleId},${into.factId},${into.storyId},'remerge','[]'::jsonb,1,${tx.json({ remerge: { fromFactId: from.factId } })})`;
  });
}
/** The stored row says what the rules say now. */
async function current(articleId: string) {
  const [stored, now] = [await rank(articleId), await computeEventRank(articleId)];
  assert.deepEqual([stored?.fact_id ?? null, stored?.freshness ?? null], [now?.factId ?? null, now?.freshness ?? null], `the row of ${articleId} is current`);
}
async function switchShadow(value: "on" | "off") {
  await sql`INSERT INTO settings(key,value,updated_by) VALUES('events.shadow',${sql.json(value)},'test') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
  assert.equal(await eventShadowEnabled(0), value === "on");
}

test("a report re-merged into another fact is projected only after that fact is recomputed, whichever comes first, one fact per page or all in one", async () => {
  for (const [page, joinedFirst] of [
    [1, false],
    [1, true],
    [25, false],
  ] as const) {
    const source = await shadowSource();
    const x = await report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(4) });
    const y = await report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(2) });
    const anchor = await checkedOld(source, hoursAgo(30));
    // The dated fact X joins was never observed (grouped while the switch was off); it comes before or after the fact X leaves.
    const dated = () => fact("合成有日期的目标事实", [anchor], hoursAgo(30));
    const joined = joinedFirst ? await dated() : null;
    const left = await fact("合成被离开的事实", [x, y], hoursAgo(4));
    const target = joined ?? (await dated());
    assert.equal(target.factId > left.factId, !joinedFirst);
    await shadowed([left.factId], [x, y]);
    // Y republished for something else first, then X re-merged.
    await sql`UPDATE publications SET updated_at=clock_timestamp() WHERE article_id=${y}`;
    await remerge(x, left, target);
    await publishArticle(x);

    const outcome = await sweep({ page });
    assert.deepEqual([outcome.done, outcome.failures], [true, 0]);
    assert.deepEqual([(await rank(x))!.fact_id, (await rank(x))!.freshness, (await rank(x))!.freshness_basis], [target.factId, "old", "fact_date"]);
    for (const id of [x, y, anchor]) await current(id);
    assert.equal((await timing(left.factId))!.members, 1);
    assert.equal((await timing(target.factId))!.occurred_basis, "verified");
  }
});

test("a re-merge: the fact left and the fact joined are recomputed; facts nothing changed are not rewritten", async () => {
  const source = await shadowSource();
  const anchor = await checkedOld(source, hoursAgo(30));
  const moved = await report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(2) });
  const quiet = await report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(3) });
  const dated = await fact("合成有日期的事实", [anchor], hoursAgo(30));
  const single = await fact("合成单篇事实", [moved], hoursAgo(2));
  const untouched = await fact("合成未变事实", [quiet], hoursAgo(3));
  await shadowed([dated.factId, single.factId, untouched.factId], [anchor, moved, quiet]);
  // Earlier sweeps may have left other tests' facts out of date: one sweep first, so this one starts from current rows.
  await sweep();
  const quietBefore = (await rank(quiet))!;
  const untouchedBefore = (await timing(untouched.factId))!;
  assert.equal((await rank(moved))!.freshness, "new");

  await remerge(moved, single, dated);
  // events/group.ts republishes inside the same transaction.
  await publishArticle(moved);
  const outcome = await sweep();
  assert.equal(outcome.failures, 0);
  assert.equal((await timing(dated.factId))!.members, 2, "the fact the report joined counts it");
  assert.equal(await timing(single.factId), undefined, "the fact it left, now empty, has no timing");
  assert.deepEqual([(await rank(moved))!.freshness, (await rank(moved))!.freshness_basis], ["old", "fact_date"], "it takes its new fact's checked day");
  const quietAfter = (await rank(quiet))!;
  assert.deepEqual([quietAfter.decided_at, quietAfter.updated_at], [quietBefore.decided_at, quietBefore.updated_at], "a row nothing changed is not rewritten");
  assert.deepEqual((await timing(untouched.factId))!.updated_at, untouchedBefore.updated_at, "nor is the timing of its fact");
  const again = await sweep();
  assert.deepEqual([again.rows.written, again.rows.removed, again.moved], [0, 0, 0], "a second sweep writes nothing");
});

test("a detach of a report with no row: the fact it left is found through its grouping decision, though no other member is in the window", async () => {
  const source = await shadowSource();
  // The other member is older than the window, and so is its publication.
  const other = await report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(100) });
  const dating = await checkedOld(source, hoursAgo(5));
  const shared = await fact("合成被拆事实", [other, dating], hoursAgo(100));
  await liveDecision(dating, "same-fact", shared, hoursAgo(5));
  await sql`UPDATE publications SET updated_at=now()-interval '100 hours' WHERE article_id=${other}`;
  await shadowed([shared.factId], [other]);
  assert.equal(await rank(dating), undefined, "the report never had a row");
  assert.deepEqual([(await rank(other))!.freshness, (await rank(other))!.freshness_basis], ["old", "fact_date"]);

  await detachFromFact(dating, "合成：不是同一件事", "test");
  const window = await sweepWindow(since());
  assert.ok(window.facts.includes(shared.factId), "the old fact is in the sweep");
  await sweep();
  const t = (await timing(shared.factId))!;
  assert.deepEqual([t.members, t.occurred_basis], [1, "none"], "the fact keeps one member and no day");
  assert.deepEqual([(await rank(other))!.freshness, (await rank(other))!.freshness_basis], ["new", "no_evidence"], "its other report is news again");
  assert.deepEqual([(await rank(dating))!.fact_id, (await rank(dating))!.freshness], [null, "old"], "the detached report stands alone on its own day");
});

/** A report from before the window: discovered and last republished 100 hours ago. */
async function older(make: (at: Date) => Promise<string>) {
  const id = await make(hoursAgo(100));
  await sql`UPDATE publications SET updated_at=now()-interval '100 hours' WHERE article_id=${id}`;
  return id;
}

test("a member outside the public pool, discovered in the window, moves its fact's day though nothing republishes the fact's report", async () => {
  const source = await shadowSource();
  const shown = await older((at) => report({ source, titleZh: unique(), body: body(), publishedAt: at }));
  const shared = await fact("合成池外成员", [shown], hoursAgo(100));
  // Joining the fact republished it: back before the window again.
  await sql`UPDATE publications SET updated_at=now()-interval '100 hours' WHERE article_id=${shown}`;
  await shadowed([shared.factId], [shown]);
  assert.equal((await rank(shown))!.freshness, "new");

  const hidden = await checkedOld(source, hoursAgo(1));
  await sql`UPDATE publications SET eligible=false WHERE article_id=${hidden}`;
  await sql`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${shared.factId},${hidden},'report',1)`;
  await sweep();
  assert.deepEqual([(await timing(shared.factId))!.members, (await timing(shared.factId))!.occurred_basis], [2, "verified"]);
  assert.deepEqual(
    [(await rank(shown))!.freshness, (await rank(shown))!.freshness_basis],
    ["old", "fact_date"],
    "the public report takes the hidden member's day",
  );
  assert.equal(await rank(hidden), undefined, "a report outside the pool gets no row");
});

test("an older member outside the pool re-merged away: found through the grouping decision made in the window", async () => {
  const source = await shadowSource();
  const shown = await older((at) => report({ source, titleZh: unique(), body: body(), publishedAt: at }));
  const hidden = await older((at) => checkedOld(source, at));
  await sql`UPDATE publications SET eligible=false WHERE article_id=${hidden}`;
  const left = await fact("合成旧事实", [shown, hidden], hoursAgo(100));
  const joined = await fact("合成新归属", [], hoursAgo(100));
  for (const id of [shown, hidden]) await sql`UPDATE publications SET updated_at=now()-interval '100 hours' WHERE article_id=${id}`;
  await shadowed([left.factId], [shown]);
  assert.equal((await rank(shown))!.freshness, "old");

  await remerge(hidden, left, joined);
  await sweep();
  assert.deepEqual([(await timing(left.factId))!.members, (await timing(left.factId))!.occurred_basis], [1, "none"]);
  assert.equal((await rank(shown))!.freshness, "new", "the report left behind is news again");
});

test("a withdrawal of an older report removes its row and leaves its fact and the other report's row as they were", async () => {
  const source = await shadowSource();
  const withdrawn = await older((at) => report({ source, titleZh: unique(), body: body(), publishedAt: at }));
  const kept = await older((at) => report({ source, titleZh: unique(), body: body(), publishedAt: at }));
  const pair = await fact("合成撤稿事实", [withdrawn, kept], hoursAgo(100));
  for (const id of [withdrawn, kept]) await sql`UPDATE publications SET updated_at=now()-interval '100 hours' WHERE article_id=${id}`;
  await shadowed([pair.factId], [withdrawn, kept]);
  const keptBefore = (await rank(kept))!;
  const pairBefore = (await timing(pair.factId))!;

  await setVisibility(withdrawn, { visibility: "withdrawn", reason: "合成撤稿", version: 0 }, "test");
  await sweep();
  assert.equal(await rank(withdrawn), undefined, "a withdrawn report loses its row");
  assert.equal((await timing(pair.factId))!.updated_at.getTime(), pairBefore.updated_at.getTime(), "a withdrawal leaves the fact's timing as it was");
  assert.deepEqual(
    [(await rank(kept))!.decided_at, (await rank(kept))!.updated_at],
    [keptBefore.decided_at, keptBefore.updated_at],
    "and its other report's row",
  );
});

/** Two reports of one fact before the window, the first carrying a checked day ten days back: the other is old news. */
async function datedPair(source: string, title: string) {
  const dating = await older((at) => checkedOld(source, at));
  const other = await older((at) => report({ source, titleZh: unique(), body: body(), publishedAt: at }));
  const shared = await fact(title, [dating, other], hoursAgo(100));
  // Joining the fact republished them: back before the window again.
  await sql`UPDATE publications SET updated_at=now()-interval '100 hours' WHERE article_id IN (${dating},${other})`;
  await shadowed([shared.factId], [other]);
  assert.deepEqual([(await rank(other))!.freshness, (await rank(other))!.freshness_basis], ["old", "fact_date"]);
  return { dating, other, shared };
}

test("the fact a re-merge took a report out of is found through the decision's own record of it", async () => {
  // The report has no publication (so no fact on one) and no row: only the re-merge decision names the fact it left.
  const source = await shadowSource();
  const { dating, other, shared } = await datedPair(source, "合成只靠判定记录的事实");
  await sql`DELETE FROM publications WHERE article_id=${dating}`;
  const target = await fact("合成并入", [], hoursAgo(100));
  await remerge(dating, shared, target);
  await sweep();
  assert.deepEqual([(await timing(shared.factId))!.members, (await timing(shared.factId))!.occurred_basis], [1, "none"]);
  assert.equal((await rank(other))!.freshness, "new");
});

test("the fact a report's publication still names is swept, though the report left it with no decision and no row", async () => {
  // A report of the window leaves the fact (its republish has not happened yet): only its publication still names it.
  const source = await shadowSource();
  const other = await older((at) => report({ source, titleZh: unique(), body: body(), publishedAt: at }));
  const dating = await checkedOld(source, hoursAgo(1));
  const shared = await fact("合成只靠公开稿的事实", [dating, other], hoursAgo(100));
  await sql`UPDATE publications SET updated_at=now()-interval '100 hours' WHERE article_id=${other}`;
  await shadowed([shared.factId], [other]);
  assert.equal((await rank(other))!.freshness, "old");
  await sql`DELETE FROM fact_articles WHERE article_id=${dating}`;
  await sweep();
  assert.deepEqual([(await timing(shared.factId))!.members, (await timing(shared.factId))!.occurred_basis], [1, "none"]);
  assert.equal((await rank(other))!.freshness, "new");
});

test("the fact a report's stored row was decided with is swept, though the report moved with no decision", async () => {
  const source = await shadowSource();
  const { dating, other, shared } = await datedPair(source, "合成只靠排序行的事实");
  await projectEventOrder(dating);
  assert.equal((await rank(dating))!.fact_id, shared.factId);
  const target = await fact("合成新事实", [], hoursAgo(100));
  await sql`UPDATE fact_articles SET fact_id=${target.factId} WHERE article_id=${dating}`;
  await publishArticle(dating);
  await sweep();
  assert.deepEqual([(await timing(shared.factId))!.members, (await timing(shared.factId))!.occurred_basis], [1, "none"]);
  assert.equal((await rank(other))!.freshness, "new");
  assert.equal((await rank(dating))!.fact_id, target.factId);
});

test("an older report outside the pool detached by an editor: the fact it left is found through the audit log", async () => {
  const source = await shadowSource();
  const { dating, other, shared } = await datedPair(source, "合成旧稿被拆");
  await sql`UPDATE publications SET eligible=false WHERE article_id=${dating}`;
  await detachFromFact(dating, "合成：不是同一件事", "test");
  await sql`UPDATE publications SET eligible=false,updated_at=now()-interval '100 hours' WHERE article_id=${dating}`;
  assert.ok((await sweepWindow(since())).facts.includes(shared.factId));
  await sweep();
  assert.deepEqual([(await timing(shared.factId))!.members, (await timing(shared.factId))!.occurred_basis], [1, "none"]);
  assert.equal((await rank(other))!.freshness, "new");
});

test("a story merge whose joined story's reports are all older than the window: they become follow-ups through the audit log", async () => {
  const source = await shadowSource();
  const early = await older((at) => report({ source, titleZh: unique(), body: body(), publishedAt: new Date(at.getTime() - 30 * 3_600_000) }));
  const late = await older((at) => report({ source, titleZh: unique(), body: body(), publishedAt: at }));
  const from = await fact("合成更早的事件", [early], hoursAgo(130));
  const into = await fact("合成较早的事件", [late], hoursAgo(100));
  await sql`UPDATE publications SET updated_at=now()-interval '100 hours' WHERE article_id IN (${early},${late})`;
  await shadowed([from.factId, into.factId], [early, late]);
  assert.equal((await rank(late))!.freshness, "new");
  await mergeStories(from.storyId, into.storyId, "合成：同一事件", "test");
  assert.equal(
    (await sql`SELECT 1 FROM publications WHERE article_id=${late} AND updated_at>now()-interval '1 hour'`).length,
    0,
    "its publication did not change",
  );
  await sweep();
  assert.equal((await rank(late))!.freshness, "follow_up", "its story now began 30 hours before its fact");
});

test("a window source that reads as many entries as it may is reported full, also when its decisions name fewer reports", async () => {
  const source = await shadowSource();
  const one = await report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(1) });
  const f = await fact("合成判定上限", [one], hoursAgo(1));
  for (let i = 0; i < 3; i++) await liveDecision(one, "same-fact", f);
  const decided = await decidedSince(since(), 3);
  assert.deepEqual(decided, { ids: [one], full: true }, "three decisions read, one report");
  assert.equal((await sweepWindow(since(), sql, 3)).full, true);
  assert.equal((await sweepWindow(since())).full, false, "with the real limit this window is not full");
});

test("inside a page the switch and the budget are looked at every few steps; a run always finishes its first page", async () => {
  const source = await shadowSource();
  const a = await report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(1) });
  const b = await report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(1) });
  const fa = await fact("合成页内一", [a], hoursAgo(1));
  const fb = await fact("合成页内二", [b], hoursAgo(1));
  const start = { fact: fa.factId - 1 };
  // A budget smaller than the first page: the run still finishes that page, and so the sweep moves on.
  const small = await sweepEventOrder({ since: since(), after: start, budget: 1, page: 1, checkEvery: 1, enabled: async () => true });
  assert.deepEqual([small.next, small.facts, small.rows.written + small.rows.unchanged], [{ fact: fa.factId }, 1, 1]);
  // Budget: the first page (fact A: one recompute, one row) runs past it; the second stops after its first step.
  const cut = await sweepEventOrder({ since: since(), after: start, budget: 3, page: 1, checkEvery: 1, enabled: async () => true });
  assert.deepEqual([cut.done, cut.stopped, cut.next, cut.facts], [false, false, { fact: fa.factId }, 2]);
  assert.equal(cut.rows.written + cut.rows.unchanged, 1, "the second page stopped before its report");
  const rest = await sweepEventOrder({ since: since(), after: cut.next, budget: 1_000_000, page: 1, enabled: async () => true });
  assert.equal(rest.done, true);
  assert.equal((await rank(b))?.fact_id, fb.factId, "the continuation does the page again");
  // Switch: off after the look before the page and the first step, the sweep stops inside its one page.
  let looks = 0;
  const off = await sweepEventOrder({ since: since(), after: null, page: 1000, checkEvery: 1, enabled: async () => ++looks <= 2 });
  assert.deepEqual([off.stopped, off.done, off.facts], [true, false, 2]);
});

test("a story merge whose republish failed: the moved fact follows its story and the other report of the story it joined becomes a follow-up", async () => {
  const source = await shadowSource();
  const early = await report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(30) });
  const late = await report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(2) });
  const from = await fact("合成早先的事件", [early], hoursAgo(30));
  const into = await fact("合成后来的事件", [late], hoursAgo(2));
  await shadowed([from.factId, into.factId], [early, late]);
  assert.equal((await rank(late))!.freshness, "new");

  // News publication paused: the merge commits, its republish after the commit throws.
  await sql`UPDATE ops.lane_controls SET paused=true,revision=revision+1,reason='合成暂停',actor='test',expires_at=now()+interval '1 hour'
    WHERE lane='news' AND switch='publication' AND holder='owner'`;
  try {
    await assert.rejects(mergeStories(from.storyId, into.storyId, "合成：同一事件", "test"));
  } finally {
    await sql`UPDATE ops.lane_controls SET paused=false,revision=revision+1`;
  }
  assert.equal((await sql`SELECT story_id FROM facts WHERE id=${from.factId}`)[0]!.story_id, into.storyId, "the merge itself committed");
  assert.equal((await sql`SELECT story_id FROM publications WHERE article_id=${early}`)[0]!.story_id, from.storyId, "the republish did not happen");
  await sweep();
  assert.equal((await timing(from.factId))!.story_id, into.storyId, "the moved fact's timing follows its story");
  assert.equal((await rank(late))!.freshness, "follow_up", "the story now began 28 hours before this fact: its report is a follow-up");
  for (const id of [early, late]) await current(id);
});

test("a run stops at its budget and queues its continuation, which goes on after the last fact done", async () => {
  await switchShadow("on");
  const source = await shadowSource();
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(await report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(1) }));
  const facts = [];
  for (const id of ids) facts.push(await fact("合成分批修复", [id], hoursAgo(1)));
  await sql`DELETE FROM pgboss.job WHERE name=${orderRepairQueue.name}`;
  const first = await runOrderRepair({ lane: "news" }, { budget: 1, page: 1 });
  assert.equal(first.state, "continued");
  const [queued] = await sql<{ data: { lane: string; sweep: { since: string; after: { fact: number } } }; due: number }[]>`
    SELECT data,extract(epoch FROM start_after-now())::int AS due FROM pgboss.job WHERE name=${orderRepairQueue.name} AND state='created'`;
  assert.deepEqual(queued!.data, { lane: "news", sweep: { since: first.since, after: first.next } }, "the continuation carries the sweep and where it stopped");
  assert.ok("fact" in first.next! && queued!.due >= CONTINUE_AFTER_SECONDS - 5, "it starts after a short pause");
  // Each continuation goes on from the fact before it.
  let data = queued!.data as Parameters<typeof runOrderRepair>[0],
    runs = 1;
  for (;;) {
    await sql`DELETE FROM pgboss.job WHERE name=${orderRepairQueue.name}`;
    const run = await runOrderRepair(data, { budget: 1, page: 1 });
    runs++;
    if (run.state === "swept") break;
    const [next] = await sql<{ data: typeof data }[]>`SELECT data FROM pgboss.job WHERE name=${orderRepairQueue.name} AND state='created'`;
    const before = data.sweep?.after;
    if (before && "fact" in before && run.next && "fact" in run.next) assert.ok(run.next.fact > before.fact, "the sweep moves on");
    data = next!.data;
    assert.ok(runs < 2000);
  }
  assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE name=${orderRepairQueue.name}`).length, 0, "a finished sweep queues nothing");
  for (const [i, id] of ids.entries()) assert.equal((await rank(id))?.fact_id, facts[i]!.factId);
  await switchShadow("off");
});

test("switching off stops a sweep after the page under way, and queues no continuation", async () => {
  await switchShadow("on");
  const source = await shadowSource();
  for (let i = 0; i < 3; i++) await fact("合成中途关闭", [await report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(1) })], hoursAgo(1));
  await sql`DELETE FROM pgboss.job WHERE name=${orderRepairQueue.name}`;
  let pages = 0;
  const run = await runOrderRepair(
    { lane: "news" },
    {
      page: 1,
      enabled: () => eventShadowEnabled(0),
      afterPage: async () => {
        pages++;
        await switchShadow("off");
      },
    },
  );
  assert.deepEqual([run.state, pages, run.facts], ["stopped", 1, 1], "one page, then it stops");
  assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE name=${orderRepairQueue.name}`).length, 0, "and queues nothing");
});

type Handler = (jobs: Array<{ id: string; data: unknown }>) => Promise<Array<{ output: Record<string, unknown> }>>;
async function repairHandler(): Promise<Handler> {
  const handlers = new Map<string, Handler>();
  await registerEventJobs({
    work: async (queue: string, _options: unknown, handler: Handler) => {
      handlers.set(queue, handler);
    },
  } as unknown as Awaited<ReturnType<typeof getBoss>>);
  return handlers.get(orderRepairQueue.name)!;
}

test("the hourly timer: registered at minute 47, nothing while off, and no second sweep while one waits, retries or runs", async () => {
  const timer = scheduledTasks(SCHEDULES).find((task) => task.name === "events.order-repair");
  assert.equal(timer?.cron, "47 * * * *");
  await sql`DELETE FROM pgboss.job WHERE name=${orderRepairQueue.name}`;
  const handle = await repairHandler();

  await switchShadow("off");
  assert.deepEqual(await timer!.run(), { queued: false, reason: "switched_off" });
  assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE name=${orderRepairQueue.name}`).length, 0);
  const [skipped] = await handle([{ id: "r-off", data: { lane: "news" } }]);
  assert.deepEqual(skipped!.output, { state: "skipped", reason: "switched_off" }, "a queued run does nothing while off");

  await switchShadow("on");
  assert.deepEqual(await timer!.run(), { queued: true });
  for (const state of ["created", "retry", "active"]) {
    await sql`UPDATE pgboss.job SET state=${state}::pgboss.job_state WHERE name=${orderRepairQueue.name}`;
    assert.deepEqual(await scheduleOrderRepair(), { queued: false, reason: "sweep_under_way" }, `not while one is ${state}`);
  }
  await sql`UPDATE pgboss.job SET state='completed',completed_on=now() WHERE name=${orderRepairQueue.name}`;
  assert.deepEqual(await scheduleOrderRepair(), { queued: true }, "a finished sweep lets the next one start");
  const [job] = await sql<{ id: string; data: unknown }[]>`SELECT id,data FROM pgboss.job WHERE name=${orderRepairQueue.name} AND state='created'`;
  const [done] = await handle([job!]);
  assert.equal(done!.output.state, "swept", "the queued sweep runs through the worker's handler");
  await switchShadow("off");
});
