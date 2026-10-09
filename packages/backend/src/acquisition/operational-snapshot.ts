import { dbOf } from "../db.ts";
const sql = dbOf("acquisition");
export const acquisitionOperationalSnapshot = () =>
  sql.begin(async (db) => {
    await db`SET LOCAL statement_timeout='2s'`;
    return db`SELECT source_id,status,count(*)::int AS count,max(started_at) AS latest_at FROM fetch_runs WHERE started_at>=now()-interval '24 hours' GROUP BY source_id,status ORDER BY source_id,status LIMIT 501`;
  });
