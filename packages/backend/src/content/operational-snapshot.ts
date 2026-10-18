import { sql } from "../db.ts";

export const processingOperationalSnapshot = () =>
  sql.begin(async (db) => {
    await db`SET LOCAL statement_timeout='2s'`;
    return db`SELECT source_id,processing_state AS state,count(*)::int AS count FROM articles GROUP BY source_id,processing_state ORDER BY source_id,processing_state LIMIT 501`;
  });
