// One-off correction (TASK-0037): items stored before day-only source dates set the timeline were put at
// the moment they were found. This puts each on its stated day (Beijing midnight), marks days older than
// the stale threshold as history, and republishes so the public lists follow. Re-runnable: items already
// on their day are left alone.
//   node scripts/retime-day-only.ts [--dry-run]
import { closeDb, dbOf, initializeDb } from "@amp/backend/db";
import { decideTimeline, sourceDayStart } from "@amp/backend/content/materials";
import { publishArticle } from "@amp/backend/publication/publish";
import { stopBoss } from "@amp/backend/jobs/queue";

await initializeDb("worker");
const sql = dbOf("content");
const dry = process.argv.includes("--dry-run");
const rows = await sql<{ id: string; discovered_at: Date; timeline_at: Date; backfill: boolean; backfill_reason: string | null; local_date: string | null }[]>`
  SELECT a.id, a.discovered_at, a.timeline_at, a.backfill, a.backfill_reason, o.result->'evidence'->'time'->>'local_date' AS local_date
  FROM articles a JOIN content.source_date_observations o ON o.id = a.source_date_observation_id
  WHERE a.published_at IS NULL AND a.source_date_state = 'reliable' AND o.result->'evidence'->'time'->>'utc' IS NULL`;
let changed = 0;
for (const r of rows) {
  const day = sourceDayStart(r.local_date);
  if (!day) continue;
  const t = decideTimeline(null, r.discovered_at, r.backfill ? r.backfill_reason : null, day);
  if (t.timelineAt.getTime() === r.timeline_at.getTime() && t.backfill === r.backfill) continue;
  changed += 1;
  if (dry) {
    console.log(`${r.id}: ${r.timeline_at.toISOString()} -> ${t.timelineAt.toISOString()}${t.backfill ? " (history)" : ""}`);
    continue;
  }
  await sql`UPDATE articles SET timeline_at = ${t.timelineAt}, backfill = ${t.backfill}, backfill_reason = ${t.backfillReason} WHERE id = ${r.id}`;
  await publishArticle(r.id);
}
console.log(`${rows.length} day-only items, ${changed} ${dry ? "would change" : "changed"}`);
await stopBoss();
await closeDb();
