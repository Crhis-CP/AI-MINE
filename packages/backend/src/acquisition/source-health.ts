import { sql } from "../db.ts";

/** Only the current source-collection binding can explain a present wait. */
export async function sourceCollectionWaits(until: Date) {
  const rows = await sql<{ source_id: string; observed_at: Date; reason: string; retry_at: string | null }[]>`
    SELECT s.source_id,r.started_at AS observed_at,r.detail->>'reason' AS reason,r.detail->>'retryAt' AS retry_at
    FROM acquisition.crawl_sessions s CROSS JOIN LATERAL (
      SELECT status,started_at,finished_at,detail FROM fetch_runs
      WHERE source_id=s.source_id AND started_at>=s.updated_at AND started_at<=${until}
      ORDER BY started_at DESC,id DESC LIMIT 1
    ) r
    WHERE s.active AND s.scope='source:'||s.source_id AND r.status='skipped' AND r.finished_at<=${until}
      AND r.detail->>'state'='deferred'
      AND r.detail->>'reason' IN ('robots_unavailable','transport_unavailable','HTTP 429','HTTP 503','source_reader_pending')`;
  return rows.map((row) => ({
    ...row,
    retry_at: row.retry_at && Number.isFinite(Date.parse(row.retry_at)) ? new Date(row.retry_at).toISOString() : null,
  }));
}

/** Actual attempts, excluding quota waits. Old detail rows have errors but no failure count. */
export async function sourceFetchHealth(since: Date, until: Date) {
  return sql<{ source_id: string; runs: number; failed: number; detail_attempts: number; detail_failures: number }[]>`
    SELECT source_id,
      count(*) FILTER(WHERE status IN ('ok','failed') AND coalesce(error,'') NOT LIKE 'Budget for % exhausted (%)')::int AS runs,
      count(*) FILTER(WHERE status='failed' AND coalesce(error,'') NOT LIKE 'Budget for % exhausted (%)')::int AS failed,
      coalesce(sum((detail->>'detailAttempts')::int),0)::int AS detail_attempts,
      coalesce(sum(coalesce((detail->>'detailFailures')::int,jsonb_array_length(detail->'detailErrors'))),0)::int AS detail_failures
    FROM fetch_runs WHERE started_at>=${since} AND started_at<=${until} GROUP BY source_id`;
}

/** Retain each article's latest failed presentation until that article has newer repair evidence. */
export async function sourcePresentationFailures() {
  return sql<{ source_id: string; url: string; identity_key: string | null; reason: string; at: Date }[]>`
    SELECT DISTINCT ON (source_id,failure->>'url') source_id,failure->>'url' AS url,
      failure->>'identityKey' AS identity_key,coalesce(failure->>'reason',failure->>'error') AS reason,started_at AS at
    FROM fetch_runs CROSS JOIN LATERAL jsonb_array_elements(detail->'presentationFailures') failure
    WHERE detail ? 'presentationFailures'
    ORDER BY source_id,failure->>'url',id DESC`;
}
