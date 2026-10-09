import { dbOf } from "../db.ts";
const sql = dbOf("content");
export async function sourceTargetMaterialEvidence(ids: string[]) {
  if (!ids.length) return [];
  return sql.begin(async (db) => {
    await db`SET LOCAL statement_timeout='2s'`;
    return db<
      { source_id: string; materials: number; bodies: number; latest: Date | null }[]
    >`SELECT source_id,count(*)::int AS materials,count(*) FILTER(WHERE body_status='ok')::int AS bodies,max(discovered_at) AS latest FROM articles WHERE source_id=ANY(${ids}::text[]) GROUP BY source_id`;
  });
}
