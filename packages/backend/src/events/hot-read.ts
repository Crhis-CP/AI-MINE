// Reading the latest published hot ranking. The web shows heat values; machine exits only ranks.
import type { HotStripEntry } from "@amp/contracts/site";
import { dbOf } from "../db.ts";

const sql = dbOf("events");

export interface HotEntry {
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
    SELECT id, computed_at, rule_version, entries, evidence FROM hot_rankings WHERE published ORDER BY computed_at DESC LIMIT 1`;
  if (!row) return null;
  return { id: row.id, computedAt: row.computed_at.toISOString(), ruleVersion: row.rule_version, entries: row.entries, coverage: row.evidence };
}

// The words change only with the ranking, so they are read once per ranking.
interface Extras {
  texts: Map<number, { summary: string | null; latest: string | null }>;
}
let extrasCache: { rankingId: number; extras: Extras } | null = null;
const extrasPending = new Map<number, Promise<Extras>>();

async function readExtras(ranking: HotRanking): Promise<Extras> {
  if (extrasCache?.rankingId === ranking.id) return extrasCache.extras;
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
  const texts = await sql<{ id: number; digest: string | null; summary: string | null; latest: string | null }[]>`
    SELECT id, digest, summary, latest FROM stories WHERE id = ANY(${ids}::bigint[])`;
  const extras: Extras = {
    texts: new Map(texts.map((t) => [Number(t.id), { summary: t.digest ?? t.summary, latest: t.latest }])),
  };
  extrasCache = { rankingId: ranking.id, extras };
  return extras;
}

/** What the web adds to a ranking entry: the digest and the latest turn. */
export async function rankingExtras(ranking: HotRanking) {
  const { texts } = await readExtras(ranking);
  return {
    text: (e: HotEntry) => texts.get(e.storyId) ?? { summary: null, latest: null },
  };
}

/** Home "current hot" strip: 3–5 entries from the same ranking, hidden when there are fewer than 3. */
export async function loadHotStrip(): Promise<HotStripEntry[] | null> {
  const ranking = await latestHotRanking();
  if (!ranking || ranking.entries.length < 3) return null;
  return ranking.entries.slice(0, 5).map((e) => ({
    rank: e.rank,
    title: e.title,
    heat: e.heat,
    trend: e.trend,
    storyPublicId: e.storyPublicId,
    itemId: e.representativeItemId,
  }));
}
