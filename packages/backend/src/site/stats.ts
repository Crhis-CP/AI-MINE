import { createHash } from "node:crypto";
import { beijingDate } from "@amp/contracts/time";
// Figures for the about page: how much the site covers, counted from the public read layer and kept for
// ten minutes per process (the page itself is cached for five); an older copy is served while the
// counts are read again, so no reader waits for the full-table counts.
import type { SiteStats } from "@amp/contracts/site";
import { sql } from "../db.ts";
import { cached } from "../lib/cache.ts";
import { selectedCondition } from "../publication/items.ts";

export type { SiteStats };
export { loadMetalPrices } from "../publication/metal-prices/read.ts";
export { currentNewsJurisdictionCounts } from "../publication/items.ts";

const stats = cached(() => querySiteStats(new Date()), { freshMs: 10 * 60_000, maxStaleMs: 60 * 60_000 });

export async function loadSiteStats(): Promise<SiteStats> {
  const current = await stats.get(),
    now = new Date();
  const latest = await sql<{ id: string; title: string; source: string }[]>`SELECT p.article_id AS id,p.title,s.name AS source
    FROM publications p JOIN sources s ON s.id=p.source_id WHERE ${selectedCondition(now)} AND p.seat ORDER BY p.sort_at DESC,p.article_id DESC LIMIT 8`;
  return { ...current, latest };
}

async function querySiteStats(now: Date): Promise<SiteStats> {
  const dayAgo = new Date(now.getTime() - 24 * 3600_000);
  const [[row], kinds, sample] = await Promise.all([
    sql<Array<Omit<SiteStats, "sourceKinds" | "day" | "sampleSources" | "latest"> & { collected: number; selectedDay: number }>>`
      SELECT (SELECT count(*) FROM sources WHERE enabled AND lane = 'news')::int AS sources,
             (SELECT count(*) FROM sources WHERE enabled AND lane = 'news' AND participation_mode = 'hot_signal')::int AS "heatOnlySources",
             (SELECT count(*) FROM publications p WHERE p.visibility <> 'withdrawn')::int AS items,
             (SELECT count(*) FROM publications p WHERE ${selectedCondition(now)} AND p.seat)::int AS selected,
             (SELECT count(*) FROM reports WHERE kind = 'daily')::int AS dailies,
             (SELECT count(*) FROM publications p WHERE p.visibility <> 'withdrawn' AND p.discovered_at > ${dayAgo})::int AS collected,
             (SELECT count(*) FROM publications p WHERE ${selectedCondition(now)} AND p.seat AND p.timeline_at > ${dayAgo})::int AS "selectedDay"`,
    sql<{ kind: string; n: number }[]>`SELECT kind, count(*)::int AS n FROM sources WHERE enabled AND lane = 'news' GROUP BY kind`,
    sql<{ id: string; name: string; kind: string; heatOnly: boolean }[]>`SELECT id,name,kind,participation_mode='hot_signal' AS "heatOnly" FROM sources
      WHERE enabled AND lane='news' ORDER BY id`,
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
  };
  return value;
}

export { loadSiteInformation } from "../publication/site-information.ts";
