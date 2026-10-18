import { beijingDate, beijingMidnight } from "@amp/contracts/time";
import { sql } from "../db.ts";
import { FUTURE_TOLERANCE_MS } from "./timeline.ts";

export async function sourceMaterialHealth(since: Date, until: Date) {
  return sql<{ source_id: string; discoveries: number; items: number; undated: number; repeated: number; ever_output: boolean }[]>`
    WITH seen AS (
      SELECT article_id,source_id FROM article_discoveries WHERE discovered_at BETWEEN ${since} AND ${until}
      UNION SELECT id,source_id FROM articles WHERE discovered_at BETWEEN ${since} AND ${until}
    ), discoveries AS (SELECT source_id,count(*)::int AS n FROM seen GROUP BY source_id),
    items AS (SELECT source_id,count(*)::int AS n,count(*) FILTER(WHERE published_at IS NULL)::int AS undated
      FROM articles WHERE discovered_at BETWEEN ${since} AND ${until} GROUP BY source_id),
    revisions AS (SELECT article_id FROM article_revisions WHERE created_at BETWEEN ${since} AND ${until} AND revision>1
      GROUP BY article_id HAVING count(*)>=5),
    repeated AS (SELECT a.source_id,count(*)::int AS n FROM articles a JOIN revisions r ON r.article_id=a.id GROUP BY a.source_id),
    history AS (SELECT source_id FROM articles UNION SELECT source_id FROM article_discoveries)
    SELECT h.source_id,coalesce(d.n,0) AS discoveries,coalesce(i.n,0) AS items,coalesce(i.undated,0) AS undated,
      coalesce(r.n,0) AS repeated,true AS ever_output FROM history h
      LEFT JOIN discoveries d USING(source_id) LEFT JOIN items i USING(source_id) LEFT JOIN repeated r USING(source_id)`;
}

/** A first import is one delivery, not months of apparent publishing history. */
export async function sourceOutputRhythm(ids: string[], now: Date) {
  if (!ids.length) return [];
  const since = new Date(now.getTime() - 90 * 86400_000);
  const startDay = beijingDate(since),
    endDay = beijingDate(now);
  const floor = beijingMidnight(startDay);
  const days = await sql<{ source_id: string; day: string }[]>`
    WITH dated AS (
      SELECT source_id,(CASE WHEN backfill_reason='first-import' THEN discovered_at
        ELSE coalesce(published_at,discovered_at) END AT TIME ZONE 'Asia/Shanghai')::date AS day
      FROM articles WHERE source_id=ANY(${ids}::text[]) AND discovered_at>=${new Date(floor.getTime() - FUTURE_TOLERANCE_MS)}
      UNION ALL
      SELECT d.source_id,(d.discovered_at AT TIME ZONE 'Asia/Shanghai')::date FROM article_discoveries d JOIN articles a ON a.id=d.article_id
      WHERE d.source_id=ANY(${ids}::text[]) AND a.source_id<>d.source_id AND d.discovered_at>=${floor}
    ) SELECT DISTINCT source_id,day::text AS day FROM dated WHERE day>=${startDay}::date AND day<=${endDay}::date ORDER BY source_id,day`;
  // At most 91 dates per source; distinct days keep imported duplicates from weighting the median.
  const bySource = new Map<string, number[]>();
  for (const row of days) {
    const own = bySource.get(row.source_id) ?? [];
    own.push(Date.parse(`${row.day}T00:00:00Z`) / 86400_000);
    bySource.set(row.source_id, own);
  }
  const today = Date.parse(`${endDay}T00:00:00Z`) / 86400_000;
  return [...bySource].map(([id, dates]) => {
    const gaps = dates
        .slice(1)
        .map((date, i) => date - dates[i]!)
        .sort((a, b) => a - b),
      mid = Math.floor(gaps.length / 2);
    return {
      id,
      evidence_days: dates.length,
      median_gap_days: gaps.length ? (gaps.length % 2 ? gaps[mid]! : (gaps[mid - 1]! + gaps[mid]!) / 2) : null,
      quiet_days: today - dates.at(-1)!,
    };
  });
}

export async function sourceWeeklyItems(since: Date, before: Date, until: Date) {
  const [row] = await sql<{ week: number; prev: number }[]>`SELECT count(*) FILTER(WHERE discovered_at>=${since})::int AS week,
    count(*) FILTER(WHERE discovered_at<${since})::int AS prev FROM articles WHERE discovered_at BETWEEN ${before} AND ${until}`;
  return row!;
}

export async function presentationMaterialRevisions(urls: string[], identities: string[] = []) {
  if (!urls.length && !identities.length) return [];
  return sql<{ id: string; identity_key: string; url: string; revised_at: Date | null }[]>`SELECT a.id,a.identity_key,a.url,max(fresh.created_at) AS revised_at
    FROM articles a LEFT JOIN article_revisions fresh ON fresh.article_id=a.id
    LEFT JOIN article_revisions old ON old.article_id=fresh.article_id AND old.revision=fresh.revision-1
    WHERE (a.url=ANY(${urls}::text[]) OR a.identity_key=ANY(${identities}::text[])) AND (fresh.revision IS NULL OR fresh.revision=1 OR fresh.body_text IS DISTINCT FROM old.body_text)
    GROUP BY a.id,a.identity_key,a.url`;
}
