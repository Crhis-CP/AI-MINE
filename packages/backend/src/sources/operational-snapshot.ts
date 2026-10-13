import { dbOf } from "../db.ts";
const sql = dbOf("sources");
export const sourcesOperationalSnapshot = () =>
  sql.begin(async (db) => {
    await db`SET LOCAL statement_timeout='2s'`;
    return db`SELECT id AS source_id,lane,kind,enabled,health,last_ok_at,last_fetch_at,next_fetch_at FROM sources ORDER BY id LIMIT 501`;
  });
