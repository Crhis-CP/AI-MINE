import { dbOf } from "../db.ts";
const sql = dbOf("publication");
export async function sourceTargetPublicationEvidence(ids: string[]) {
  if (!ids.length) return [];
  return sql.begin(async (db) => {
    await db`SET LOCAL statement_timeout='2s'`;
    const news = await db<
      { source_id: string; records: number }[]
    >`SELECT source_id,count(*)::int AS records FROM publications WHERE source_id=ANY(${ids}::text[]) GROUP BY source_id`;
    const policies = await db<
      { source_id: string; records: number }[]
    >`SELECT source_id,count(DISTINCT policy_id)::int AS records FROM publication.policy_editions WHERE source_id=ANY(${ids}::text[]) GROUP BY source_id`;
    return ids.map((source_id) => ({
      source_id,
      records: (news.find((r) => r.source_id === source_id)?.records ?? 0) + (policies.find((r) => r.source_id === source_id)?.records ?? 0),
    }));
  });
}
