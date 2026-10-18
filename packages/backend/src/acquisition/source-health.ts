import { sql } from "../db.ts";

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
  return sql<{ source_id: string; url: string; reason: string; at: Date }[]>`
    SELECT DISTINCT ON (source_id,failure->>'url') source_id,failure->>'url' AS url,
      coalesce(failure->>'reason',failure->>'error') AS reason,started_at AS at
    FROM fetch_runs CROSS JOIN LATERAL jsonb_array_elements(detail->'presentationFailures') failure
    WHERE detail ? 'presentationFailures'
    ORDER BY source_id,failure->>'url',id DESC`;
}
