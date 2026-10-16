import { dbOf, type Db } from "../db.ts";
const sql = dbOf("content");

export interface MaterialGroupingState {
  id: string;
  revision: number;
  source_date_version: number;
  grouping_status: "pending" | "complete" | "failed";
  grouping_input_revision: number | null;
  selection_adds_value: boolean | null;
  selection_value_reason: string | null;
}

/** Called within the caller's membership/control transaction; no second database connection. */
export async function readMaterialGrouping(articleId: string, db: Db = sql) {
  const [row] = await db<MaterialGroupingState[]>`SELECT id,revision,source_date_version,grouping_status,grouping_input_revision,
    selection_adds_value,selection_value_reason FROM articles WHERE id=${articleId} FOR UPDATE`;
  return row ? { ...row, source_date_version: Number(row.source_date_version) } : null;
}

export async function beginMaterialGrouping(articleId: string, revision: number, force = false, db: Db = sql) {
  const changed = await db`UPDATE articles SET grouping_status='pending',grouping_input_revision=NULL,
    grouping_receipt_id=NULL,grouping_error=NULL,selection_adds_value=NULL,selection_value_reason=NULL,grouped_at=NULL
    WHERE id=${articleId} AND revision=${revision}
      AND (${force} OR grouping_status<>'complete' OR grouping_input_revision IS DISTINCT FROM revision)`;
  return changed.count === 1;
}

export async function completeMaterialGrouping(
  articleId: string,
  revision: number,
  selection: { addsValue: boolean; reason: string },
  receiptId: number | null,
  db: Db = sql,
) {
  if (typeof selection.addsValue !== "boolean" || !selection.reason.trim()) throw new Error("Grouping requires an explicit value decision");
  const changed = await db`UPDATE articles SET grouping_status='complete',grouping_input_revision=${revision},
    grouping_receipt_id=${receiptId},grouping_error=NULL,selection_adds_value=${selection.addsValue},
    selection_value_reason=${selection.reason.trim().slice(0, 400)},grouped_at=now()
    WHERE id=${articleId} AND revision=${revision} AND grouping_status='pending'`;
  return changed.count === 1;
}

export async function failMaterialGrouping(
  articleId: string,
  revision: number,
  failure: { waiting: boolean; receiptId: number | null; error: string },
  db: Db = sql,
) {
  const changed = await db`UPDATE articles SET grouping_status=${failure.waiting ? "pending" : "failed"},
    grouping_input_revision=${revision},grouping_receipt_id=${failure.receiptId},grouping_error=${failure.error.slice(0, 2000)},
    selection_adds_value=NULL,selection_value_reason=NULL,grouped_at=NULL
    WHERE id=${articleId} AND revision=${revision} AND grouping_status<>'complete'`;
  return changed.count === 1;
}

/** Claim a bounded, fair batch; enqueue in this same transaction so a crash cannot lose the work. */
export async function claimPendingGrouping(sourceIds: string[], limit: number, db: Db) {
  return db<{ id: string; revision: number; grouping_receipt_id: number | null }[]>`
    WITH due AS (
      SELECT id FROM articles WHERE source_id=ANY(${sourceIds}::text[]) AND grouping_status='pending'
        AND processing_state IN ('analyzed','blocked')
        AND (grouping_retry_at IS NULL OR grouping_retry_at<=now())
      ORDER BY grouping_retry_at NULLS FIRST,created_at,id LIMIT ${Math.max(1, Math.min(limit, 100))} FOR UPDATE SKIP LOCKED
    ) UPDATE articles a SET grouping_retry_at=now()+interval '10 minutes' FROM due WHERE a.id=due.id
      RETURNING a.id,a.revision,a.grouping_receipt_id`;
}

/** Automatic event evidence must already be confirmed for this material revision. */
export async function confirmedGroupingMaterials(ids: string[], db: Db = sql) {
  if (!ids.length) return [];
  return db<{ id: string; revision: number }[]>`SELECT id,revision FROM articles WHERE id=ANY(${ids}::text[])
    AND grouping_status='complete' AND grouping_input_revision=revision`;
}
