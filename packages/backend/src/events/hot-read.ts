import { reportPublicInputs, originalPostAffectedStories } from "../publication/groups.ts";
import { storiesWithdrawalAffected } from "../publication/stories.ts";
import { publicParticipation, participationHash } from "./participation-read.ts";
// Reading the latest published hot ranking. The web shows heat values; machine exits only ranks.
import type { HotStripEntry } from "@amp/contracts/site";
import { sql } from "../db.ts";
import { storyTextNeedsRefresh } from "@amp/backend/publication/reports";

export interface HotEntry {
  evidenceHash?: string;
  rank: number;
  storyId: number;
  storyPublicId: string;
  title: string;
  heat: number;
  /** "unknown": the earlier participants' sources were behind on collection, so there is no comparison. */
  trend: "up" | "down" | "flat" | "new" | "unknown";
  trendPct: number | null;
  badges: Array<"surge" | "new" | "rising">;
  participantCount: number;
  sourceCount: number;
  signalCount: number;
  reportCount: number;
  sourceNames: string[];
  latestAt: string;
  firstReportAt: string;
  representativeItemId: string | null;
  representativeUrl: string | null;
  representativeSource: string | null;
  /** 精选组 first by tier, then 氛围组; tier is absent on rankings from before 2026-09-29. */
  participants: Array<{ name: string; kind: "editorial" | "signal"; tier?: string }>;
}

/** 精选组 sources are listed T1 before T1.5 before T2. */
const TIER_ORDER = ["T1", "T1_5", "T2"];
export function tierRank(tier: string | undefined): number {
  const i = TIER_ORDER.indexOf(tier ?? "");
  return i < 0 ? TIER_ORDER.length : i;
}

export interface HotRanking {
  id: number;
  computedAt: string;
  ruleVersion: string;
  entries: HotEntry[];
  coverage: Record<string, unknown> | null;
}

let rankingPending: Promise<HotRanking | null> | null = null;

export function latestHotRanking(): Promise<HotRanking | null> {
  rankingPending ??= queryLatestHotRanking().finally(() => {
    rankingPending = null;
  });
  return rankingPending;
}

async function queryLatestHotRanking(): Promise<HotRanking | null> {
  const [row] = await sql<{ id: number; computed_at: Date; rule_version: string; entries: HotEntry[]; evidence: Record<string, unknown> | null }[]>`
    SELECT id, computed_at, rule_version, entries, evidence FROM hot_rankings WHERE published ORDER BY computed_at DESC,id DESC LIMIT 1`;
  if (!row) return null;
  const now = new Date();
  // The four current checks depend only on the stored ranking: read them together, not one after another.
  const [admissionAffected, inputs, current, signals] = await Promise.all([
    originalPostAffectedStories(row.entries.map((entry) => Number(entry.storyId))),
    reportPublicInputs(row.entries.flatMap((entry) => (entry.representativeItemId ? [entry.representativeItemId] : []))),
    sql<
      {
        id: number;
        public_id: string;
        title: string;
        merged_into: number | null;
        origin: string;
        version: number;
        updated_at: Date;
        digest_updated_at: Date | null;
        text_stale: boolean;
      }[]
    >`
    SELECT id,public_id::text,title,merged_into,origin,version,updated_at,digest_updated_at,((digest_updated_at IS NULL AND version>1) OR coalesce(updated_at>digest_updated_at,false)) AS text_stale FROM stories WHERE id=ANY(${row.entries.map((entry) => entry.storyId)}::bigint[])`,
    publicParticipation(
      row.entries.map((entry) => entry.storyId),
      now,
      // The ranking's own window (TASK-0599: 72 hours on Beijing Sat–Mon): a withdrawal anywhere in it changes the hash.
      new Date(now.getTime() - rankingWindowHours(row.evidence) * 3600000),
    ),
  ]);
  const representatives = new Map(inputs.map((value) => [value.id, value]));
  const valid = new Set(
    row.entries
      .filter((entry) => !!entry.evidenceHash && participationHash(signals.filter((signal) => signal.story_id === entry.storyId)) === entry.evidenceHash)
      .map((entry) => entry.storyId),
  );
  const byId = new Map(current.map((story) => [Number(story.id), story]));
  const shown = row.entries.flatMap((entry) => {
    if (!valid.has(Number(entry.storyId)) || admissionAffected.has(Number(entry.storyId))) return [];
    const story = byId.get(Number(entry.storyId));
    if (!story || story.merged_into || !entry.representativeItemId || representatives.get(entry.representativeItemId)?.story_id !== Number(entry.storyId))
      return [];
    return [{ entry, story, representative: representatives.get(entry.representativeItemId)! }];
  });
  // Only an operator-written story title can be affected by a withdrawal of its facts. Every listed story's withdrawal
  // state is read in one statement and kept with the ranking, so the list's newest developments reuse it (TASK-0714).
  const withdrawn = await storiesWithdrawalAffected(shown.map(({ story }) => Number(story.id)));
  const entries = shown.map(({ entry, story, representative }) => {
    const safeTitle = storyTextNeedsRefresh(story) || (story.origin === "manual" && withdrawn.has(Number(story.id)));
    return { ...entry, title: safeTitle ? representative.title : story.title };
  });
  const ranking: HotRanking = { id: row.id, computedAt: row.computed_at.toISOString(), ruleVersion: row.rule_version, entries, coverage: row.evidence };
  checks.set(ranking, { admission: admissionAffected, withdrawn });
  return ranking;
}

/**
 * The current public checks a ranking read made, kept for the rest of the request that holds the ranking: the stories
 * whose text an original post's grant fences (originalPostAffectedStories) and those touched by a withdrawal
 * (storiesWithdrawalAffected). They cover every story the ranking lists. Nothing is kept across reads: each
 * latestHotRanking() call that starts a read makes its own checks.
 */
export interface RankingChecks {
  admission: ReadonlySet<number>;
  withdrawn: ReadonlySet<number>;
}
const checks = new WeakMap<HotRanking, RankingChecks>();
export function rankingChecks(ranking: HotRanking): RankingChecks | null {
  return checks.get(ranking) ?? null;
}

// The words change only with the ranking, so they are read once per ranking.
interface Extras {
  texts: Map<number, { summary: string | null; latest: string | null }>;
}
const extrasPending = new Map<number, Promise<Extras>>();

async function readExtras(ranking: HotRanking): Promise<Extras> {
  const pending = extrasPending.get(ranking.id);
  if (pending) return pending;
  const load = queryExtras(ranking);
  extrasPending.set(ranking.id, load);
  try {
    return await load;
  } finally {
    extrasPending.delete(ranking.id);
  }
}

async function queryExtras(ranking: HotRanking): Promise<Extras> {
  const ids = ranking.entries.map((e) => e.storyId);
  const texts = await sql<
    { id: number; digest: string | null; summary: string | null; latest: string | null; version: number; updated_at: Date; digest_updated_at: Date | null }[]
  >`
    SELECT id, digest, summary, latest,version,updated_at,digest_updated_at,((digest_updated_at IS NULL AND version>1) OR coalesce(updated_at>digest_updated_at,false)) AS text_stale FROM stories WHERE id = ANY(${ids}::bigint[])`;
  const extras: Extras = {
    texts: new Map(
      texts.map((t) => [Number(t.id), storyTextNeedsRefresh(t) ? { summary: null, latest: null } : { summary: t.digest ?? t.summary, latest: t.latest }]),
    ),
  };
  return extras;
}

/** What the web adds to a ranking entry: the digest and the latest turn. */
export async function rankingExtras(ranking: HotRanking) {
  const { texts } = await readExtras(ranking);
  const admissionAffected = rankingChecks(ranking)?.admission ?? (await originalPostAffectedStories(ranking.entries.map((entry) => Number(entry.storyId))));
  return {
    text: (e: HotEntry) =>
      admissionAffected.has(Number(e.storyId)) ? { summary: null, latest: null } : (texts.get(e.storyId) ?? { summary: null, latest: null }),
  };
}

/** Home hotspot board: the same ranking as /hot, up to 5. An empty list is an honest empty board, not a hidden one. */
export async function loadHotStrip(): Promise<HotStripEntry[]> {
  const ranking = await latestHotRanking();
  if (!ranking) return [];
  return ranking.entries.slice(0, 5).map((e) => ({
    rank: e.rank,
    title: e.title,
    heat: e.heat,
    trend: e.trend,
    storyPublicId: e.storyPublicId,
    itemId: e.representativeItemId,
  }));
}

/** Detail counts use the worker's qualified evidence and current public holds, just like the board. */
export async function storyParticipation(storyId: number, now = new Date()) {
  const signals = await publicParticipation([storyId], now);
  const recent = signals.filter((signal) => signal.observed_at.getTime() > now.getTime() - 48 * 3600000);
  if (!recent.length) return null;
  const previous = new Set(signals.filter((signal) => signal.observed_at.getTime() <= now.getTime() - 6 * 3600000).map((signal) => signal.participant_key));
  return {
    evidenceHash: participationHash(recent),
    participants48h: new Set(recent.map((signal) => signal.participant_key)).size,
    newParticipants6h: new Set(
      recent
        .filter((signal) => signal.observed_at.getTime() > now.getTime() - 6 * 3600000 && !previous.has(signal.participant_key))
        .map((signal) => signal.participant_key),
    ).size,
    recentReports24h: new Set(
      recent.filter((signal) => signal.kind === "editorial" && signal.observed_at.getTime() > now.getTime() - 24 * 3600000).map((signal) => signal.article_id),
    ).size,
    complete: !recent.some((signal) => signal.source_behind),
  };
}

/** Search follows the same current public evidence and withdrawal checks as the hot board. */
export async function hotSearchLinks() {
  return (await loadHotStrip()).map(({ rank, title, storyPublicId }) => ({ rank, title, to: `/story/${storyPublicId}` }));
}

/** The window a stored ranking was computed over; rankings stored before TASK-0599 used 48 hours. */
export function rankingWindowHours(evidence: Record<string, unknown> | null): number {
  const hours = Number(evidence?.windowHours);
  return Number.isFinite(hours) && hours > 0 ? hours : 48;
}
