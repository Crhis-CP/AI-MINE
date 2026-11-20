// The periodic repair of the event order (packages/backend/src/pipeline/events/order-repair.ts): a re-merge, an editor's
// detach, a withdrawal and a story merge change facts without the event shadow's job; the repair finds them through the
// changed publications and brings the facts' timing and the reports' rows up to date, leaves facts nothing changed as
// they are (decided_at stable), goes on where it stopped, and does nothing while the switch is off. No model call.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { addDays, beijingDate } from "@amp/contracts/time";
import { detachFromFact, mergeStories, setVisibility } from "@amp/backend/admin/content";
import { closeDb, sql } from "@amp/backend/db";
import { registerEventJobs } from "@amp/backend/jobs/events";
import { type getBoss, stopBoss } from "@amp/backend/jobs/queue";
import { publishArticle } from "@amp/backend/publication/publish";
import { latestCompletedOutput } from "../packages/backend/src/jobs/module-queues.ts";
import {
  decidedFacts,
  orderRepairQueue,
  REPAIR_LOOKBACK_HOURS,
  repairEventOrder,
  scheduleOrderRepair,
} from "../packages/backend/src/pipeline/events/order-repair.ts";
import { eventShadowEnabled } from "../packages/backend/src/pipeline/events/shadow.ts";
import { observeFactTiming } from "../packages/backend/src/pipeline/events/timing.ts";
import { type ChangeCursor, projectEventOrder } from "../packages/backend/src/pipeline/rank/project.ts";
import { body, fact, hoursAgo, report, shadowSource, unique } from "./event-shadow-fixture.ts";

after(async () => {
  await stopBoss();
  await closeDb();
});

const day = (days: number) => addDays(beijingDate(new Date()), -days);
const written = (d: string) => `${Number(d.slice(0, 4))}年${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日`;
const timing = async (factId: number) =>
  (
    await sql<{ occurred_on: string | null; occurred_basis: string; members: number; updated_at: Date }[]>`
    SELECT occurred_on::text,occurred_basis,members,updated_at FROM events.fact_timing WHERE fact_id=${factId}`
  )[0];
const rank = async (articleId: string) =>
  (
    await sql<{ fact_id: number | null; story_id: number | null; freshness: string; freshness_basis: string; decided_at: Date; updated_at: Date }[]>`
    SELECT fact_id,story_id,freshness,freshness_basis,decided_at,updated_at FROM publication.event_rank WHERE article_id=${articleId}`
  )[0];
/** The database clock now, as the repair's cursor holds it: everything changed from here on is after it. */
const mark = async (): Promise<ChangeCursor> => {
  const [row] = await sql<{ at: string }[]>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`;
  return { at: row!.at, articleId: null };
};
/** The state the event shadow leaves: the facts' timing observed and their reports' rows projected. */
async function shadowed(facts: number[], reports: string[]) {
  await observeFactTiming(facts);
  for (const id of reports) await projectEventOrder(id);
}
const repair = (after: ChangeCursor, budget?: number) =>
  repairEventOrder({ after, to: new Date(Date.now() + 60_000), since: hoursAgo(REPAIR_LOOKBACK_HOURS), ...(budget === undefined ? {} : { budget }) });
/** A report whose own text writes a day ten days ago: its fact's day is checked, and its reports are old news. */
const checkedOld = async (source: string, publishedAt: Date) => {
  const d = day(10);
  return report({ source, titleZh: unique(), body: `${body()}公司于${written(d)}发布公告。`, publishedAt, occurredAt: d });
};
async function switchShadow(value: "on" | "off") {
  await sql`INSERT INTO settings(key,value,updated_by) VALUES('events.shadow',${sql.json(value)},'test') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
  assert.equal(await eventShadowEnabled(0), value === "on");
}

test("a re-merge moves a report into a dated fact: both facts' timing and the moved report's row are repaired; an untouched fact is not rewritten", async () => {
  const source = await shadowSource();
  const anchor = await checkedOld(source, hoursAgo(30));
  const moved = await report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(2) });
  const quiet = await report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(3) });
  const dated = await fact("合成有日期的事实", [anchor], hoursAgo(30));
  const single = await fact("合成单篇事实", [moved], hoursAgo(2));
  const untouched = await fact("合成未变事实", [quiet], hoursAgo(3));
  await shadowed([dated.factId, single.factId, untouched.factId], [anchor, moved, quiet]);
  assert.deepEqual([(await rank(moved))!.freshness, (await timing(dated.factId))!.occurred_basis], ["new", "verified"]);
  const quietBefore = (await rank(quiet))!;
  const untouchedBefore = (await timing(untouched.factId))!;

  const from = await mark();
  // What events/group.ts remergeSingleReportFacts does in its transaction: the report changes fact, the decision names
  // the fact it left, and the report is republished. The live grouping queue is not involved.
  await sql.begin(async (tx) => {
    await tx`DELETE FROM fact_articles WHERE fact_id=${single.factId} AND article_id=${moved}`;
    await tx`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${dated.factId},${moved},'report',1)`;
    await tx`INSERT INTO grouping_decisions(article_id,fact_id,story_id,verdict,candidates,input_revision,input_manifest)
      VALUES(${moved},${dated.factId},${dated.storyId},'remerge','[]'::jsonb,1,${tx.json({ remerge: { fromFactId: single.factId } })})`;
  });
  await publishArticle(moved);
  // Another report republished for something that moves neither its fact nor its row.
  await sql`UPDATE publications SET updated_at=clock_timestamp() WHERE article_id=${quiet}`;
  assert.deepEqual(await decidedFacts(moved, hoursAgo(1)), [dated.factId, single.factId], "the decision names both facts");

  const outcome = await repair(from);
  assert.equal(outcome.done, true);
  assert.equal(outcome.failures, 0);
  assert.ok(outcome.changed >= 2, "both changed publications are looked at");
  assert.equal((await timing(dated.factId))!.members, 2, "the fact the report joined counts it");
  assert.equal(await timing(single.factId), undefined, "the fact it left, now empty, has no timing");
  const now = (await rank(moved))!;
  assert.deepEqual([now.fact_id, now.freshness, now.freshness_basis], [dated.factId, "old", "fact_date"], "the moved report takes its new fact's checked day");
  assert.deepEqual([now.story_id, (await rank(anchor))!.fact_id], [dated.storyId, dated.factId]);
  const quietAfter = (await rank(quiet))!;
  assert.deepEqual([quietAfter.decided_at, quietAfter.updated_at], [quietBefore.decided_at, quietBefore.updated_at], "a row nothing changed is not rewritten");
  assert.deepEqual((await timing(untouched.factId))!.updated_at, untouchedBefore.updated_at, "nor is the timing of its fact");

  const again = await repair(from);
  assert.deepEqual([again.rows.written, again.rows.removed], [0, 0], "a second run over the same changes writes nothing");
});

test("a member without a row of its own (withdrawn) re-merged away: the fact it left is found through the grouping decision", async () => {
  const source = await shadowSource();
  const hidden = await checkedOld(source, hoursAgo(6));
  const visible = await report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(1) });
  const left = await fact("合成留下的事实", [hidden, visible], hoursAgo(6));
  const target = await fact("合成并入的事实", [], hoursAgo(6));
  await setVisibility(hidden, { visibility: "withdrawn", reason: "合成撤稿", version: 0 }, "test");
  await shadowed([left.factId], [hidden, visible]);
  assert.equal(await rank(hidden), undefined, "a withdrawn report has no row");
  assert.deepEqual([(await rank(visible))!.freshness, (await timing(left.factId))!.occurred_basis], ["old", "verified"], "its checked day dates the fact");

  const from = await mark();
  await sql.begin(async (tx) => {
    await tx`DELETE FROM fact_articles WHERE fact_id=${left.factId} AND article_id=${hidden}`;
    await tx`INSERT INTO fact_articles(fact_id,article_id,role,input_revision) VALUES(${target.factId},${hidden},'report',1)`;
    await tx`INSERT INTO grouping_decisions(article_id,fact_id,story_id,verdict,candidates,input_revision,input_manifest)
      VALUES(${hidden},${target.factId},${target.storyId},'remerge','[]'::jsonb,1,${tx.json({ remerge: { fromFactId: left.factId } })})`;
  });
  await publishArticle(hidden);
  const outcome = await repair(from);
  assert.equal(outcome.failures, 0);
  assert.deepEqual([(await timing(left.factId))!.members, (await timing(left.factId))!.occurred_basis], [1, "none"], "the fact it left loses its day");
  assert.equal((await rank(visible))!.freshness, "new", "and the report still in it is news again");
  assert.equal((await timing(target.factId))!.members, 1);
});

test("an editor's detach and a withdrawal: the fact loses the dated member, its other report is new again, and a withdrawn report loses its row", async () => {
  const source = await shadowSource();
  const dating = await checkedOld(source, hoursAgo(5));
  const other = await report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(1) });
  const shared = await fact("合成被拆事实", [dating, other], hoursAgo(5));
  const withdrawn = await report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(2) });
  const kept = await report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(2) });
  const pair = await fact("合成撤稿事实", [withdrawn, kept], hoursAgo(2));
  await shadowed([shared.factId, pair.factId], [dating, other, withdrawn, kept]);
  assert.deepEqual([(await rank(other))!.freshness, (await rank(other))!.freshness_basis], ["old", "fact_date"]);
  const keptBefore = (await rank(kept))!;
  const pairBefore = (await timing(pair.factId))!;

  const from = await mark();
  await detachFromFact(dating, "合成：不是同一件事", "test");
  await setVisibility(withdrawn, { visibility: "withdrawn", reason: "合成撤稿", version: 0 }, "test");
  const outcome = await repair(from);
  assert.equal(outcome.failures, 0);
  const t = (await timing(shared.factId))!;
  assert.deepEqual([t.members, t.occurred_basis], [1, "none"], "the fact keeps one member and no day");
  assert.deepEqual([(await rank(other))!.freshness, (await rank(other))!.freshness_basis], ["new", "no_evidence"], "its other report is news again");
  assert.deepEqual([(await rank(dating))!.fact_id, (await rank(dating))!.freshness], [null, "old"], "the detached report stands alone on its own day");
  assert.equal(await rank(withdrawn), undefined, "a withdrawn report loses its row");
  assert.equal((await timing(pair.factId))!.updated_at.getTime(), pairBefore.updated_at.getTime(), "a withdrawal leaves the fact's timing as it was");
  assert.equal((await rank(kept))!.decided_at.getTime(), keptBefore.decided_at.getTime(), "and its other report's row");
});

test("a story merge: the merged story's reports follow, and the other reports of the story it joined become follow-ups", async () => {
  const source = await shadowSource();
  const early = await report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(30) });
  const late = await report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(2) });
  const from = await fact("合成早先的事件", [early], hoursAgo(30));
  const into = await fact("合成后来的事件", [late], hoursAgo(2));
  await shadowed([from.factId, into.factId], [early, late]);
  assert.equal((await rank(late))!.freshness, "new");

  const start = await mark();
  await mergeStories(from.storyId, into.storyId, "合成：同一事件", "test");
  const outcome = await repair(start);
  assert.equal(outcome.failures, 0);
  assert.equal((await rank(early))!.story_id, into.storyId, "the moved report's row follows its story");
  assert.deepEqual(
    [(await rank(late))!.freshness, (await rank(late))!.story_id],
    ["follow_up", into.storyId],
    "the story now began 28 hours before this fact: its report is a follow-up, though its own publication did not change",
  );
});

test("a run stops at its budget and the next goes on from where it stopped; changes before the cursor are not read", async () => {
  const source = await shadowSource();
  const before = await report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(1) });
  await fact("合成游标之前", [before], hoursAgo(1));
  const start = await mark();
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(await report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(1) }));
  const f = await fact("合成分批修复", ids, hoursAgo(1));
  const first = await repair(start, 1);
  assert.equal(first.done, false, "one step is not enough");
  assert.equal(first.changed, 1);
  assert.equal(await rank(before), undefined, "a change before the cursor is not looked at");
  let next = first.next,
    runs = 1;
  for (;;) {
    const page = await repair(next, 1);
    runs++;
    next = page.next;
    if (page.done) break;
    assert.ok(runs < 20, "the cursor moves on");
  }
  assert.equal(next.articleId, null, "a finished window ends after its last instant");
  for (const id of ids) assert.equal((await rank(id))?.fact_id, f.factId);
  assert.equal((await timing(f.factId))!.members, 3);
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
const queuedRuns = () => sql<{ id: string; data: unknown }[]>`SELECT id,data FROM pgboss.job WHERE name=${orderRepairQueue.name} AND state='created'`;

test("switched off nothing is queued and a queued run does nothing; on, a run repairs and the next starts where it stopped", async () => {
  const handle = await repairHandler();
  const source = await shadowSource();
  const one = await report({ source, titleZh: unique(), body: body(), publishedAt: hoursAgo(1) });
  const f = await fact("合成开关", [one], hoursAgo(1));
  // A run leaves the last few minutes to the next one: this change is older than that.
  await sql`UPDATE publications SET updated_at=now()-interval '10 minutes' WHERE article_id=${one}`;

  await switchShadow("off");
  assert.deepEqual(await scheduleOrderRepair(), { queued: false });
  assert.equal((await queuedRuns()).length, 0, "switched off, the timer queues nothing");
  const [skipped] = await handle([{ id: "r-off", data: { lane: "news" } }]);
  assert.deepEqual(skipped!.output, { state: "skipped", reason: "switched_off" });
  assert.equal(await rank(one), undefined, "and writes nothing");
  assert.equal(await timing(f.factId), undefined);

  await switchShadow("on");
  assert.deepEqual(await scheduleOrderRepair(), { queued: true });
  assert.deepEqual(await scheduleOrderRepair(), { queued: false }, "one run waits at a time");
  const jobs = await queuedRuns();
  assert.deepEqual(
    jobs.map((j) => j.data),
    [{ lane: "news" }],
  );
  const [done] = await handle(jobs);
  const output = done!.output as { state: string; next: ChangeCursor; from: ChangeCursor; failures: number };
  assert.deepEqual([output.state, output.failures], ["repaired", 0]);
  assert.ok(Date.parse(output.from.at) <= Date.now() - (REPAIR_LOOKBACK_HOURS * 3_600_000 - 60_000), "with no earlier run it looks back the full window");
  assert.equal((await rank(one))?.fact_id, f.factId, "the report changed within the window is repaired");
  assert.equal((await timing(f.factId))?.members, 1);

  // The queue keeps the completed run and its output; the next run starts where it stopped.
  await sql`UPDATE pgboss.job SET state='completed',completed_on=now(),output=${sql.json(output as never)} WHERE id=${jobs[0]!.id}`;
  assert.deepEqual((await latestCompletedOutput(orderRepairQueue.name, "next"))?.next, output.next);
  const [resumed] = await handle([{ id: "r-next", data: { lane: "news" } }]);
  assert.deepEqual((resumed!.output as { from: ChangeCursor }).from, output.next);
  await switchShadow("off");
});
