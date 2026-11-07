// One real-world event must not stay split into several stories (TASK-0575, DEC-78补充 2026-11-07).
//
// Why stories split: a development attaches only to the fact that started its story (root-only rule, relate.ts
// storyForDevelopment), recall only sees reports of the last 14 days, and roots age out of that window first. A
// long-running event therefore founds a new story whenever its root is out of reach, and consolidate() compares the
// two roots, which are often far apart in content. The pieces here close that class of split:
//
// - sweepStoryMerges (hourly, stories.merge): candidate pairs are queued intake pairs, live "related" pairs and live
//   stories that share their main entity and category within MERGE_WINDOW_DAYS whose roots are similar on stored
//   embeddings (MERGE_GATE_MIN_COSINE; no new embedding). The EARLIER story's LATEST fact is judged against the LATER
//   story's ROOT with the existing story judgement (judgeStories: group_story ≥ TIE_MIN_CONFIDENCE, then
//   group_story_review ≥ STORY_REVIEW_MIN_CONFIDENCE, both must agree) and the later story merges into the earlier one
//   through mergeStoryInto (aliases redirect, withdrawals are captured, story text is refreshed). At most
//   MERGE_MAX_JUDGEMENTS pairs a run, none during the provider's peak hours, nothing while the news lane is paused;
//   stories a person made or holds a manual fact in are never merged here. Every judgement is a row of
//   events.story_merge_decisions keyed by both stories' content (input key), so an unchanged pair is never bought twice.
// - queueStoryMergePairs (intake, group.ts decide): a firm SAME_STORY tie to a non-root fact of another story is queued
//   here instead of being dropped, so the sweep judges it within the hour. No model call at intake.
// - attachReportGroupsToStories: report groups (same report, several outlets, no fact of their own) are attached to the
//   story their members are firmly tied to in their own current grouping decisions. No model call.
// - measureStoryDuplicates (daily) and duplicateStoryFindings (ops.alerts): the number of live story pairs that pass the
//   candidate gate but are neither merged nor judged different, and of reader-visible report groups with no story.
import { beijingDate } from "@amp/contracts/time";
import { readStoryGateProfiles } from "@amp/backend/publication/publish";
import { newsMaterialBindings } from "@amp/backend/content/materials";
import { sql, type Db } from "../db.ts";
import { environmentValue } from "../config.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { offPeakWait } from "../providers/peak-hours.ts";
import { completeReceipt } from "../providers/receipts.ts";
import { EMBEDDING_MODEL } from "../providers/embeddings.ts";
import type { Finding } from "../notify/feishu.ts";
import {
  assertRuntimeControl,
  requireRuntimeRunning,
  runtimeControlSnapshot,
  RuntimeControlPaused,
  type RuntimeControlSnapshot,
} from "../operations/lane-controls.ts";
import { firmlyTied, lexicalSimilarity, LEXICAL_RECALL_MIN, RELATE_PROMPT_VERSION, reportText, STORY_REVIEW_MIN_CONFIDENCE, type Relation } from "./relate.ts";
import { mergeStoryInto } from "./merge.ts";
import { judgeStories, liveStory, storyEndFacts, storyFactView, waitingError, type StoryEnd, type StoryRoot } from "./group.ts";

export const MERGE_SWEEP_VERSION = "story-merge-sweep-v1";
/** Two stories are candidates when the later one starts at most this long after the earlier one's newest report. */
export const MERGE_WINDOW_DAYS = 45;
/** Root similarity on stored embeddings a gate pair needs (the live recall bar, group.ts RECALL_MIN_COSINE). */
export const MERGE_GATE_MIN_COSINE = 0.6;
/** Without a stored vector on either side the lexical stand-in decides, at the live recall's lexical bar. */
export const MERGE_GATE_MIN_LEXICAL = LEXICAL_RECALL_MIN;
/** Pairs one run judges (each up to two calls: judge and review). */
export const MERGE_MAX_JUDGEMENTS = 20;
/** Queued intake pairs older than this are dropped from the queue (the gate or the related links still cover them). */
const QUEUE_DAYS = 30;
/**
 * The daily count of suspected duplicate pairs above which ops.alerts raises a follow-up. The sweep can judge up to
 * 480 pairs a day and remembers every answer, so in steady state the count stays near zero; more than 10 left over
 * means the sweep is not keeping up (paused lane, waiting model route, failures) or the gate admits too much.
 */
export const DUPLICATE_PAIRS_ALERT_DEFAULT = 10;
const duplicateAlertThreshold = () => {
  const raw = Number(environmentValue("ALERT_DUPLICATE_STORY_PAIRS") ?? Number.NaN);
  return Number.isInteger(raw) && raw >= 0 ? raw : DUPLICATE_PAIRS_ALERT_DEFAULT;
};

type Origin = "intake" | "related" | "gate" | "backfill";
type Outcome = "queued" | "merged" | "different" | "skipped";
const ORIGIN_ORDER: Record<Origin, number> = { intake: 0, related: 1, backfill: 2, gate: 2 };

interface Decision {
  low: number;
  high: number;
  outcome: Outcome;
  inputKey: string | null;
  earlierFactId: number | null;
  laterFactId: number | null;
  createdAt: Date;
}

/** A pair to look at: the two live stories, ordered by when each started, and why it is a candidate. */
export interface MergeCandidate {
  earlier: number;
  later: number;
  origin: Origin;
  /** Root similarity (gate pairs), else null. */
  similarity: number | null;
  /** The facts and reports a judgement would read; their identity is the pair's input key. */
  earlierLatest: StoryEnd;
  laterRoot: StoryEnd;
  inputKey: string;
  /** Judged before with this same input (different, or skipped for a person's hold): nothing to buy. */
  settled: boolean;
}

const pairKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

function inputKeyOf(earlier: number, later: number, latest: StoryEnd, root: StoryEnd) {
  return sha256(
    stableJson([
      MERGE_SWEEP_VERSION,
      RELATE_PROMPT_VERSION,
      earlier,
      later,
      latest.factId,
      latest.articleId,
      latest.revision,
      root.factId,
      root.articleId,
      root.revision,
    ]),
  );
}

async function latestDecisions(pairs: Array<[number, number]>, db: Db = sql): Promise<Map<string, Decision>> {
  if (!pairs.length) return new Map();
  const low = pairs.map(([a, b]) => Math.min(a, b)),
    high = pairs.map(([a, b]) => Math.max(a, b));
  const rows = await db<
    {
      low_story_id: number;
      high_story_id: number;
      outcome: Outcome;
      input_key: string | null;
      earlier_fact_id: number | null;
      later_fact_id: number | null;
      created_at: Date;
    }[]
  >`SELECT DISTINCT ON (d.low_story_id,d.high_story_id) d.low_story_id,d.high_story_id,d.outcome,d.input_key,d.earlier_fact_id,d.later_fact_id,d.created_at
    FROM events.story_merge_decisions d JOIN unnest(${low}::bigint[],${high}::bigint[]) AS p(lo,hi) ON d.low_story_id=p.lo AND d.high_story_id=p.hi
    WHERE d.outcome<>'queued' ORDER BY d.low_story_id,d.high_story_id,d.id DESC`;
  return new Map(
    rows.map((r) => [
      pairKey(Number(r.low_story_id), Number(r.high_story_id)),
      {
        low: Number(r.low_story_id),
        high: Number(r.high_story_id),
        outcome: r.outcome,
        inputKey: r.input_key,
        earlierFactId: r.earlier_fact_id === null ? null : Number(r.earlier_fact_id),
        laterFactId: r.later_fact_id === null ? null : Number(r.later_fact_id),
        createdAt: r.created_at,
      },
    ]),
  );
}

async function recordDecision(
  row: {
    a: number;
    b: number;
    earlier?: number | null;
    origin: Origin;
    outcome: Outcome;
    reason?: string | null;
    inputKey?: string | null;
    earlierFactId?: number | null;
    laterFactId?: number | null;
    first?: { relation: Relation; confidence: number } | null;
    second?: { relation: Relation; confidence: number } | null;
    receiptIds?: number[];
    detail?: unknown;
  },
  db: Db = sql,
) {
  await db`INSERT INTO events.story_merge_decisions(low_story_id,high_story_id,earlier_story_id,origin,outcome,reason,input_key,earlier_fact_id,later_fact_id,
      first_relation,first_confidence,second_relation,second_confidence,receipt_ids,detail)
    VALUES(${Math.min(row.a, row.b)},${Math.max(row.a, row.b)},${row.earlier ?? null},${row.origin},${row.outcome},${row.reason ?? null},${row.inputKey ?? null},
      ${row.earlierFactId ?? null},${row.laterFactId ?? null},${row.first?.relation ?? null},${row.first ? Math.round(row.first.confidence * 1000) / 1000 : null},
      ${row.second?.relation ?? null},${row.second ? Math.round(row.second.confidence * 1000) / 1000 : null},${row.receiptIds ?? []}::bigint[],
      ${row.detail === undefined ? null : db.json(row.detail as never)})`;
}

/**
 * Intake (group.ts decide): stories a new report is firmly tied to as a development of a non-root fact. The root-only
 * rule does not attach the report there, so the pair waits here for the next sweep instead of staying split.
 */
export async function queueStoryMergePairs(storyId: number, others: number[], articleId: string, db: Db = sql): Promise<number> {
  let queued = 0;
  for (const other of [...new Set(others)].filter((id) => id !== storyId).sort((a, b) => a - b)) {
    const [last] = await db<{ outcome: Outcome; recent: boolean }[]>`SELECT outcome,created_at>now()-make_interval(days=>${QUEUE_DAYS}) AS recent
      FROM events.story_merge_decisions WHERE low_story_id=${Math.min(storyId, other)} AND high_story_id=${Math.max(storyId, other)} ORDER BY id DESC LIMIT 1`;
    if (last?.outcome === "queued" && last.recent) continue;
    await recordDecision({ a: storyId, b: other, origin: "intake", outcome: "queued", reason: "非根事实的同一事件进展", detail: { articleId } }, db);
    queued++;
  }
  return queued;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

interface StoryProfile {
  id: number;
  origin: string;
  firstAt: number;
  latestAt: number;
  /** The most frequent entity tag of the story's reports, else its root fact's subject. */
  entity: string | null;
  /** The most frequent category of the story's reports. */
  category: string | null;
}

const mostFrequent = (values: string[]) => {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
};

async function storyProfiles(storyIds: number[], ends: Map<number, { root: StoryEnd; latest: StoryEnd }>, db: Db = sql) {
  if (!storyIds.length) return new Map<number, StoryProfile>();
  const stories = await db<{ id: number; origin: string; first_report_at: Date | null; latest_at: Date | null }[]>`
    SELECT id,origin,first_report_at,latest_at FROM stories WHERE id=ANY(${storyIds}::bigint[])`;
  const members = await db<{ story_id: number; article_id: string; subject: string | null; fact_id: number }[]>`
    SELECT f.story_id,fa.article_id,f.subject,f.id AS fact_id FROM facts f JOIN fact_articles fa ON fa.fact_id=f.id AND fa.role IN ('primary','report')
    WHERE f.story_id=ANY(${storyIds}::bigint[])`;
  const profiles = new Map((await readStoryGateProfiles([...new Set(members.map((m) => m.article_id))], db)).map((p) => [p.article_id, p]));
  const out = new Map<number, StoryProfile>();
  for (const s of stories) {
    const id = Number(s.id);
    const own = members.filter((m) => Number(m.story_id) === id);
    const tags = own.flatMap((m) => (profiles.get(m.article_id)?.tags ?? []).filter((t) => t.startsWith("entity:")));
    const root = ends.get(id)?.root;
    const subject = own
      .find((m) => Number(m.fact_id) === root?.factId)
      ?.subject?.trim()
      .toLowerCase();
    out.set(id, {
      id,
      origin: s.origin,
      firstAt: (s.first_report_at ?? s.latest_at ?? new Date(0)).getTime(),
      latestAt: (s.latest_at ?? s.first_report_at ?? new Date(0)).getTime(),
      entity: mostFrequent(tags) ?? (subject ? `subject:${subject}` : null),
      category: mostFrequent(own.flatMap((m) => (profiles.get(m.article_id)?.category ? [profiles.get(m.article_id)!.category!] : []))),
    });
  }
  return out;
}

/** Root similarity from stored vectors only (no embedding is bought here), else the lexical stand-in on public wording. */
async function rootSimilarity(articleIds: string[], db: Db = sql) {
  const vectors = new Map(
    (
      await db<{ ref_id: string; vector: number[] }[]>`SELECT ref_id,vector FROM embeddings WHERE kind='article' AND model=${EMBEDDING_MODEL}
        AND ref_id=ANY(${articleIds}::text[])`
    ).map((r) => [r.ref_id, r.vector]),
  );
  const texts = new Map((await readStoryGateProfiles(articleIds, db)).map((p) => [p.article_id, reportText(p.title, p.summary)]));
  return (x: string, y: string) => {
    const a = vectors.get(x),
      b = vectors.get(y);
    if (a && b && a.length === b.length) {
      let dot = 0,
        na = 0,
        nb = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i]! * b[i]!;
        na += a[i]! * a[i]!;
        nb += b[i]! * b[i]!;
      }
      const score = na && nb ? dot / Math.sqrt(na * nb) : 0;
      return { score, passes: score >= MERGE_GATE_MIN_COSINE };
    }
    const score = lexicalSimilarity(texts.get(x) ?? "", texts.get(y) ?? "");
    return { score, passes: score >= MERGE_GATE_MIN_LEXICAL };
  };
}

/**
 * Every candidate pair of live stories: intake queue, related links, and the gate over stories with a report in the
 * last `days` days (main entity and category shared, within MERGE_WINDOW_DAYS, similar roots). Model-free.
 */
export async function planStoryMerges(opts: { days?: number; now?: Date; gateOrigin?: Origin } = {}): Promise<MergeCandidate[]> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - (opts.days ?? MERGE_WINDOW_DAYS) * 86400_000);
  const pairs = new Map<string, { a: number; b: number; origin: Origin; similarity: number | null }>();
  const add = (a: number, b: number, origin: Origin, similarity: number | null = null) => {
    if (a === b) return;
    const key = pairKey(a, b),
      before = pairs.get(key);
    if (!before || ORIGIN_ORDER[origin] < ORIGIN_ORDER[before.origin]) pairs.set(key, { a, b, origin, similarity: similarity ?? before?.similarity ?? null });
  };
  // Queued intake pairs still waiting (no judgement after the queue entry), resolved to the stories they live in now.
  const open = await sql<{ low_story_id: number; high_story_id: number; outcome: string }[]>`
    SELECT DISTINCT ON (low_story_id,high_story_id) low_story_id,high_story_id,outcome FROM events.story_merge_decisions
    WHERE (low_story_id,high_story_id) IN (SELECT low_story_id,high_story_id FROM events.story_merge_decisions WHERE outcome='queued'
      AND created_at>now()-make_interval(days=>${QUEUE_DAYS})) ORDER BY low_story_id,high_story_id,id DESC`;
  for (const row of open.filter((r) => r.outcome === "queued")) {
    const [a, b] = [await liveStory(Number(row.low_story_id)), await liveStory(Number(row.high_story_id))];
    if (a !== null && b !== null) add(a, b, "intake");
  }
  const related = await sql<{ story_id: number; other_id: number }[]>`
    SELECT l.story_id,l.other_id FROM story_links l JOIN stories a ON a.id=l.story_id AND a.merged_into IS NULL
    JOIN stories b ON b.id=l.other_id AND b.merged_into IS NULL WHERE l.relation='related' AND l.story_id<l.other_id`;
  for (const r of related) add(Number(r.story_id), Number(r.other_id), "related");
  const recent = (await sql<{ id: number }[]>`SELECT id FROM stories WHERE merged_into IS NULL AND latest_at>=${since} ORDER BY id`).map((r) => Number(r.id));
  const all = [...new Set([...recent, ...[...pairs.values()].flatMap((p) => [p.a, p.b])])];
  const ends = await storyEndFacts(all);
  const profiles = await storyProfiles(all, ends);
  // Gate: same main entity and category, within the window, similar roots.
  const buckets = new Map<string, StoryProfile[]>();
  for (const id of recent) {
    const p = profiles.get(id);
    if (!p?.entity || !p.category || !ends.has(id)) continue;
    const key = `${p.entity}|${p.category}`;
    buckets.set(key, [...(buckets.get(key) ?? []), p]);
  }
  const gate = [...buckets.values()].filter((b) => b.length > 1);
  if (gate.length) {
    const similar = await rootSimilarity([...new Set(gate.flat().map((p) => ends.get(p.id)!.root.articleId))]);
    for (const bucket of gate)
      for (let i = 0; i < bucket.length; i++)
        for (let j = i + 1; j < bucket.length; j++) {
          const [x, y] = [bucket[i]!, bucket[j]!];
          const [first, second] = x.firstAt <= y.firstAt ? [x, y] : [y, x];
          if (second.firstAt - first.latestAt > MERGE_WINDOW_DAYS * 86400_000) continue;
          const sim = similar(ends.get(x.id)!.root.articleId, ends.get(y.id)!.root.articleId);
          if (sim.passes) add(x.id, y.id, opts.gateOrigin ?? "gate", Math.round(sim.score * 1000) / 1000);
        }
  }
  const decided = await latestDecisions([...pairs.values()].map((p) => [p.a, p.b]));
  const out: MergeCandidate[] = [];
  for (const p of pairs.values()) {
    const ea = ends.get(p.a),
      eb = ends.get(p.b);
    if (!ea || !eb) continue;
    const aFirst = ea.root.at < eb.root.at || (ea.root.at === eb.root.at && p.a < p.b);
    const [earlier, later] = aFirst ? [p.a, p.b] : [p.b, p.a];
    const earlierLatest = (aFirst ? ea : eb).latest,
      laterRoot = (aFirst ? eb : ea).root;
    const inputKey = inputKeyOf(earlier, later, earlierLatest, laterRoot);
    const prior = decided.get(pairKey(p.a, p.b));
    out.push({
      earlier,
      later,
      origin: p.origin,
      similarity: p.similarity,
      earlierLatest,
      laterRoot,
      inputKey,
      settled: !!prior && prior.inputKey === inputKey && (prior.outcome === "different" || prior.outcome === "skipped"),
    });
  }
  return out.sort(
    (x, y) => ORIGIN_ORDER[x.origin] - ORIGIN_ORDER[y.origin] || (y.similarity ?? 0) - (x.similarity ?? 0) || x.earlier - y.earlier || x.later - y.later,
  );
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

export interface StoryMergeResult {
  /** Candidate pairs found (all origins), and those not settled by an earlier answer. */
  candidates: number;
  pending: number;
  /** Pairs judged this run (each up to two model calls). */
  judged: number;
  merged: Array<{ from: number; into: number }>;
  different: number;
  skipped: number;
  paused?: boolean;
  /** Why the run stopped early: the judgement cap, peak hours, or a waiting model route, budget or control. */
  stopped?: string;
  failed?: number;
  error?: string;
  reportGroups?: { attached: number; changed: number; groups: number };
}

/** Stories a person made, or that hold a fact a person placed, are never merged automatically. */
async function manualHold(storyIds: number[]): Promise<Set<number>> {
  const rows = await sql<{ id: number }[]>`SELECT id FROM stories WHERE id=ANY(${storyIds}::bigint[]) AND origin='manual'
    UNION SELECT story_id FROM facts WHERE story_id=ANY(${storyIds}::bigint[]) AND manual`;
  return new Set(rows.map((r) => Number(r.id)));
}

/**
 * The hourly sweep (stories.merge). `origin` marks gate pairs of the one-off backfill; `days` widens the stories the
 * gate looks at. Peak hours and a paused news lane judge nothing (queued pairs wait); the attachment of report groups
 * runs either way, as it needs no model.
 */
export async function sweepStoryMerges(opts: { maxJudgements?: number; now?: Date; days?: number; origin?: Origin } = {}): Promise<StoryMergeResult> {
  const peak = offPeakWait(opts.now) !== null;
  const cap = peak ? 0 : Math.max(0, opts.maxJudgements ?? MERGE_MAX_JUDGEMENTS);
  const out: StoryMergeResult = { candidates: 0, pending: 0, judged: 0, merged: [], different: 0, skipped: 0 };
  let control: RuntimeControlSnapshot;
  try {
    await requireRuntimeRunning("news", ["processing", "publication"]);
    control = await runtimeControlSnapshot("news", ["processing", "publication"]);
  } catch (error) {
    if (error instanceof RuntimeControlPaused) return { ...out, paused: true };
    throw error;
  }
  const plan = await planStoryMerges({ days: opts.days, now: opts.now, gateOrigin: opts.origin === "backfill" ? "backfill" : "gate" });
  out.candidates = plan.length;
  const pending = plan.filter((c) => !c.settled);
  out.pending = pending.length;
  const held = await manualHold([...new Set(pending.flatMap((c) => [c.earlier, c.later]))]);
  const gone = new Set<number>();
  for (const c of pending) {
    if (gone.has(c.earlier) || gone.has(c.later)) continue;
    const base = {
      a: c.earlier,
      b: c.later,
      earlier: c.earlier,
      origin: c.origin,
      inputKey: c.inputKey,
      earlierFactId: c.earlierLatest.factId,
      laterFactId: c.laterRoot.factId,
    };
    if (held.has(c.earlier) || held.has(c.later)) {
      await recordDecision({ ...base, outcome: "skipped", reason: "人工锁定的事件不自动合并" });
      out.skipped++;
      continue;
    }
    if (out.judged >= cap) {
      out.stopped = peak ? "peak-hours" : "call-limit";
      break;
    }
    try {
      const [a, b] = [await storyFactView(c.earlier, c.earlierLatest.factId), await storyFactView(c.later, c.laterRoot.factId)];
      if (!a || !b) continue;
      if (a.roundup || b.roundup) {
        await recordDecision({ ...base, outcome: "skipped", reason: "综合稿开头的事件不合并" });
        out.skipped++;
        continue;
      }
      out.judged++;
      const verdict = await judgePair(a, b);
      const receiptIds = [verdict.first.receiptId, ...(verdict.second ? [verdict.second.receiptId] : [])];
      const answers = { first: verdict.first, second: verdict.second, receiptIds, detail: { similarity: c.similarity, difference: verdict.difference } };
      if (!verdict.merge) {
        await recordDecision({ ...base, ...answers, outcome: "different", reason: "模型判为不同事件" });
        out.different++;
        continue;
      }
      const merged = await mergeStoryInto(
        c.later,
        c.earlier,
        `同一事件（合并检查：${verdict.first.relation}，复核 ${verdict.second?.relation}）：${b.report.title}｜${a.report.title}`,
        "grouping",
        (tx) => assertRuntimeControl(tx, control),
      );
      if (!merged) {
        await recordDecision({ ...base, ...answers, outcome: "skipped", reason: "合并前事件已变化" });
        out.skipped++;
        continue;
      }
      await recordDecision({ ...base, ...answers, outcome: "merged", reason: "两次判断均为同一事件" });
      out.merged.push({ from: c.later, into: c.earlier });
      gone.add(c.later);
    } catch (error) {
      if (waitingError(error)) {
        out.stopped = String(error).slice(0, 300);
        break;
      }
      // One pair's changed material or permission does not stop the others.
      out.failed = (out.failed ?? 0) + 1;
      out.error ??= String(error).slice(0, 300);
    }
  }
  out.reportGroups = await attachReportGroupsToStories();
  return out;
}

/** The story judgement both ways round: the judge on (earlier's newest fact, later root), then the review model. */
async function judgePair(a: StoryRoot, b: StoryRoot) {
  const first = await judgeStories("group", a, b);
  await completeReceipt(sql, first.receiptId);
  if (!firmlyTied(first.relation, first.confidence))
    return {
      merge: false,
      first: { relation: first.relation, confidence: first.confidence, receiptId: first.receiptId },
      second: null,
      difference: first.difference,
    };
  const second = await judgeStories("groupReview", b, a);
  await completeReceipt(sql, second.receiptId);
  return {
    merge: firmlyTied(second.relation, second.confidence, STORY_REVIEW_MIN_CONFIDENCE),
    first: { relation: first.relation, confidence: first.confidence, receiptId: first.receiptId },
    second: { relation: second.relation, confidence: second.confidence, receiptId: second.receiptId },
    difference: first.difference || second.difference,
  };
}

// ---------------------------------------------------------------------------
// One-off backfill (scripts/story-merge-backfill.ts)
// ---------------------------------------------------------------------------

/** Stories with a report in the last BACKFILL_DAYS days are swept once (Owner 2026-11-07: about 30 days of content). */
export const BACKFILL_DAYS = 30;

export interface BackfillPlan {
  days: number;
  /** Candidate pairs, those an earlier answer already settles, and those that would be judged. */
  pairs: number;
  settled: number;
  pending: number;
  byOrigin: Record<string, number>;
  /** Model calls: at least one per pending pair (the judge), at most two (judge and review). */
  calls: { min: number; max: number };
  /** Report groups readers see, and how many of them the model-free attachment would place in a story. */
  reportGroups: number;
}

/** Dry run: what the backfill would judge and roughly what it costs. No model call, no write. */
export async function planStoryMergeBackfill(opts: { days?: number; now?: Date } = {}): Promise<BackfillPlan> {
  const days = opts.days ?? BACKFILL_DAYS;
  const plan = await planStoryMerges({ days, now: opts.now, gateOrigin: "backfill" });
  const pending = plan.filter((c) => !c.settled);
  const byOrigin: Record<string, number> = {};
  for (const c of pending) byOrigin[c.origin] = (byOrigin[c.origin] ?? 0) + 1;
  const { readCurrentReportGroups } = await import("@amp/backend/publication/groups");
  return {
    days,
    pairs: plan.length,
    settled: plan.length - pending.length,
    pending: pending.length,
    byOrigin,
    calls: { min: pending.length, max: pending.length * 2 },
    reportGroups: (await readCurrentReportGroups()).length,
  };
}

/**
 * Apply: sweeps in rounds of MERGE_MAX_JUDGEMENTS until no pair is left or a round stops early (peak hours, a paused
 * lane, a waiting model route). Every answer is stored, so running it again resumes where it stopped.
 */
export async function applyStoryMergeBackfill(opts: { days?: number; rounds?: number; now?: Date; onRound?: (round: StoryMergeResult) => void } = {}) {
  const totals = { rounds: 0, judged: 0, merged: 0, different: 0, skipped: 0, failed: 0, stopped: null as string | null };
  for (let round = 0; round < (opts.rounds ?? 1000); round++) {
    const result = await sweepStoryMerges({ days: opts.days ?? BACKFILL_DAYS, origin: "backfill", now: opts.now });
    totals.rounds++;
    totals.judged += result.judged;
    totals.merged += result.merged.length;
    totals.different += result.different;
    totals.skipped += result.skipped;
    totals.failed += result.failed ?? 0;
    opts.onRound?.(result);
    if (result.paused) {
      totals.stopped = "paused";
      break;
    }
    if (result.stopped && result.stopped !== "call-limit") {
      totals.stopped = result.stopped;
      break;
    }
    // A round that settled nothing: every remaining pair is settled, or fails on its own material (left for the hourly run).
    if (!result.merged.length && !result.different && !result.skipped) break;
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Report groups → stories (no model call)
// ---------------------------------------------------------------------------

const CandidateAnswer = (value: unknown) =>
  Array.isArray(value)
    ? value.flatMap((c) =>
        c && typeof c === "object" && "id" in c && "relation" in c
          ? [
              {
                factId: Number((c as { id: unknown }).id),
                relation: String((c as { relation: unknown }).relation),
                confidence: Number((c as { confidence?: unknown }).confidence ?? 0),
              },
            ]
          : [],
      )
    : [];

/**
 * Each reader-visible report group whose members' own current grouping decisions firmly tie it (SAME_OCCURRENCE or
 * SAME_STORY at TIE_MIN_CONFIDENCE, the bar consolidate and related links use) to facts of exactly one live story is
 * attached to that story: to the fact it is the same occurrence as, else as a development of its own. A member decision
 * counts only for the member's current material revision and never when the member was judged a roundup; ties to two
 * stories leave the group unattached. The fact_articles 'mention' rows are not used: they are written for roundups only
 * and include ROUNDUP answers, so they say a digest lists the fact, not that the report is about it.
 */
export async function attachReportGroupsToStories(db: Db = sql): Promise<{ attached: number; changed: number; groups: number; ambiguous: number }> {
  const { readCurrentReportGroups, projectReportGroupStories } = await import("@amp/backend/publication/groups");
  const groups = await readCurrentReportGroups(db);
  const ids = [...new Set(groups.flatMap((g) => g.memberIds))];
  const revisions = new Map((await newsMaterialBindings(ids, db)).map((m) => [m.id, m.revision]));
  const decisions = ids.length
    ? await db<{ article_id: string; verdict: string; input_revision: number | null; candidates: unknown }[]>`
        SELECT DISTINCT ON (article_id) article_id,verdict,input_revision,candidates FROM grouping_decisions
        WHERE article_id=ANY(${ids}::text[]) ORDER BY article_id,id DESC`
    : [];
  const ties = decisions.flatMap((d) =>
    d.verdict === "roundup" || d.input_revision === null || revisions.get(d.article_id) !== d.input_revision
      ? []
      : CandidateAnswer(d.candidates)
          .filter((c) => Number.isSafeInteger(c.factId) && firmlyTied(c.relation, c.confidence))
          .map((c) => ({ ...c, articleId: d.article_id })),
  );
  const facts = ties.length
    ? await db<{ id: number; story_id: number | null }[]>`SELECT id,story_id FROM facts WHERE id=ANY(${[...new Set(ties.map((t) => t.factId))]}::bigint[])`
    : [];
  const storyOfFact = new Map<number, number>();
  for (const f of facts) {
    const live = f.story_id === null ? null : await liveStory(Number(f.story_id));
    if (live !== null) storyOfFact.set(Number(f.id), live);
  }
  const rows: Array<{ groupId: string; storyId: number; factId: number | null; relation: "SAME_OCCURRENCE" | "SAME_STORY"; basis: unknown }> = [];
  let ambiguous = 0;
  for (const group of groups) {
    const own = ties.filter((t) => group.memberIds.includes(t.articleId) && storyOfFact.has(t.factId));
    const stories = [...new Set(own.map((t) => storyOfFact.get(t.factId)!))];
    if (stories.length !== 1) {
      if (stories.length > 1) ambiguous++;
      continue;
    }
    const same = own.filter((t) => t.relation === "SAME_OCCURRENCE").sort((x, y) => y.confidence - x.confidence || x.factId - y.factId)[0];
    rows.push({
      groupId: group.groupId,
      storyId: stories[0]!,
      factId: same?.factId ?? null,
      relation: same ? "SAME_OCCURRENCE" : "SAME_STORY",
      basis: own.map((t) => ({ articleId: t.articleId, factId: t.factId, relation: t.relation, confidence: t.confidence })),
    });
  }
  const projected = await projectReportGroupStories(rows, db);
  return { ...projected, groups: groups.length, ambiguous };
}

// ---------------------------------------------------------------------------
// Measurement and alert
// ---------------------------------------------------------------------------

export interface DuplicateMeasurement {
  day: string;
  suspectedPairs: number;
  unattachedReportGroups: number;
  /** A few suspected pairs (public story ids), for the person or AI following up. */
  examples: Array<{ earlier: string; later: string; origin: string }>;
}

/**
 * 疑似重复事件对数: live story pairs that pass the candidate gate (or are queued or linked as related) and are neither
 * merged (a merged story is not live) nor judged different on their current content. 无事件归属的共同报道数: report groups
 * readers see that are attached to no story. Model-free; stored per Beijing day.
 */
export async function measureStoryDuplicates(now = new Date()): Promise<DuplicateMeasurement> {
  const plan = await planStoryMerges({ now });
  const open = plan.filter((c) => !c.settled);
  const held = await manualHold([...new Set(open.flatMap((c) => [c.earlier, c.later]))]);
  const suspected = open.filter((c) => !held.has(c.earlier) && !held.has(c.later));
  const attach = await attachReportGroupsToStories();
  const ids = [...new Set(suspected.slice(0, 10).flatMap((c) => [c.earlier, c.later]))];
  const publicIds = new Map(
    (await sql<{ id: number; public_id: string }[]>`SELECT id,public_id::text FROM stories WHERE id=ANY(${ids}::bigint[])`).map((r) => [
      Number(r.id),
      r.public_id,
    ]),
  );
  const result: DuplicateMeasurement = {
    day: beijingDate(now),
    suspectedPairs: suspected.length,
    unattachedReportGroups: Math.max(0, attach.groups - attach.attached),
    examples: suspected.slice(0, 10).map((c) => ({ earlier: publicIds.get(c.earlier) ?? "", later: publicIds.get(c.later) ?? "", origin: c.origin })),
  };
  await sql`INSERT INTO events.story_duplicate_metrics(day,suspected_pairs,unattached_report_groups,detail)
    VALUES(${result.day},${result.suspectedPairs},${result.unattachedReportGroups},${sql.json({ examples: result.examples, ambiguousReportGroups: attach.ambiguous, reportGroups: attach.groups } as never)})
    ON CONFLICT(day) DO UPDATE SET suspected_pairs=EXCLUDED.suspected_pairs,unattached_report_groups=EXCLUDED.unattached_report_groups,detail=EXCLUDED.detail,measured_at=pg_catalog.clock_timestamp()`;
  return result;
}

async function latestMeasurement() {
  const [row] = await sql<
    { day: string; suspected_pairs: number; unattached_report_groups: number; detail: { examples?: DuplicateMeasurement["examples"] }; measured_at: Date }[]
  >`
    SELECT day::text,suspected_pairs,unattached_report_groups,detail,measured_at FROM events.story_duplicate_metrics ORDER BY day DESC LIMIT 1`;
  return row ?? null;
}

/** The latest measurement as rows of the ops snapshot's publication dataset (kind, state, count, time). */
export async function storyDuplicateSnapshotRows() {
  const row = await latestMeasurement();
  if (!row) return [];
  return [
    { kind: "news" as const, state: "suspected_duplicate_story_pairs", count: row.suspected_pairs, latest_at: row.measured_at },
    { kind: "news" as const, state: "report_groups_without_story", count: row.unattached_report_groups, latest_at: row.measured_at },
  ];
}

/**
 * ops.alerts: a follow-up when the latest count of suspected duplicate pairs is above ALERT_DUPLICATE_STORY_PAIRS
 * (default DUPLICATE_PAIRS_ALERT_DEFAULT), or when no measurement was stored for two days.
 */
export async function duplicateStoryFindings(now = Date.now()): Promise<Finding[]> {
  const row = await latestMeasurement();
  // No row yet: the daily job has not run since the deploy (its run record shows that); nothing to compare.
  if (!row) return [];
  if (now - row.measured_at.getTime() > 2 * 86400_000)
    return [
      {
        key: "events.duplicate-stories.stale",
        level: "digest",
        title: "疑似重复事件两天没有统计",
        detail: `最近一次统计 ${row.day}；看 stories.duplicates 的运行记录`,
      },
    ];
  const threshold = duplicateAlertThreshold();
  if (row.suspected_pairs <= threshold) return [];
  const examples = (row.detail.examples ?? []).slice(0, 5).map((e) => `${e.earlier} ↔ ${e.later}`);
  return [
    {
      key: "events.duplicate-stories",
      level: "digest",
      title: `疑似重复事件 ${row.suspected_pairs} 对，超过 ${threshold} 对`,
      detail: `统计日 ${row.day}；无事件归属的共同报道 ${row.unattached_report_groups} 组。合并检查（stories.merge）每小时最多判断 ${MERGE_MAX_JUDGEMENTS} 对，看它的运行记录是否暂停、等待或失败${examples.length ? `；例：${examples.join("；")}` : ""}`,
    },
  ];
}
