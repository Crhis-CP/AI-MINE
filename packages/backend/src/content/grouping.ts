import { dbOf, type Db } from "../db.ts";
const sql = dbOf("content");

export interface MaterialGroupingState {
  id: string;
  revision: number;
  grouping_status: "pending" | "complete" | "failed";
  grouping_input_revision: number | null;
  selection_adds_value: boolean | null;
  selection_value_reason: string | null;
}

/** Called within the caller's membership/control transaction; no second database connection. */
export async function readMaterialGrouping(articleId: string, db: Db = sql) {
  const [row] = await db<MaterialGroupingState[]>`SELECT id,revision,grouping_status,grouping_input_revision,
    selection_adds_value,selection_value_reason FROM articles WHERE id=${articleId} FOR UPDATE`;
  return row ?? null;
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
