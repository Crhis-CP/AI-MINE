import { TimeAssertion, normalizeSourceTime } from "@amp/contracts/time-assertion";
import { beijingMidnight } from "@amp/contracts/time";
import { sql } from "../db.ts";

/** Public assertions contain source facts and reader wording, never parsing/debug instructions. */
export function publicSourceTime(value: unknown): TimeAssertion | null {
  const parsed = TimeAssertion.safeParse(value);
  if (!parsed.success || parsed.data.precision === "unknown" || !["published", "registered", "formally_published"].includes(parsed.data.meaning)) return null;
  const time = parsed.data;
  const result = normalizeSourceTime(
    {
      meaning: time.meaning,
      raw: time.raw,
      local_date: time.local_date,
      local_time: time.local_time,
      timezone: time.timezone,
      utc: time.utc,
      precision: time.precision,
      basis: time.meaning === "registered" ? "官方页面标注的登记日期" : time.meaning === "formally_published" ? "原文标注的正式刊发日期" : "原文标注的发布时间",
      condition_text: time.condition_text,
    },
    { instantBasis: time.utc ? "explicit" : null, timezoneEvidence: time.timezone ? "来源时区已有依据" : null },
  );
  return result.utc ? { ...result, label: `${result.label}（北京时间）` } : result;
}
/** p/a/s are the shared publication, current material and public source aliases. */
export const CURRENT_SOURCE_TIME =
  () => sql`CASE WHEN p.source_date_version>0 AND p.source_time_material_revision=a.revision AND p.source_date_version=a.source_date_version
  AND p.source_date_config_hash=s.source_date_config_hash THEN p.source_time ELSE NULL END`;
/**
 * A list's time anchor as readers see it. When the anchor is the report's own source moment (an old or late
 * report placed on its source day) and that source gave only a date, the anchor is the start of that day in
 * Beijing, which every page reads as a date alone (BR-TIME-01): never the stored midnight of another zone shown
 * as 08:00 or 13:00. A receipt time, or a stated clock, is kept as it is.
 */
export function readerAnchor(anchor: Date, publishedAt: Date | null, sourceTime: unknown): Date {
  const time = publicSourceTime(sourceTime);
  return time?.precision === "date" && time.local_date && publishedAt?.getTime() === anchor.getTime() ? beijingMidnight(time.local_date) : anchor;
}
export function sourceInstant(value: unknown): Date | null {
  const time = publicSourceTime(value);
  return time?.utc && time.meaning !== "registered" ? new Date(time.utc) : null;
}
