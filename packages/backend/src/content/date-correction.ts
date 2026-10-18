import { TimeAssertion } from "@amp/contracts/time-assertion";
import { sql, type Db } from "../db.ts";

/** Undefined means no human decision; null is an explicit withdrawal of an untrusted date. */
export async function correctedSourceTime(articleId: string, db: Db): Promise<TimeAssertion | null | undefined> {
  const [row] = await db<{ source_time: unknown }[]>`SELECT source_time FROM content.publication_date_corrections WHERE article_id=${articleId}`;
  return row ? (row.source_time === null ? null : TimeAssertion.parse(row.source_time)) : undefined;
}
export async function saveCorrectedSourceTime(articleId: string, revision: number, time: TimeAssertion | null, evidence: string, actor: string, db: Db) {
  await db`INSERT INTO content.publication_date_corrections(article_id,material_revision,source_time,evidence,actor)
    VALUES(${articleId},${revision},${time ? db.json(time) : null},${evidence},${actor})
    ON CONFLICT(article_id) DO UPDATE SET material_revision=EXCLUDED.material_revision,source_time=EXCLUDED.source_time,
      evidence=EXCLUDED.evidence,actor=EXCLUDED.actor,corrected_at=now()`;
}

export type CorrectionMaterial = {
  id: string;
  source_id: string;
  revision: number;
  source_date_version: string;
  published_at: Date | null;
  published_at_claim: Date | null;
  discovered_at: Date;
  timeline_at: Date;
  backfill: boolean;
  backfill_reason: string | null;
  updated_at: Date;
  content_hash: string | null;
  processing_state: string;
  grouping_status: string;
};
export async function dateCorrectionMaterial(id: string, db: Db = sql, lock = false) {
  if (lock) await db`SELECT id FROM articles WHERE id=${id} FOR UPDATE`;
  const [row] = await db<CorrectionMaterial[]>`SELECT id,source_id,revision,source_date_version,published_at,published_at_claim,discovered_at,timeline_at,
    backfill,backfill_reason,updated_at,content_hash,processing_state,grouping_status FROM articles WHERE id=${id}`;
  return row;
}
export async function applyCorrectedMaterialDate(
  id: string,
  date: Date | null,
  timeline: { timelineAt: string; backfill: boolean; backfillReason: string | null },
  db: Db,
) {
  await db`UPDATE articles SET published_at=${date},published_at_claim=${date},timeline_at=${new Date(timeline.timelineAt)},backfill=${timeline.backfill},
    backfill_reason=${timeline.backfillReason},source_date_version=source_date_version+1,source_date_state=${date ? "reliable" : "pending"},
    source_date_error=${date ? null : "manual-date-retraction"},updated_at=now() WHERE id=${id}`;
}
export async function resetMaterialProcessing(id: string, extract: boolean, db: Db) {
  await db`UPDATE articles SET processing_state='new',processing_error=NULL,processing_attempts=0,processing_retry_at=NULL,
    body_status=CASE WHEN ${extract} THEN 'pending' ELSE body_status END WHERE id=${id}`;
}
