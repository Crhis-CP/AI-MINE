import { dbOf } from "../db.ts";
const sql = dbOf("acquisition");
export async function sourceTargetFetchEvidence(ids: string[]) {
  if (!ids.length) return [];
  return sql.begin(async (db) => {
    await db`SET LOCAL statement_timeout='2s'`;
    return db<
      { source_id: string; ok: number; failed: number; latest: Date | null }[]
    >`SELECT source_id,count(*) FILTER(WHERE status='ok' AND started_at>=now()-interval '7 days')::int AS ok,count(*) FILTER(WHERE status='failed' AND started_at>=now()-interval '7 days')::int AS failed,max(finished_at) FILTER(WHERE status='ok') AS latest FROM fetch_runs WHERE source_id=ANY(${ids}::text[]) GROUP BY source_id`;
  });
}
