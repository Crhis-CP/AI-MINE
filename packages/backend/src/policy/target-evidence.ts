import { dbOf } from "../db.ts";
const sql = dbOf("policy");
export async function sourceTargetOriginalEvidence(ids: string[]) {
  if (!ids.length) return [];
  return sql.begin(async (db) => {
    await db`SET LOCAL statement_timeout='2s'`;
    return db<
      { source_id: string; originals: number }[]
    >`SELECT r.source_id,count(DISTINCT v.instrument_id)::int AS originals FROM policy.document_revisions r JOIN policy.original_resources o ON o.revision_id=r.id JOIN policy.expressions e ON e.id=r.expression_id JOIN policy.versions v ON v.id=e.version_id WHERE r.source_id=ANY(${ids}::text[]) AND o.body IS NOT NULL GROUP BY r.source_id`;
  });
}
