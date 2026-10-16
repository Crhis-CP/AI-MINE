import { sql, type Db } from "../db.ts";
import { sanitizeBody } from "../content/sanitize.ts";

export type ManualState = "draft" | "active" | "needs_review" | "conflict" | "superseded" | "withdrawn";

/** The source revision and evidence belong to the immutable human revision, never an automatic output. */
export async function manualRevisionState(articleId: string, revision: number, original: string, db: Db = sql) {
  const [row] = await db<
    {
      manual_revision_id: number | null;
      material_revision: number | null;
      fields: Record<string, unknown>;
      source_revision: number | null;
      evidence_quote: string | null;
      state: ManualState | null;
    }[]
  >`
    SELECT o.manual_revision_id,o.material_revision,o.fields,m.source_revision,m.evidence_quote,
      (SELECT state FROM editorial.manual_revision_events WHERE revision_id=m.id ORDER BY id DESC LIMIT 1) AS state
    FROM editorial_overrides o LEFT JOIN editorial.manual_revisions m ON m.id=o.manual_revision_id WHERE o.article_id=${articleId}`;
  if (!row) return { fields: {}, state: null, manualRevisionId: null, bodyHtml: null };
  const sourceRevision = row.source_revision ?? row.material_revision;
  const changed = sourceRevision !== null && sourceRevision !== revision;
  const conflict = row.state === "conflict" || (changed && (!row.evidence_quote || !original.includes(row.evidence_quote)));
  const state = conflict ? "conflict" : changed ? "needs_review" : row.state;
  if (row.manual_revision_id && state && state !== row.state) {
    await db`INSERT INTO editorial.manual_revision_events(revision_id,state,actor,note)
      VALUES(${row.manual_revision_id},${state},'system',${conflict ? "来源修订后原文依据已不成立" : "来源已产生新修订，人工稿需复核"})`;
  }
  const fields = conflict ? {} : row.fields;
  return { fields, state, manualRevisionId: row.manual_revision_id, bodyHtml: typeof fields.body === "string" ? sanitizeBody(fields.body) : null };
}

export async function manualRevisionHistory(articleId: string, db: Db = sql) {
  return db`SELECT m.*,(SELECT state FROM editorial.manual_revision_events WHERE revision_id=m.id ORDER BY id DESC LIMIT 1) AS status
    FROM editorial.manual_revisions m WHERE article_id=${articleId} ORDER BY m.id DESC LIMIT 30`;
}
