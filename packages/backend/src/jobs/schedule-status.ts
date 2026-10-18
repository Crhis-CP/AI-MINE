import { sql } from "../db.ts";

/** Read worker-owned timer definitions without starting queue producers or handlers. */
export async function currentScheduledJobs() {
  const rows = await sql<{ name: string }[]>`SELECT name FROM pgboss.queue WHERE name LIKE 'cron.%' ORDER BY name`;
  return rows.map((row) => row.name.slice(5));
}
