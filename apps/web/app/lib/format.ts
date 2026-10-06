import { beijingDate, beijingTime, beijingWeekday } from "@amp/contracts/time";

export { beijingDate, beijingTime, beijingWeekday };

export function dayLabel(date: string, today: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const base = `${m}月${d}日`;
  if (date === today) return `今天 · ${base}`;
  const diff = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000);
  if (diff === 1) return `昨天 · ${base}`;
  if (y !== Number(today.slice(0, 4))) return `${y}年${base}`;
  return base;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "刚刚";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} 天前`;
  return beijingDate(iso);
}

export function fullDateTime(iso: string): string {
  return `${beijingDate(iso)} ${beijingTime(iso)}`;
}

/** "9月24日 10:51" (Beijing), for lists that span days. */
export function monthDayTime(iso: string): string {
  const [, m, d] = beijingDate(iso).split("-").map(Number) as [number, number, number];
  return `${m}月${d}日 ${beijingTime(iso)}`;
}

/**
 * A source that gave only the date is kept at the start of that Beijing day (TASK-0040). That is never a
 * time of day to show (Owner 2026-10-05: 只显示日期), so a source time of exactly 00:00:00 in Beijing is
 * shown as its date alone.
 */
export function isDateOnlyInstant(iso: string): boolean {
  const t = Date.parse(iso);
  return Number.isFinite(t) && (t + 8 * 3600_000) % 86_400_000 === 0;
}

/** What the time column shows for an item whose source gave only the date. */
export const NO_TIME = "—";

/** A source time as "2026-09-24 10:51", or "2026-09-24" alone when the source gave only the date. */
export function sourceDateTime(iso: string): string {
  return isDateOnlyInstant(iso) ? beijingDate(iso) : fullDateTime(iso);
}

/** A source time as "9月24日 10:51", or "9月24日" alone when the source gave only the date. */
export function sourceMonthDayTime(iso: string): string {
  if (!isDateOnlyInstant(iso)) return monthDayTime(iso);
  const [, m, d] = beijingDate(iso).split("-").map(Number) as [number, number, number];
  return `${m}月${d}日`;
}

/** "X：Ethan Mollick (@emollick)" → "Ethan Mollick"; other sources keep their name. */
export function shortSourceName(name: string): string {
  const m = /^X[:：]\s*(.+?)\s*\(@[^)]+\)\s*$/.exec(name);
  if (m) return m[1]!.replace(/（.*?）/g, "").trim();
  return name.replace(/（RSS）|（网页）|（API）/g, "").trim();
}

export function sourceInitial(name: string): string {
  const s = shortSourceName(name).replace(/^[^\p{L}\p{N}]+/u, "");
  return (s[0] ?? "A").toUpperCase();
}
