import { createHash } from "node:crypto";
import { beijingDate } from "@amp/contracts/time";
// About figures share one public snapshot. A short cache expires before serving another response.
import type { SiteStats } from "@amp/contracts/site";
import type { SiteNewsMap } from "@amp/contracts/http/public";
import { JURISDICTIONS } from "@amp/industry/jurisdictions";
import { sql } from "../db.ts";
import { cached } from "../lib/cache.ts";
import { selectedCondition, originalPostAdmissionCondition, admissionReplacementSeats, currentNewsJurisdictionCounts } from "../publication/items.ts";
import { originalPostReadVersion } from "../lib/original-post-admission.ts";
import { contentVersion } from "../publication/availability.ts";

export type { SiteStats };
export { loadMetalPrices } from "../publication/metal-prices/read.ts";
export { currentNewsJurisdictionCounts } from "../publication/items.ts";

/**
 * The reader's news map (DEC-78, Owner 2026-11-05): country counts over the last day, week or month by
 * archive time, beside the window before it, so the map follows where the news is rather than the
 * all-time totals. Same membership as the country filter; cached briefly per window like the About figures.
 */
const WINDOW_DAYS = { "1d": 1, "7d": 7, "30d": 30 } as const;
const maps = new Map<SiteNewsMap["window"], ReturnType<typeof cached<SiteNewsMap>>>();
export function loadNewsMap(window: SiteNewsMap["window"] = "7d"): Promise<SiteNewsMap> {
  let entry = maps.get(window);
  if (!entry) maps.set(window, (entry = cached(() => queryNewsMap(window, new Date()), { freshMs: 60_000, maxStaleMs: 60_000 })));
  return entry.get();
}
export async function queryNewsMap(window: SiteNewsMap["window"], now: Date): Promise<SiteNewsMap> {
  const span = WINDOW_DAYS[window] * 24 * 3600_000;
  const from = new Date(now.getTime() - span),
    before = new Date(from.getTime() - span);
  const [current, previous] = await Promise.all([currentNewsJurisdictionCounts({ from, to: now }), currentNewsJurisdictionCounts({ from: before, to: from })]);
  const countries = JURISDICTIONS.filter((j) => j.kind === "country")
    .map((j) => ({ code: j.id, label: j.name_zh, count: current.counts[j.id] ?? 0, previous: previous.counts[j.id] ?? 0 }))
    .filter((c) => c.count > 0 || c.previous > 0)
    .sort((a, b) => b.count - a.count || b.previous - a.previous || a.code.localeCompare(b.code));
  return { window, from: from.toISOString(), to: now.toISOString(), countries };
}

const stats = cached(() => querySiteStats(new Date()), { freshMs: 30_000, maxStaleMs: 30_000 });
let version: string | null = null;

export async function loadSiteStats(): Promise<SiteStats> {
  const current = await contentVersion();
  const key = originalPostReadVersion(`${current.version}:${current.withdrawalVersion}`);
  if (version !== key) {
    version = key;
    stats.clear();
  }
  return stats.get();
}

async function querySiteStats(now: Date): Promise<SiteStats> {
  return sql.begin("isolation level repeatable read read only", async (db) => {
    const dayAgo = new Date(now.getTime() - 24 * 3600_000);
    const replacements = await admissionReplacementSeats(now, db);
    const [[row], kinds, sample, latest] = await Promise.all([
      db<Array<Omit<SiteStats, "sourceKinds" | "day" | "sampleSources" | "latest"> & { collected: number; selectedDay: number }>>`
      SELECT (SELECT count(*) FROM sources WHERE enabled AND lane = 'news')::int AS sources,
             (SELECT count(*) FROM sources WHERE enabled AND lane = 'news' AND participation_mode = 'hot_signal')::int AS "heatOnlySources",
             (SELECT count(*) FROM publications p WHERE p.visibility <> 'withdrawn' AND ${originalPostAdmissionCondition()})::int AS items,
             (SELECT count(*) FROM publications p WHERE ${selectedCondition(now)} AND (p.seat OR p.article_id=ANY(${replacements}::text[])))::int AS selected,
             (SELECT count(*) FROM reports r WHERE kind = 'daily' AND NOT EXISTS(
               SELECT 1 FROM publication.withdrawal_targets w WHERE w.active AND w.lane='news'
                 AND w.target_type='report' AND w.target_key=r.kind||':'||r.key))::int AS dailies,
             (SELECT count(*) FROM publications p WHERE p.visibility <> 'withdrawn' AND ${originalPostAdmissionCondition()} AND p.discovered_at > ${dayAgo})::int AS collected,
             (SELECT count(*) FROM publications p WHERE ${selectedCondition(now)} AND (p.seat OR p.article_id=ANY(${replacements}::text[])) AND p.timeline_at > ${dayAgo})::int AS "selectedDay"`,
      db<{ kind: string; n: number }[]>`SELECT kind, count(*)::int AS n FROM sources WHERE enabled AND lane = 'news' GROUP BY kind`,
      db<{ id: string; name: string; kind: string; heatOnly: boolean }[]>`SELECT id,name,kind,participation_mode='hot_signal' AS "heatOnly" FROM sources
      WHERE enabled AND lane='news' ORDER BY id`,
      db<{ id: string; title: string; source: string }[]>`SELECT p.article_id AS id,p.title,s.name AS source
      FROM publications p JOIN sources s ON s.id=p.source_id WHERE ${selectedCondition(now)} AND (p.seat OR p.article_id=ANY(${replacements}::text[])) ORDER BY p.sort_at DESC,p.article_id DESC LIMIT 8`,
    ]);
    const { collected, selectedDay, ...totals } = row!;
    const value: SiteStats = {
      ...totals,
      sourceKinds: Object.fromEntries(kinds.map((k) => [k.kind, k.n])),
      sampleSources: sample
        .map(({ id, ...view }) => ({
          view,
          rank: createHash("md5")
            .update(id + beijingDate(now))
            .digest("hex"),
        }))
        .sort((a, b) => a.rank.localeCompare(b.rank))
        .slice(0, 180)
        .map(({ view }) => view),
      day: { collected, selected: selectedDay },
      latest,
    };
    return value;
  });
}

export { loadSiteInformation } from "../publication/site-information.ts";
