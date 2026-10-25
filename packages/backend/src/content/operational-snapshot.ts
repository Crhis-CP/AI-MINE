import { sql, type Db } from "../db.ts";

export async function currentAnalyzedMaterials(ids: string[], db: Db) {
  if (!ids.length) return [];
  return db<{ id: string; revision: number; source_id: string }[]>`
    SELECT id,revision,source_id FROM articles WHERE id=ANY(${ids}::text[]) AND processing_state='analyzed'`;
}

export const processingOperationalSnapshot = () =>
  sql.begin(async (db) => {
    await db`SET LOCAL statement_timeout='2s'`;
    return db`SELECT source_id,processing_state AS state,count(*)::int AS count FROM articles GROUP BY source_id,processing_state ORDER BY source_id,processing_state LIMIT 501`;
  });
