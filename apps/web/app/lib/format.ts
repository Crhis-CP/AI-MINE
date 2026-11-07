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

/** Source evidence controls precision. The legacy fallback is only for older cached responses lacking the field. */
export function newsSourceDate(time: import("@amp/contracts/time-assertion").TimeAssertion | null | undefined, legacy?: string | null) {
  if (time === undefined) {
    if (!legacy || !Number.isFinite(Date.parse(legacy))) return null;
    const dateOnly = isDateOnlyInstant(legacy);
    return {
      dateTime: dateOnly ? beijingDate(legacy) : legacy,
      text: sourceDateTime(legacy),
      clock: dateOnly ? null : beijingTime(legacy),
      label: "发布时间",
      dateOnly,
    };
  }
  if (!time || time.precision === "unknown") return null;
  if (time.precision === "date")
    return time.local_date
      ? { dateTime: time.local_date, text: time.local_date, clock: null, label: time.meaning === "published" ? "发布时间" : time.meaning_label, dateOnly: true }
      : null;
  if (!time.utc || !Number.isFinite(Date.parse(time.utc))) return null;
  return {
    dateTime: time.utc,
    text: fullDateTime(time.utc),
    clock: beijingTime(time.utc),
    label: time.meaning === "published" ? "发布时间" : time.meaning_label,
    dateOnly: false,
  };
}

const BEIJING = "Asia/Shanghai";
/** The same helpers in the interface language: Chinese as above, English through Intl in Beijing time. */
export function dateFormatFor(english: boolean) {
  if (!english)
    return {
      relativeTime,
      monthDayTime,
      sourceMonthDayTime,
      monthDay: (date: string) => monthDayLabel(date),
      weekday: beijingWeekday,
      /** "2026 年 11 月 7 日" over "周六": a day's heading in a dated list (the changelog). */
      dayHeading: (date: string) => ({ label: fullDateLabel(date), weekday: beijingWeekday(date).replace("星期", "周") }),
      /** "2026 年 11 月" for a YYYY-MM key. */
      monthName: (month: string) => `${month.slice(0, 4)} 年 ${Number(month.slice(5, 7))} 月`,
    };
  const day = (date: string) => new Date(`${date}T12:00:00+08:00`);
  const enMonthDay = (date: string) => new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: BEIJING }).format(day(date));
  const enMonthDayTime = (iso: string) =>
    `${new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: BEIJING }).format(new Date(iso))} ${beijingTime(iso)}`;
  return {
    relativeTime(iso: string, now = Date.now()): string {
      const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
      if (s < 60) return "just now";
      const m = Math.round(s / 60);
      if (m < 60) return `${m} min ago`;
      const h = Math.round(m / 60);
      if (h < 24) return `${h} h ago`;
      const d = Math.round(h / 24);
      if (d < 30) return `${d} d ago`;
      return beijingDate(iso);
    },
    monthDayTime: enMonthDayTime,
    /** "Sep 24 10:51", or "Sep 24" alone when the source gave only the date. */
    sourceMonthDayTime: (iso: string) => (isDateOnlyInstant(iso) ? enMonthDay(beijingDate(iso)) : enMonthDayTime(iso)),
    monthDay: enMonthDay,
    weekday: (date: string) => new Intl.DateTimeFormat("en", { weekday: "long", timeZone: BEIJING }).format(day(date)),
    /** "Nov 7, 2026" over "Sat". */
    dayHeading: (date: string) => ({
      label: new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: BEIJING }).format(day(date)),
      weekday: new Intl.DateTimeFormat("en", { weekday: "short", timeZone: BEIJING }).format(day(date)),
    }),
    /** "November 2026" for a YYYY-MM key. */
    monthName: (month: string) => new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: BEIJING }).format(day(`${month}-15`)),
  };
}
/** "2026 年 11 月 7 日". */
function fullDateLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return `${y} 年 ${m} 月 ${d} 日`;
}
function monthDayLabel(date: string): string {
  return `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
}
