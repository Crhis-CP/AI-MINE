import { EDITION_TIMES } from "@amp/industry/site";
// Names, dates and grouping for daily, weekly and monthly reports. Each function gives the Chinese the site
// has always printed; with `english` it gives the English interface's (DEC-78), and useReportFormat picks
// the page's language.
import { SITE, withSubject } from "@amp/industry/site";
import type { ReportNavigationEntry, ReportKind } from "@amp/contracts/site";
import { useMemo } from "react";
import { basePath, useLocale } from "../../i18n";
import { beijingDate, beijingWeekday } from "../../lib/format";

export const KINDS: ReportKind[] = ["daily", "weekly", "monthly"];
export const KIND_PATH: Record<ReportKind, string> = { daily: "/daily", weekly: "/weekly", monthly: "/monthly" };
export const KIND_LABEL: Record<ReportKind, string> = { daily: "日报", weekly: "周报", monthly: "月报" };

/** The kind of report at an address, in either interface language (/en/weekly is the weekly page too). */
export function kindFromPath(pathname: string): ReportKind {
  const path = basePath(pathname);
  if (path.startsWith("/weekly")) return "weekly";
  if (path.startsWith("/monthly")) return "monthly";
  return "daily";
}

export function reportPath(kind: ReportKind, key: string): string {
  return `${KIND_PATH[kind]}/${key}`;
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

// English names of months and days, spelled out here so the server and the browser print the same words.
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** "November" for month 11. */
const month = (m: number) => MONTHS[m - 1]!;
/** "Nov" for month 11. */
const mon = (m: number) => month(m).slice(0, 3);
/** "Nov 6" for 2026-11-06. */
const enDay = (date: string) => `${mon(Number(date.slice(5, 7)))} ${Number(date.slice(8, 10))}`;
/** "Friday" for 2026-11-06. */
const enWeekday = (date: string) => WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
/** "1 issue", "3 issues". */
const counted = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const NAME_EN: Record<ReportKind, string> = { daily: "Daily brief", weekly: "Weekly brief", monthly: "Monthly brief" };

/** Monday and Sunday (YYYY-MM-DD) of an ISO week key such as 2026-W38. */
export function isoWeekRange(key: string): [string, string] {
  const [y, w] = key.split("-W").map(Number) as [number, number];
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400000 + (w - 1) * 7 * 86400000);
  return [ymd(monday), ymd(new Date(monday.getTime() + 6 * 86400000))];
}

/** First and last day of a month key such as 2026-08. */
export function monthRange(key: string): [string, string] {
  const [y, m] = key.split("-").map(Number) as [number, number];
  return [`${key}-01`, ymd(new Date(Date.UTC(y, m, 0)))];
}

/** "这一天的 4 件矿业大事" / "本周的 12 件矿业大事" / "8 月的 20 件矿业大事"; "The day's 4 major mining events". */
export function headline(kind: ReportKind, key: string, count: number, english = false): string {
  if (english) {
    const events = counted(count, "major mining event");
    return kind === "daily" ? `The day's ${events}` : kind === "weekly" ? `This week's ${events}` : `${month(Number(key.slice(5, 7)))}'s ${events}`;
  }
  if (kind === "daily") return `这一天的 ${count} 件${withSubject("大事")}`;
  if (kind === "weekly") return `本周的 ${count} 件${withSubject("大事")}`;
  return `${Number(key.slice(5, 7))} 月的 ${count} 件${withSubject("大事")}`;
}

/** "09.16" ("Sep 16") for a story inside a week or month. */
export function shortDay(iso: string, english = false): string {
  if (english) return enDay(beijingDate(iso));
  const d = new Date(Date.parse(iso) + 8 * 3600000);
  return `${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`;
}

/** Month-day label of a daily key: "9月26日" ("Sep 26"). */
export function dayLabel(key: string, english = false): string {
  return english ? enDay(key) : `${Number(key.slice(5, 7))}月${Number(key.slice(8, 10))}日`;
}

export interface ArchiveGroup {
  id: string;
  label: string;
  entries: Array<ReportNavigationEntry & { short: string }>;
}

/**
 * The archive column: days grouped by month, weeks by the month their Monday falls in ("第2周"),
 * months by year. Newest first, as the index comes.
 */
export function archiveGroups(kind: ReportKind, index: ReportNavigationEntry[], english = false): ArchiveGroup[] {
  const groups: ArchiveGroup[] = [];
  const push = (id: string, label: string, e: ReportNavigationEntry & { short: string }) => {
    const g = groups[groups.length - 1];
    if (g && g.id === id) g.entries.push(e);
    else groups.push({ id, label, entries: [e] });
  };
  /** "2026 年 9 月" ("September 2026") for a month key. */
  const monthName = (m: string) => (english ? `${month(Number(m.slice(5, 7)))} ${m.slice(0, 4)}` : `${m.slice(0, 4)} 年 ${Number(m.slice(5, 7))} 月`);
  if (kind === "weekly") {
    const byMonth = new Map<string, string[]>();
    for (const e of index) {
      const m = isoWeekRange(e.key)[0].slice(0, 7);
      byMonth.set(m, [...(byMonth.get(m) ?? []), e.key]);
    }
    for (const e of index) {
      const m = isoWeekRange(e.key)[0].slice(0, 7);
      const weeks = [...byMonth.get(m)!].sort();
      const n = weeks.indexOf(e.key) + 1;
      push(m, monthName(m), { ...e, short: english ? `week ${n}` : `第${n}周` });
    }
    return groups;
  }
  for (const e of index) {
    if (kind === "daily")
      push(e.key.slice(0, 7), monthName(e.key), { ...e, short: english ? String(Number(e.key.slice(8, 10))) : `${Number(e.key.slice(8, 10))} 日` });
    else
      push(e.key.slice(0, 4), english ? e.key.slice(0, 4) : `${e.key.slice(0, 4)} 年`, {
        ...e,
        short: english ? mon(Number(e.key.slice(5, 7))) : `${Number(e.key.slice(5, 7))} 月`,
      });
  }
  return groups;
}

/** An issue's mark in the archive column: a large number over a small word (a month's number stands alone). */
export function archiveMark(kind: ReportKind, key: string, english = false): { big: string; small: string | null } {
  if (kind === "daily") return { big: key.slice(8, 10), small: english ? enWeekday(key).slice(0, 3) : beijingWeekday(key).replace("星期", "周") };
  if (kind === "weekly") {
    const start = isoWeekRange(key)[0];
    return { big: key.slice(6), small: english ? enDay(start) : `${Number(start.slice(5, 7))}.${Number(start.slice(8, 10))} 起` };
  }
  return { big: key.slice(5, 7), small: null };
}

/** Short chip label for the phone switcher: "今天", "9月26日", "9月第2周", "8 月" ("Today", "Sep 26", "Sep week 2", "August"). */
export function chipLabel(kind: ReportKind, key: string, index: ReportNavigationEntry[], today: string, english = false): string {
  if (kind === "daily") return key === today ? (english ? "Today" : "今天") : dayLabel(key, english);
  if (kind === "monthly") return english ? month(Number(key.slice(5, 7))) : `${Number(key.slice(5, 7))} 月`;
  const group = archiveGroups("weekly", index, english).find((g) => g.entries.some((e) => e.key === key));
  const entry = group?.entries.find((e) => e.key === key);
  if (!group || !entry) return key;
  return english ? `${mon(Number(group.id.slice(5)))} ${entry.short}` : `${Number(group.id.slice(5))}月${entry.short}`;
}

/** "第 N 期": the issue's place in its series, counted from the first report that exists. */
export function issueNumber(index: ReportNavigationEntry[], key: string): number | null {
  const at = index.findIndex((e) => e.key === key);
  return at < 0 ? null : index.length - at;
}

/** The masthead's date block: a large figure and two small lines beside it. */
export function dateMark(kind: ReportKind, key: string, english = false): { figure: string; top: string; bottom: string } {
  if (kind === "daily")
    return english
      ? { figure: key.slice(8, 10), top: `${month(Number(key.slice(5, 7)))} ${key.slice(0, 4)}`, bottom: enWeekday(key) }
      : { figure: key.slice(8, 10), top: `${key.slice(0, 4)} 年 ${Number(key.slice(5, 7))} 月`, bottom: beijingWeekday(key) };
  if (kind === "weekly") {
    const [a, b] = isoWeekRange(key);
    return english
      ? { figure: key.slice(6), top: `Week ${Number(key.slice(6))}, ${key.slice(0, 4)}`, bottom: `${enDay(a)} — ${enDay(b)}` }
      : {
          figure: key.slice(6),
          top: `${key.slice(0, 4)} 年第 ${Number(key.slice(6))} 周`,
          bottom: `${a.slice(5).replace("-", ".")} — ${b.slice(5).replace("-", ".")}`,
        };
  }
  return english
    ? { figure: key.slice(5, 7), top: key.slice(0, 4), bottom: month(Number(key.slice(5, 7))) }
    : { figure: key.slice(5, 7), top: `${key.slice(0, 4)} 年`, bottom: `${Number(key.slice(5, 7))} 月` };
}

/** When each kind comes out (F10), for the masthead. */
export const EDITION: Record<ReportKind, string> = {
  daily: `每天 ${EDITION_TIMES.daily} 出刊`,
  weekly: `每周一 ${EDITION_TIMES.weekly} 出刊`,
  monthly: `每月 1 日 ${EDITION_TIMES.monthly} 出刊`,
};
const EDITION_EN: Record<ReportKind, string> = {
  daily: `Daily at ${EDITION_TIMES.daily} Beijing time`,
  weekly: `Mondays at ${EDITION_TIMES.weekly} Beijing time`,
  monthly: `On the 1st at ${EDITION_TIMES.monthly} Beijing time`,
};

/** The masthead's figures, in the order a reader wants them; zero model releases is left out. */
const METRICS: Array<[key: string, unit: string, one: string, many: string]> = [
  ["totalEvents", "件大事", "major event", "major events"],
  ["totalStories", "件大事", "major event", "major events"],
  ["sourcesCount", "个来源", "source", "sources"],
  ["firstPartyEvents", "件一手发布", "first-party release", "first-party releases"],
  ["selectedCount", "条精选", "pick", "picks"],
  ["reportsCovered", "期日报", "daily issue", "daily issues"],
];
export function metricItems(metrics: Record<string, number>, english = false): Array<{ key: string; value: number; unit: string }> {
  return METRICS.filter(([k]) => typeof metrics[k] === "number" && (k !== "modelsReleased" || metrics[k]! > 0)).map(([k, unit, one, many]) => ({
    key: k,
    value: metrics[k]!,
    unit: english ? (metrics[k] === 1 ? one : many) : unit,
  }));
}

/** "前一日 · 9月25日", "上一期 · 第 37 周", "下一期 · 7 月" ("Previous day · Sep 25", "Next issue · Week 39"). */
export function neighbourLabel(kind: ReportKind, key: string, direction: "prev" | "next", english = false): string {
  if (english) {
    if (kind === "daily") return `${direction === "prev" ? "Previous day" : "Next day"} · ${enDay(key)}`;
    const which = direction === "prev" ? "Previous issue" : "Next issue";
    return kind === "weekly" ? `${which} · Week ${Number(key.slice(6))}` : `${which} · ${month(Number(key.slice(5, 7)))}`;
  }
  if (kind === "daily") return `${direction === "prev" ? "前一日" : "后一日"} · ${dayLabel(key)}`;
  const which = direction === "prev" ? "上一期" : "下一期";
  return kind === "weekly" ? `${which} · 第 ${Number(key.slice(6))} 周` : `${which} · ${Number(key.slice(5, 7))} 月`;
}

const CN = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
/** Page numbers as a Chinese paper prints them: 1 → 一, 12 → 十二, 20 → 二十. */
export function cnNumber(n: number): string {
  if (n <= 10) return CN[n]!;
  if (n < 20) return `十${CN[n - 10]}`;
  return `${CN[Math.floor(n / 10)]}十${n % 10 ? CN[n % 10] : ""}`;
}

/**
 * The line above the nameplate: "2026 年 9 月 26 日 · 星期六", "2026 年第 38 周 · 09.14 — 09.20", "2026 年 8 月"
 * ("Saturday, September 26, 2026", "Week 38, 2026 · Sep 14 — Sep 20", "August 2026").
 */
export function dateLine(kind: ReportKind, key: string, english = false): string {
  const m = dateMark(kind, key, english);
  if (english) {
    if (kind === "daily") return `${m.bottom}, ${month(Number(key.slice(5, 7)))} ${Number(key.slice(8, 10))}, ${key.slice(0, 4)}`;
    return kind === "weekly" ? `${m.top} · ${m.bottom}` : `${m.bottom} ${m.top}`;
  }
  if (kind === "daily") return `${m.top} ${Number(key.slice(8, 10))} 日 · ${m.bottom}`;
  return kind === "weekly" ? `${m.top} · ${m.bottom}` : `${m.top} ${m.bottom}`;
}

/** What each kind is, under its nameplate. */
export const MOTTO: Record<ReportKind, string> = { daily: "金属矿业 · 每日要闻", weekly: "金属矿业 · 每周综述", monthly: "金属矿业 · 每月盘点" };
const MOTTO_EN: Record<ReportKind, string> = {
  daily: "Metal mining · Daily headlines",
  weekly: "Metal mining · Weekly review",
  monthly: "Metal mining · Monthly roundup",
};

export interface PeriodCell {
  key: string | null;
  /** Hover text: "9月26日 · 第 158 期" ("Sep 26 · Issue 158"). */
  label: string;
  state: "current" | "issue" | "none" | "pad";
}

/** ISO week number of a date (YYYY-MM-DD). */
function isoWeek(day: string): number {
  const d = new Date(`${day}T00:00:00Z`);
  const thursday = new Date(d.getTime() + (3 - ((d.getUTCDay() + 6) % 7)) * 86400000);
  const jan1 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  return Math.floor((thursday.getTime() - jan1.getTime()) / 86400000 / 7) + 1;
}

/**
 * The dot grid beside the date in the masthead: the days of this issue's month (dailies, Monday first),
 * the weeks of its year (weeklies) or the months of its year (monthlies), each marked as this issue,
 * an issue that exists, or none.
 */
export function periodGrid(
  kind: ReportKind,
  key: string,
  index: ReportNavigationEntry[],
  english = false,
): { title: string; note: string; columns: number; heads: string[] | null; cells: PeriodCell[] } {
  const exists = new Set(index.map((e) => e.key));
  const cell = (k: string, name: string): PeriodCell => {
    const n = issueNumber(index, k);
    const label = english ? (n ? `${name} · Issue ${n}` : `${name} · no issue`) : n ? `${name} · 第 ${n} 期` : `${name} · 未出刊`;
    return { key: k, label, state: k === key ? "current" : exists.has(k) ? "issue" : "none" };
  };
  const count = (cells: PeriodCell[]) => cells.filter((c) => c.state === "issue" || c.state === "current").length;
  const year = key.slice(0, 4);
  /** "全年 12 期" ("12 issues this year"). */
  const inYear = (cells: PeriodCell[]) => (english ? `${counted(count(cells), "issue")} this year` : `全年 ${count(cells)} 期`);
  if (kind === "daily") {
    const m = Number(key.slice(5, 7));
    const days = new Date(Date.UTC(Number(year), m, 0)).getUTCDate();
    const lead = (new Date(Date.UTC(Number(year), m - 1, 1)).getUTCDay() + 6) % 7;
    const cells: PeriodCell[] = [
      ...Array.from({ length: lead }, (): PeriodCell => ({ key: null, label: "", state: "pad" })),
      ...Array.from({ length: days }, (_, i) => cell(`${key.slice(0, 7)}-${pad(i + 1)}`, english ? `${mon(m)} ${i + 1}` : `${m}月${i + 1}日`)),
    ];
    return english
      ? { title: month(m), note: `${counted(count(cells), "issue")} this month`, columns: 7, heads: ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"], cells }
      : { title: `${cnNumber(m)}月`, note: `本月 ${count(cells)} 期`, columns: 7, heads: ["一", "二", "三", "四", "五", "六", "日"], cells };
  }
  if (kind === "weekly") {
    const weeks = isoWeek(`${year}-12-28`);
    const cells = Array.from({ length: weeks }, (_, i) => {
      const k = `${year}-W${pad(i + 1)}`;
      const [a, b] = isoWeekRange(k);
      return cell(k, english ? `Week ${i + 1} (${enDay(a)}–${enDay(b)})` : `第 ${i + 1} 周（${a.slice(5).replace("-", ".")}—${b.slice(5).replace("-", ".")}）`);
    });
    return { title: english ? year : `${year} 年`, note: inYear(cells), columns: 13, heads: null, cells };
  }
  const cells = Array.from({ length: 12 }, (_, i) => cell(`${year}-${pad(i + 1)}`, english ? month(i + 1) : `${i + 1} 月`));
  return { title: english ? year : `${year} 年`, note: inYear(cells), columns: 6, heads: null, cells };
}

/** The report words and dates of one interface language, for the report pages' components. */
export function reportFormat(english: boolean) {
  return {
    english,
    /** 日报 / Daily: the kind switch and the archive column. */
    label: english ? { daily: "Daily", weekly: "Weekly", monthly: "Monthly" } : KIND_LABEL,
    /** 矿业日报 / Daily brief: an issue's name. */
    name: english ? NAME_EN : { daily: withSubject(KIND_LABEL.daily), weekly: withSubject(KIND_LABEL.weekly), monthly: withSubject(KIND_LABEL.monthly) },
    motto: english ? MOTTO_EN : MOTTO,
    edition: english ? EDITION_EN : EDITION,
    /** 往期矿业周报 / Past weekly briefs: the heading over earlier issues. */
    pastHeading: (kind: ReportKind) => (english ? `Past ${NAME_EN[kind].toLowerCase()}s` : `往期${withSubject(KIND_LABEL[kind])}`),
    /** 往期周报 / Past weekly briefs: the colophon's link to them. */
    pastLink: (kind: ReportKind) => (english ? `Past ${NAME_EN[kind].toLowerCase()}s` : `往期${KIND_LABEL[kind]}`),
    /** Who makes the issue, before the colophon's link. */
    colophon: (kind: ReportKind) =>
      english
        ? `This ${NAME_EN[kind].toLowerCase()} is ${kind === "daily" ? "edited" : "compiled"} automatically by the editorial system from public sources, each item with a link to its original ·`
        : `${SITE.name} ${KIND_LABEL[kind]}由编辑系统根据公开来源自动${kind === "daily" ? "编辑" : "综合"}，每条均附原文 ·`,
    /** An issue the index has no title for: "AI矿策 周报 · 2026-W38" ("Weekly brief · 2026-W38"). */
    untitled: (kind: ReportKind, key: string) => (english ? `${NAME_EN[kind]} · ${key}` : `${SITE.name} ${KIND_LABEL[kind]} · ${key}`),
    headline: (kind: ReportKind, key: string, count: number) => headline(kind, key, count, english),
    shortDay: (iso: string) => shortDay(iso, english),
    day: (key: string) => dayLabel(key, english),
    archiveGroups: (kind: ReportKind, index: ReportNavigationEntry[]) => archiveGroups(kind, index, english),
    archiveMark: (kind: ReportKind, key: string) => archiveMark(kind, key, english),
    chipLabel: (kind: ReportKind, key: string, index: ReportNavigationEntry[], today: string) => chipLabel(kind, key, index, today, english),
    dateMark: (kind: ReportKind, key: string) => dateMark(kind, key, english),
    dateLine: (kind: ReportKind, key: string) => dateLine(kind, key, english),
    metricItems: (metrics: Record<string, number>) => metricItems(metrics, english),
    neighbourLabel: (kind: ReportKind, key: string, direction: "prev" | "next") => neighbourLabel(kind, key, direction, english),
    periodGrid: (kind: ReportKind, key: string, index: ReportNavigationEntry[]) => periodGrid(kind, key, index, english),
  };
}
export type ReportFormat = ReturnType<typeof reportFormat>;

/** The report words and dates in the page's interface language. */
export function useReportFormat(): ReportFormat {
  const english = useLocale() === "en";
  return useMemo(() => reportFormat(english), [english]);
}
