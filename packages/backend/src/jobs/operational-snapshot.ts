import { dbOf } from "../db.ts";
const sql = dbOf("queue");
export const queueOperationalSnapshot = () =>
  sql.begin(async (db) => {
    await db`SET LOCAL statement_timeout='2s'`;
    return db`SELECT name,state,count(*)::int AS count,min(created_on) AS oldest_at FROM pgboss.job GROUP BY name,state ORDER BY name,state LIMIT 501`;
  });
