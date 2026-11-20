// The periodic repair of the event order (review of design M, F8). The event shadow's job (shadow-queue.ts) refreshes a
// fact's timing and its reports' event order only when one of the fact's reports is grouped through events.group. The
// hourly re-merge, story merges, an editor's detach, withdrawals, date corrections and score changes move facts and
// reports without that, and some of them republish after their own commit only as far as they can.
// So the repair does not chase changes: once an hour it sweeps every fact active in the last REPAIR_WINDOW_HOURS and
// recomputes it from what is stored now. A fact is active when one of these reports is in it now, or was in it by a
// grouping decision or by the stored row of its order:
//  - materials discovered in the window, in any state (members outside the public pool count for a fact's timing);
//  - pool publications republished in the window (a withdrawal, a date or score change of an older report);
//  - reports with a grouping decision in the window (a re-merge or regroup of an older report);
// and, from the audit log of the window, the facts a detach took a report out of and the facts of a story another was
// merged into (whose start may have moved), whatever the age of their reports.
// Facts are taken in id order, a page at a time: (A) the page's facts get their timing recomputed, then (B) every report
// with a row for those facts or a public publication in them gets its row projected again, after the fact its
// publication is in now has been recomputed in this run (also when that fact is on a later page). Reports of the window
// in no fact come last. Both steps use the shadow's own functions (timing.ts observeFactTiming, rank/project.ts
// projectEventOrder): a timing or a row that comes out the same is not written, so decided_at stays.
// No model call; a report's own text is read only where its source allows it; only events.fact_timing and
// publication.event_rank are written. It runs only while events.shadow is on (docs/runbooks/event-shadow.md), on a queue
// of its own, one job at a time per worker process, its queries one after another, yielding to the event loop. The switch
// and the budget are looked at before every page and every CHECK_EVERY steps; a run past REPAIR_BUDGET steps queues its
// continuation; a new sweep is not started while one is under way. A fact or report that fails is logged, counted and
// passed: the next sweep tries it again.
import { z } from "zod";
import { groupingCorrectionsSince } from "../../admin/auth.ts";
import { newsDiscoveredSince } from "../../content/materials.ts";
import { sql, type Db } from "../../db.ts";
import { enqueueOn, queueBusy } from "../../jobs/module-queues.ts";
import { defineQueue } from "../../modules.ts";
import { factPublications, poolPublicationsUpdatedSince, projectEventOrder, publicationPlaces } from "../rank/project.ts";
import { slicer } from "./recall.ts";
import { eventShadowEnabled } from "./shadow.ts";
import { FACT_MEMBER_LIMIT, observeFactTiming } from "./timing.ts";

/** A fact is swept while one of its reports was discovered, republished or decided on within this many hours. */
export const REPAIR_WINDOW_HOURS = 72;
/** Reports read per source of the window; a source that reaches it is reported (windowFull) and its oldest reports wait. */
export const REPAIR_WINDOW_LIMIT = 20_000;
/** Facts per page. */
export const REPAIR_PAGE = 25;
/** Reports per page of the reports of the window in no fact. */
const STANDALONE_PAGE = 100;
/** Steps per run (a fact recomputed or a report projected), looked at every CHECK_EVERY steps; a run always finishes its first page. */
export const REPAIR_BUDGET = 2000;
/** A continuation starts this long after the run before it. */
export const CONTINUE_AFTER_SECONDS = 10;
/** Steps between two looks at the switch and the budget inside a page. */
export const CHECK_EVERY = 100;
/** Facts read per story a story merge names. */
const STORY_FACT_LIMIT = 200;
/** Reports looked up per query when the window is read. */
const LOOKUP_SLICE = 500;
/** Grouping decisions read per report. */
const DECISION_LIMIT = 10;
const HOUR = 3_600_000;

/**
 * Reports of the latest `limit` grouping decisions made since `since`: those after the last decision made before it, read
 * by id (a decision's id rises with its time), newest first.
 */
export async function decidedSince(since: Date, limit: number, db: Db = sql): Promise<{ ids: string[]; full: boolean }> {
  const rows = await db<{ article_id: string }[]>`SELECT article_id FROM grouping_decisions
    WHERE id>(SELECT coalesce(max(id),0) FROM grouping_decisions WHERE created_at<${since}) ORDER BY id DESC LIMIT ${limit}`;
  // Full when the decisions read reach the limit, however few reports they name.
  return { ids: [...new Set(rows.map((row) => row.article_id))], full: rows.length >= limit };
}

/** The facts of these stories, at most `limit` per story (a story merge moves every fact's story start). */
export async function storyFacts(storyIds: readonly number[], limit: number, db: Db = sql): Promise<number[]> {
  if (!storyIds.length) return [];
  const rows = await db<{ id: number }[]>`SELECT f.id FROM unnest(${[...storyIds]}::bigint[]) AS s(id) CROSS JOIN LATERAL (
    SELECT id FROM facts WHERE story_id=s.id ORDER BY id DESC LIMIT ${limit}) f`;
  return rows.map((row) => row.id);
}

/**
 * The facts these reports are in now, and those their latest grouping decisions put them in or (a re-merge) took them out
 * of. A fact left in a merged story is among them too: recomputing it finds no live member and drops its timing.
 */
export async function factsOfReports(ids: readonly string[], db: Db = sql): Promise<number[]> {
  if (!ids.length) return [];
  const rows = await db<{ fact_id: number | null; from_fact: string | null }[]>`
    SELECT fact_id,NULL AS from_fact FROM fact_articles WHERE article_id=ANY(${[...ids]}::text[]) AND role IN ('primary','report')
    UNION ALL
    SELECT d.fact_id,d.from_fact FROM unnest(${[...ids]}::text[]) AS r(id) CROSS JOIN LATERAL (
      SELECT fact_id,input_manifest->'remerge'->>'fromFactId' AS from_fact FROM grouping_decisions WHERE article_id=r.id ORDER BY id DESC LIMIT ${DECISION_LIMIT}) d`;
  const facts = new Set<number>();
  for (const row of rows) {
    if (row.fact_id !== null) facts.add(row.fact_id);
    const from = Number(row.from_fact);
    if (row.from_fact !== null && Number.isSafeInteger(from)) facts.add(from);
  }
  return [...facts];
}

export interface SweepWindow {
  /** Facts to sweep, ascending. */
  facts: number[];
  /** Reports of the window whose publication and row name no fact, ascending. */
  standalone: string[];
  reports: number;
  /** A source read as many entries as it may: its oldest ones wait. */
  full: boolean;
}

const ids = (value: unknown): number[] => (Array.isArray(value) ? value : [value]).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);

/** What one sweep covers, read anew by each of its runs (so a continuation sees what changed meanwhile). */
export async function sweepWindow(since: Date, db: Db = sql, limit = REPAIR_WINDOW_LIMIT): Promise<SweepWindow> {
  const discovered = await newsDiscoveredSince(since, limit, db);
  const republished = await poolPublicationsUpdatedSince(since, limit, db);
  const decided = await decidedSince(since, limit, db);
  const corrections = await groupingCorrectionsSince(since, limit, db);
  const reports = [...new Set([...discovered, ...republished, ...decided.ids])];
  const facts = new Set<number>();
  // A detach names the facts the report left; a story merge, the story whose start may have moved.
  const merged = new Set<number>();
  for (const c of corrections) {
    const detail = (c.action === "content.detach" ? c.before : c.after) as { facts?: unknown; into?: unknown } | null;
    if (c.action === "content.detach") for (const factId of ids(detail?.facts ?? [])) facts.add(factId);
    else for (const storyId of ids(detail?.into ?? [])) merged.add(storyId);
  }
  for (const factId of await storyFacts([...merged], STORY_FACT_LIMIT, db)) facts.add(factId);
  const standalone: string[] = [];
  // In slices, so each lookup goes by its index.
  for (let i = 0; i < reports.length; i += LOOKUP_SLICE) {
    const slice = reports.slice(i, i + LOOKUP_SLICE);
    for (const factId of await factsOfReports(slice, db)) facts.add(factId);
    for (const [id, place] of await publicationPlaces(slice, db)) {
      if (place.factId !== null) facts.add(place.factId);
      if (place.rankedFactId !== null) facts.add(place.rankedFactId);
      if (place.factId === null && place.rankedFactId === null) standalone.push(id);
    }
  }
  return {
    facts: [...facts].sort((x, y) => x - y),
    standalone: standalone.sort(),
    reports: reports.length,
    full: discovered.length >= limit || republished.length >= limit || decided.full || corrections.length >= limit,
  };
}

const After = z.union([z.object({ fact: z.number().int() }).strict(), z.object({ report: z.string().min(1) }).strict()]);
export type SweepAfter = z.infer<typeof After>;

export interface SweepOutcome {
  /** Every fact and report of the window was swept. */
  done: boolean;
  /** Switched off during the sweep. */
  stopped: boolean;
  /** The last page finished (its last fact, or after the facts its last report): where a continuation goes on. */
  next: SweepAfter | null;
  window: { facts: number; standalone: number; reports: number; full: boolean };
  /** Facts whose timing was recomputed, and those among them whose day, basis, first report or story moved. */
  facts: number;
  moved: number;
  rows: { written: number; removed: number; unchanged: number };
  failures: number;
}

export interface SweepOptions {
  budget?: number;
  page?: number;
  /** Steps between two looks at the switch and the budget inside a page. */
  checkEvery?: number;
  /** Entries read per source of the window. */
  windowLimit?: number;
  /** Read before every page and every `checkEvery` steps; off stops the sweep there. */
  enabled?: () => Promise<boolean>;
  /** Called after every page (tests). */
  afterPage?: () => Promise<void>;
}

class Halt extends Error {
  readonly why: "budget" | "off";
  constructor(why: "budget" | "off") {
    super(why);
    this.why = why;
  }
}

/**
 * Sweep the window from `since` on, going on after `after`. The switch is read before every page and every `checkEvery`
 * steps; off stops the sweep at once. Past `budget` steps the run stops at the next look too, except in its first page,
 * which it always finishes (so a page larger than the budget still gets done); a page left half way is done again by the
 * continuation.
 */
export async function sweepEventOrder(o: { since: Date; after: SweepAfter | null } & SweepOptions, db: Db = sql): Promise<SweepOutcome> {
  const budget = o.budget ?? REPAIR_BUDGET;
  const size = o.page ?? REPAIR_PAGE;
  const every = o.checkEvery ?? CHECK_EVERY;
  const enabled = o.enabled ?? (() => eventShadowEnabled());
  const w = await sweepWindow(o.since, db, o.windowLimit);
  const out: SweepOutcome = {
    done: false,
    stopped: false,
    next: o.after,
    window: { facts: w.facts.length, standalone: w.standalone.length, reports: w.reports, full: w.full },
    facts: 0,
    moved: 0,
    rows: { written: 0, removed: 0, unchanged: 0 },
    failures: 0,
  };
  // A fact or report is done once per run, however many pages name it.
  const observed = new Set<number>();
  const projected = new Set<string>();
  let steps = 0,
    pages = 0;
  const turn = slicer();
  const look = async () => {
    if (!(await enabled())) throw new Halt("off");
    if (steps >= budget && pages > 0) throw new Halt("budget");
  };
  const step = async () => {
    steps++;
    await turn();
    if (steps % every === 0) await look();
  };
  const failed = (what: string, error: unknown) => {
    out.failures++;
    console.warn(`[event-order-repair] could not repair ${what}: ${String(error).slice(0, 200)}`);
  };
  const observe = async (factIds: readonly number[]) => {
    for (const factId of factIds) {
      if (observed.has(factId)) continue;
      observed.add(factId);
      out.facts++;
      try {
        out.moved += (await observeFactTiming([factId], db)).length;
      } catch (error) {
        failed(`fact ${factId}`, error);
      }
      await step();
    }
  };
  const project = async (reports: readonly string[]) => {
    const todo = [...new Set(reports)].filter((id) => !projected.has(id));
    // A row reads the timing of the fact its publication is in now: that fact is recomputed first.
    const places = await publicationPlaces(todo, db);
    await observe([...new Set(todo.flatMap((id) => places.get(id)?.factId ?? []))]);
    for (const id of todo) {
      projected.add(id);
      try {
        out.rows[await projectEventOrder(id, db)]++;
      } catch (error) {
        failed(`report ${id}`, error);
      }
      await step();
    }
  };
  const page = async (run: () => Promise<void>) => {
    await look();
    await run();
    pages++;
    await o.afterPage?.();
  };

  try {
    const facts = o.after === null ? w.facts : "fact" in o.after ? w.facts.filter((id) => id > (o.after as { fact: number }).fact) : [];
    for (let i = 0; i < facts.length; i += size) {
      const batch = facts.slice(i, i + size);
      await page(async () => {
        await observe(batch); // (A)
        const reports: string[] = [];
        for (const factId of batch) reports.push(...(await factPublications(factId, FACT_MEMBER_LIMIT, db)));
        await project(reports); // (B)
      });
      out.next = { fact: batch.at(-1)! };
    }
    const after = o.after !== null && "report" in o.after ? o.after.report : null;
    const standalone = after === null ? w.standalone : w.standalone.filter((id) => id > after);
    for (let i = 0; i < standalone.length; i += STANDALONE_PAGE) {
      const batch = standalone.slice(i, i + STANDALONE_PAGE);
      await page(() => project(batch));
      out.next = { report: batch.at(-1)! };
    }
  } catch (error) {
    if (!(error instanceof Halt)) throw error;
    out.stopped = error.why === "off";
    return out;
  }
  out.done = true;
  return out;
}

const Payload = z.object({ lane: z.literal("news"), sweep: z.object({ since: z.string().datetime(), after: After.nullable() }).strict().optional() }).strict();
type RepairJob = z.infer<typeof Payload>;
const SINGLETON = "order-repair";

/** One run of a sweep: a new sweep (no `sweep`) looks back REPAIR_WINDOW_HOURS; a run that stops at its budget queues the next. */
export async function runOrderRepair(job: RepairJob, opts: SweepOptions = {}) {
  const data = Payload.parse(job);
  const since = data.sweep ? new Date(data.sweep.since) : new Date(Date.now() - REPAIR_WINDOW_HOURS * HOUR);
  const outcome = await sweepEventOrder({ since, after: data.sweep?.after ?? null, ...opts });
  if (!outcome.done && !outcome.stopped)
    await enqueueOn(
      orderRepairQueue,
      { lane: "news", sweep: { since: since.toISOString(), after: outcome.next } },
      { singletonKey: SINGLETON, startAfter: CONTINUE_AFTER_SECONDS },
    );
  return { state: outcome.done ? "swept" : outcome.stopped ? "stopped" : "continued", since: since.toISOString(), ...outcome };
}

export const orderRepairQueue = defineQueue<RepairJob>({
  name: "news.events.order-repair",
  options: { policy: "short", retryLimit: 1, retryDelay: 300, expireInSeconds: 1800 },
  worker: { localConcurrency: 1, pollingIntervalSeconds: 30, batchSize: 1 },
  async run([job]) {
    if (!job) return;
    if (!(await eventShadowEnabled())) return { state: "skipped", reason: "switched_off" };
    return runOrderRepair(job);
  },
});

let failures = 0;
/**
 * The hourly timer (apps/worker/src/schedules.ts): starts a sweep while the switch is on and no sweep is waiting,
 * retrying or running. Never throws: a failure is logged and counted.
 */
export async function scheduleOrderRepair(): Promise<{ queued: boolean; reason?: "switched_off" | "sweep_under_way" }> {
  try {
    if (!(await eventShadowEnabled())) return { queued: false, reason: "switched_off" };
    if (await queueBusy(orderRepairQueue.name)) return { queued: false, reason: "sweep_under_way" };
    return { queued: (await enqueueOn(orderRepairQueue, { lane: "news" }, { singletonKey: SINGLETON })) !== null };
  } catch (error) {
    failures++;
    console.warn(`[event-order-repair] could not queue a sweep (${failures} failures since start): ${String(error).slice(0, 200)}`);
    return { queued: false };
  }
}
