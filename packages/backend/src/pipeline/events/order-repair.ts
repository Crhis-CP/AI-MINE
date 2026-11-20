// The periodic repair of the event order (review of design M, F8). The event shadow's job (shadow-queue.ts) refreshes a
// fact's timing and its reports' event order only when one of the fact's reports is grouped through events.group. The
// hourly re-merge, story consolidation, an editor's story merge or detach, withdrawals, date corrections and score
// changes move facts and reports without that, and would leave events.fact_timing and publication.event_rank stale.
// Each of those republishes the reports it touches, so the pool publications changed since the last run name what to
// look at again: the facts a report is in now, the fact its stored row was decided with, and the facts its recent
// grouping decisions moved it into or out of. Their timing is recomputed and the rows of their public reports projected
// again with the shadow's own functions (timing.ts observeFactTiming, rank/project.ts projectEventOrder); a timing or a
// row that comes out the same is not written, so facts nothing changed keep their rows and decided_at.
// No model call; a report's own text is read only where its source allows it (those functions); only those two tables
// are written. It runs only while events.shadow is on (docs/runbooks/event-shadow.md): a timer queues one job an hour
// on a queue of its own, worked one job at a time per worker process, its queries one after another and its loop
// yielding to the event loop. A run takes at most REPAIR_BUDGET steps, then queues its continuation. It starts where
// the last completed run stopped (that job's output, kept by the queue), never earlier than REPAIR_LOOKBACK_HOURS ago,
// and leaves the last REPAIR_SETTLE_MINUTES to the next run, so a change still being committed is not passed over.
import { z } from "zod";
import { sql, type Db } from "../../db.ts";
import { enqueueOn, latestCompletedOutput } from "../../jobs/module-queues.ts";
import { defineQueue } from "../../modules.ts";
import { type ChangeCursor, changedPublications, factPublications, projectEventOrder, storyRankedArticles } from "../rank/project.ts";
import { slicer } from "./recall.ts";
import { eventShadowEnabled } from "./shadow.ts";
import { REPROJECT_LIMIT } from "./shadow-queue.ts";
import { articleFacts, observeFactTiming } from "./timing.ts";

/** How far back a run looks at most: changes older than this when the repair (re)starts are left alone. */
export const REPAIR_LOOKBACK_HOURS = 72;
/** Changes younger than this wait for the next run (their transaction may still be committing). */
export const REPAIR_SETTLE_MINUTES = 5;
/** Changed publications read per query. */
export const REPAIR_PAGE = 100;
/** Steps per run: a fact whose timing is recomputed, or a report whose row is projected. The report being repaired when the budget runs out is finished first. */
export const REPAIR_BUDGET = 1000;
/** Failed reports per run before the run gives up (it then fails, and the next run starts where the last completed one stopped). */
export const REPAIR_FAILURE_LIMIT = 5;
/** Grouping decisions read per report. */
const DECISION_LIMIT = 10;
const HOUR = 3_600_000;

/** The facts a report's grouping decisions since `since` put it into, and the fact a re-merge took it out of. */
export async function decidedFacts(articleId: string, since: Date, db: Db = sql): Promise<number[]> {
  const rows = await db<{ fact_id: number | null; from_fact: string | null }[]>`
    SELECT fact_id,input_manifest->'remerge'->>'fromFactId' AS from_fact FROM grouping_decisions
    WHERE article_id=${articleId} AND created_at>=${since} ORDER BY id DESC LIMIT ${DECISION_LIMIT}`;
  const facts = new Set<number>();
  for (const row of rows) {
    if (row.fact_id !== null) facts.add(row.fact_id);
    const from = Number(row.from_fact);
    if (row.from_fact !== null && Number.isSafeInteger(from)) facts.add(from);
  }
  return [...facts];
}

export interface RepairOutcome {
  /** Where the next run starts. */
  next: ChangeCursor;
  /** Every change up to the window's end was looked at. */
  done: boolean;
  /** Changed publications looked at. */
  changed: number;
  /** Facts whose timing was recomputed, and those among them whose day, basis, first report or story moved. */
  facts: number;
  moved: number;
  rows: { written: number; removed: number; unchanged: number };
  failures: number;
}

class RepairFailing extends Error {}

/**
 * Repair the facts and rows of the publications changed after `after` and at or before `to`. `since` bounds the grouping
 * decisions read. At most `budget` steps; the outcome says where to go on.
 */
export async function repairEventOrder(o: { after: ChangeCursor; to: Date; since: Date; budget?: number }, db: Db = sql): Promise<RepairOutcome> {
  const budget = o.budget ?? REPAIR_BUDGET;
  const out: RepairOutcome = { next: o.after, done: false, changed: 0, facts: 0, moved: 0, rows: { written: 0, removed: 0, unchanged: 0 }, failures: 0 };
  // A fact, report or story is looked at once per run, however many of its reports changed.
  const observed = new Set<number>();
  const projected = new Set<string>();
  const stories = new Set<number>();
  let steps = 0;
  const project = async (articleId: string) => {
    if (projected.has(articleId)) return;
    projected.add(articleId);
    steps++;
    out.rows[await projectEventOrder(articleId, db)]++;
  };
  const turn = slicer();
  for (;;) {
    const page = await changedPublications({ after: out.next, to: o.to, limit: REPAIR_PAGE }, db);
    for (const p of page) {
      if (steps >= budget) return out;
      try {
        const facts = [
          ...new Set([
            ...(await articleFacts(p.articleId, db)),
            ...(p.rankedFactId === null ? [] : [p.rankedFactId]),
            ...(await decidedFacts(p.articleId, o.since, db)),
          ]),
        ].filter((factId) => !observed.has(factId));
        for (const factId of facts) observed.add(factId);
        steps += facts.length;
        out.facts += facts.length;
        const moved = await observeFactTiming(facts, db);
        out.moved += moved.length;
        await project(p.articleId);
        // A fact whose day, first report or story moved moves its other reports' rows.
        for (const factId of moved) for (const id of await factPublications(factId, REPROJECT_LIMIT, db)) await project(id);
        // A report that moved to another story (a story merge) can move that story's first report, which every row of the
        // story reads: the story's latest rows are projected again.
        if (p.storyId !== null && p.rankedStoryId !== null && p.storyId !== p.rankedStoryId && !stories.has(p.storyId)) {
          stories.add(p.storyId);
          for (const id of await storyRankedArticles(p.storyId, REPROJECT_LIMIT, db)) await project(id);
        }
      } catch (error) {
        out.failures++;
        console.warn(`[event-order-repair] could not repair ${p.articleId}: ${String(error).slice(0, 200)}`);
        if (out.failures >= REPAIR_FAILURE_LIMIT) throw new RepairFailing(`${out.failures} reports failed; stopping at ${p.articleId}`);
      }
      out.next = { at: p.at, articleId: p.articleId };
      out.changed++;
      await turn();
    }
    if (page.length < REPAIR_PAGE) {
      // The window is done: the next run starts after its end (never before where this one started).
      if (Date.parse(out.next.at) <= o.to.getTime()) out.next = { at: o.to.toISOString(), articleId: null };
      out.done = true;
      return out;
    }
  }
}

const Cursor = z.object({ at: z.string().min(1).max(40), articleId: z.string().min(1).nullable() }).strict();
const Payload = z.object({ lane: z.literal("news"), after: Cursor.optional() }).strict();
type RepairJob = z.infer<typeof Payload>;
/** One job waits at a time: the hourly one or a continuation, whichever was queued first. */
const SINGLETON = "order-repair";

export const orderRepairQueue = defineQueue<RepairJob>({
  name: "news.events.order-repair",
  options: { policy: "short", retryLimit: 1, retryDelay: 300, expireInSeconds: 1800 },
  worker: { localConcurrency: 1, pollingIntervalSeconds: 30, batchSize: 1 },
  async run([job]) {
    if (!job) return;
    const data = Payload.parse(job);
    if (!(await eventShadowEnabled())) return { state: "skipped", reason: "switched_off" };
    const now = Date.now();
    const floor = new Date(now - REPAIR_LOOKBACK_HOURS * HOUR);
    const to = new Date(now - REPAIR_SETTLE_MINUTES * 60_000);
    const last = Cursor.safeParse((await latestCompletedOutput(orderRepairQueue.name, "next"))?.next);
    const start = data.after ?? (last.success ? last.data : null);
    // Never earlier than the lookback: after a long pause the repair starts again from there.
    const after: ChangeCursor = start && Date.parse(start.at) >= floor.getTime() ? start : { at: floor.toISOString(), articleId: null };
    const outcome = await repairEventOrder({ after, to, since: floor });
    if (!outcome.done) await enqueueOn(orderRepairQueue, { lane: "news", after: outcome.next }, { singletonKey: SINGLETON, startAfter: 60 });
    return { state: outcome.done ? "repaired" : "continued", from: after, to: to.toISOString(), ...outcome };
  },
});

let failures = 0;
/** The hourly timer (apps/worker/src/schedules.ts): queues a run while the switch is on. Never throws: a failure is logged and counted. */
export async function scheduleOrderRepair(): Promise<{ queued: boolean }> {
  try {
    if (!(await eventShadowEnabled())) return { queued: false };
    return { queued: (await enqueueOn(orderRepairQueue, { lane: "news" }, { singletonKey: SINGLETON })) !== null };
  } catch (error) {
    failures++;
    console.warn(`[event-order-repair] could not queue a run (${failures} failures since start): ${String(error).slice(0, 200)}`);
    return { queued: false };
  }
}
