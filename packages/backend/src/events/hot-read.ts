import { reportPublicInputs } from "../publication/groups.ts";
import { publicParticipation, participationHash } from "./participation-read.ts";
// Reading the latest published hot ranking. The web shows heat values; machine exits only ranks.
import type { HotStripEntry } from "@amp/contracts/site";
import { dbOf } from "../db.ts";
import { storyTextNeedsRefresh, storyWithdrawalAffected } from "@amp/backend/publication/reports";

const sql = dbOf("events");

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
  const representatives = new Map(
    (await reportPublicInputs(row.entries.flatMap((entry) => (entry.representativeItemId ? [entry.representativeItemId] : [])))).map((value) => [
      value.id,
      value,
    ]),
  );
  const current = await sql<
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
    SELECT id,public_id::text,title,merged_into,origin,version,updated_at,digest_updated_at,((digest_updated_at IS NULL AND version>1) OR coalesce(updated_at>digest_updated_at,false)) AS text_stale FROM stories WHERE id=ANY(${row.entries.map((entry) => entry.storyId)}::bigint[])`;
  const now = new Date();
  const signals = await publicParticipation(
    row.entries.map((entry) => entry.storyId),
    now,
    new Date(now.getTime() - 48 * 3600000),
  );
  const valid = new Set(
    row.entries
      .filter((entry) => !!entry.evidenceHash && participationHash(signals.filter((signal) => signal.story_id === entry.storyId)) === entry.evidenceHash)
      .map((entry) => entry.storyId),
  );
  const byId = new Map(current.map((story) => [Number(story.id), story]));
  const entries = (
    await Promise.all(
      row.entries.map(async (entry) => {
        if (!valid.has(Number(entry.storyId))) return [];
        const story = byId.get(Number(entry.storyId));
        if (!story || story.merged_into || !entry.representativeItemId || representatives.get(entry.representativeItemId)?.story_id !== Number(entry.storyId))
          return [];
        const facts = await sql<{ public_id: string }[]>`SELECT public_id FROM facts WHERE story_id=${story.id}`;
        const safeTitle =
          storyTextNeedsRefresh(story) ||
          (story.origin === "manual" &&
            (await storyWithdrawalAffected(
              story.id,
              story.public_id,
              facts.map((f) => f.public_id),
            )));
        return [{ ...entry, title: safeTitle ? representatives.get(entry.representativeItemId)!.title : story.title }];
      }),
    )
  ).flat();
  return { id: row.id, computedAt: row.computed_at.toISOString(), ruleVersion: row.rule_version, entries, coverage: row.evidence };
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
  return {
    text: (e: HotEntry) => texts.get(e.storyId) ?? { summary: null, latest: null },
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
