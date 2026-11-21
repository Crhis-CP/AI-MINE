// Small helpers the changelog film's storyboard and player share (TASK-0367): price words and periods in the reader's
// language, price layout, country names.
import { type Phrase, useLocale, useTr } from "../../../i18n";
import { beijingDate } from "../../../lib/format";
import type { FilmMetal, FilmPricePoint } from "./types";

const NAMES: Record<string, Phrase> = { CN: "中国", AR: "阿根廷" };
export const countryName = (code: string): Phrase | null => NAMES[code] ?? null;

/**
 * English for the price words these lines show (the metal, the quote, the unit). Kept here rather than in the phrase
 * book, where pages that translate run-time strings (titles, report labels) would start translating a bare “金” too.
 */
const ENGLISH: Record<string, string> = {
  铜: "Copper",
  金: "Gold",
  "美元/吨": "USD/t",
  "美元/盎司": "USD/oz",
  "元/吨": "CNY/t",
  "美元/干吨": "USD/dmt",
  "国际 · LME 现货价": "International · LME cash",
  俄央行核算价: "Bank of Russia price",
};
export function usePriceWords() {
  const english = useLocale() === "en";
  return (text: string) => (english ? (ENGLISH[text] ?? text) : text);
}

const day = (date: string) => new Date(`${date}T00:00:00Z`);
const english = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en", { ...options, timeZone: "UTC" });
const THIRDS: Record<string, string> = { 上旬: "Early", 中旬: "Mid", 下旬: "Late" };

/**
 * A published period in English, from its dates: a day (“Nov 19, 2026”), a ten-day period (“Early Nov 2026”) or a
 * month (“Oct 2026”); anything else as its two dates. Chinese keeps the label as the source published it.
 */
export function periodLabel(point: FilmPricePoint, inEnglish: boolean): string {
  if (!inEnglish) return point.label;
  if (point.start === point.end) return english({ month: "short", day: "numeric", year: "numeric" }).format(day(point.start));
  const month = english({ month: "short", year: "numeric" }).format(day(point.start));
  const third = Object.entries(THIRDS).find(([zh]) => point.label.includes(zh));
  if (third) return `${third[1]} ${month}`;
  const next = day(point.end);
  next.setUTCDate(next.getUTCDate() + 1);
  if (point.start.endsWith("-01") && next.getUTCDate() === 1) return month;
  return `${point.start} – ${point.end}`;
}
export function usePeriodLabel() {
  const inEnglish = useLocale() === "en";
  return (point: FilmPricePoint) => periodLabel(point, inEnglish);
}

/** Thousands separators and the quote's places (published digits kept when it fixes none). */
export function priceLabel(value: string, decimals: number | null): string {
  const [int = "", frac] = (decimals === null ? value : Number(value).toFixed(decimals)).split(".");
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac === undefined ? "" : `.${frac}`);
}

/** Where each point sits in a `w` × `h` box: x by order of publication, y by price. */
export function plot(metal: FilmMetal, w = 240, h = 64, pad = 4): Array<[number, number]> {
  const values = metal.points.map((p) => Number(p.value));
  const low = Math.min(...values),
    span = Math.max(...values) - low || 1;
  const n = Math.max(1, values.length - 1);
  return values.map((v, i) => [pad + ((w - 2 * pad) * i) / n, pad + (h - 2 * pad) * (1 - (v - low) / span)]);
}

/** “画面为 2026年11月22日 的截取” / “Snapshot of Nov 22, 2026”: the day (Beijing) a film's figures were captured. */
export function useSnapshotCaption() {
  const tr = useTr();
  const inEnglish = useLocale() === "en";
  return (takenAt: string) => {
    const date = beijingDate(takenAt);
    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    const shown = inEnglish ? english({ month: "short", day: "numeric", year: "numeric" }).format(day(date)) : `${y}年${m}月${d}日`;
    return tr("画面为 {date} 的截取", { date: shown });
  };
}
