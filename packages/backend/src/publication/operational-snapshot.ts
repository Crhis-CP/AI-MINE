import { dbOf } from "../db.ts";
const sql = dbOf("publication");
export const publicationOperationalSnapshot = () =>
  sql.begin(async (db) => {
    await db`SET LOCAL statement_timeout='2s'`;
    const news =
      await db`SELECT 'news' AS kind,visibility AS state,count(*)::int AS count,max(visible_after) AS latest_at FROM publications GROUP BY visibility ORDER BY visibility`;
    const policy =
      await db`SELECT 'policy' AS kind,CASE WHEN withdrawn THEN 'withdrawn' WHEN automatic_excluded THEN 'excluded' WHEN publishing_paused THEN 'paused' ELSE 'recorded' END AS state,count(*)::int AS count,max(updated_at) AS latest_at FROM publication.policy_documents GROUP BY 2 ORDER BY 2`;
    return [...news, ...policy];
  });
