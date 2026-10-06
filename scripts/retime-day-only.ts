// Correction (TASK-0040) for items stored while a date alone was kept as no published time: the date is
// read as the collectors now read it (sourcePublishedAt: the start of that day in the source's offset) and the
// timeline is decided again by the one timeline rule. A new source's first import stays a backfill; the
// rest are judged stale or not afresh. Each item is corrected and republished in one transaction, so a
// run that stops part-way leaves nothing half done and a rerun changes nothing. Only Chinese sources;
// manual withdrawals and corrections stay as they are (publication reads them as always).
//   node scripts/retime-day-only.ts [--dry-run]
import { closeDb, dbOf, initializeDb } from "@amp/backend/db";
import { decideTimeline } from "@amp/backend/content/materials";
import { publishArticleTx } from "@amp/backend/publication/publish";
import { sourcePublishedAt } from "@amp/backend/sources/web-list";
import { stopBoss } from "@amp/backend/jobs/queue";
import { beijingDate, beijingTime } from "@amp/contracts/time";

await initializeDb("worker");
const sql = dbOf("content");
const dry = process.argv.includes("--dry-run");
interface Row {
  id: string;
  source_id: string;
  title: string;
  discovered_at: Date;
  timeline_at: Date;
  backfill: boolean;
  backfill_reason: string | null;
  raw: string;
  local_date: string | null;
  local_time: string | null;
  locator: string | null;
  list_offset: string | null;
  detail_offset: string | null;
  detail_rule: string | null;
}
const rows = await sql<Row[]>`
  SELECT a.id, a.source_id, a.title, a.discovered_at, a.timeline_at, a.backfill, a.backfill_reason,
    o.result->'evidence'->'time'->>'raw' AS raw, o.result->'evidence'->'time'->>'local_date' AS local_date,
    o.result->'evidence'->'time'->>'local_time' AS local_time, o.observation->>'locator' AS locator,
    s.config->>'publishedAtUtcOffset' AS list_offset, s.config->'detail'->>'publishedAtUtcOffset' AS detail_offset,
    COALESCE('regex:' || (s.config->'detail'->>'publishedAtRegex'), 'selector:' || (s.config->'detail'->>'publishedAtSelector')) AS detail_rule
  FROM articles a JOIN content.source_date_observations o ON o.id = a.source_date_observation_id
  JOIN sources s ON s.id = a.source_id
  WHERE a.published_at IS NULL AND a.source_date_state = 'reliable' AND o.result->'evidence'->'time'->>'utc' IS NULL
    AND o.result->'evidence'->'time'->>'raw' <> '' AND a.language LIKE 'zh%'
  ORDER BY a.source_id, a.discovered_at`;
const at = (d: Date) => `${beijingDate(d)} ${beijingTime(d)}`;
let changed = 0;
for (const r of rows) {
  // A date read from the detail page is read in the detail page's offset, as the collector reads it.
  const offset = (r.locator !== null && r.locator === r.detail_rule ? r.detail_offset : r.list_offset) ?? undefined;
  const explicit = r.backfill && r.backfill_reason !== "stale-on-discovery" ? r.backfill_reason : null;
  const t = decideTimeline(sourcePublishedAt({ raw: r.raw, utc: null, local_date: r.local_date, local_time: r.local_time }, offset), r.discovered_at, explicit);
  if (!t.publishedAt) continue;
  changed += 1;
  if (dry) {
    console.log(
      `${r.source_id} | ${r.id} | 发布 ${at(t.publishedAt)} | 时间线 ${at(r.timeline_at)} -> ${at(t.timelineAt)}${t.backfill ? " 旧文" : ""} | ${r.title.slice(0, 60)}`,
    );
    continue;
  }
  await sql.begin(async (tx) => {
    const updated = await tx`UPDATE articles SET published_at = ${t.publishedAt}, published_at_claim = ${t.publishedAt},
      timeline_at = ${t.timelineAt}, backfill = ${t.backfill}, backfill_reason = ${t.backfillReason}
      WHERE id = ${r.id} AND published_at IS NULL RETURNING id`;
    if (updated.length === 1) await publishArticleTx(tx, r.id);
  });
}
console.log(`${rows.length} items with a date alone (Beijing ${at(new Date())}), ${changed} ${dry ? "would change" : "changed"}`);
await stopBoss();
await closeDb();
