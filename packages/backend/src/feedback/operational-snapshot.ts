import { dbOf } from "../db.ts";
const sql = dbOf("feedback");

/** Fixed aggregate for the private observer; no feedback text or personal data. */
export const feedbackOperationalSnapshot = () =>
  sql.begin(async (db) => {
    await db`SET LOCAL statement_timeout='2s'`;
    return db`SELECT status,count(*)::int AS count FROM feedback GROUP BY status ORDER BY status`;
  });
