// Presentation helpers for the /metals cards: which quote leads a metal's card, how its period reads and whether it is
// behind. Everything comes from the public payload; nothing here invents a price, a date or a comparison.
import type { MetalPrices } from "@amp/contracts/http/public";
import { beijingDate } from "@amp/contracts/time";

export type Metal = MetalPrices["metals"][number];
export type Quote = Metal["quotes"][number];
export type Source = MetalPrices["sources"][number];
export type Note = MetalPrices["notes"][number];

/** A period label without the current Beijing year, as the latest-period line shows it ("2026年11月4日" → "11月4日"). */
export function shortLabel(prices: Pick<MetalPrices, "generatedAt">, label: string): string {
  const prefix = `${beijingDate(prices.generatedAt).slice(0, 4)}年`;
  return label.startsWith(prefix) ? label.slice(prefix.length) : label;
}

/** The frequency tag of a quote's source (日, 周, 旬, 月). */
export function tagOf(prices: Pick<MetalPrices, "sources">, quote: Quote): string {
  return prices.sources.find((source) => source.key === quote.source)?.tag ?? "";
}

/**
 * Whether the quote's period is one the API marks as earlier data (较早期数据): the latest-period line carries the
 * stale flag per frequency and per older period, with the metals on it.
 */
export function isBehind(prices: MetalPrices, metal: Metal, quote: Quote): boolean {
  if (!quote.period) return false;
  const latest = prices.latest.find((entry) => entry.tag === tagOf(prices, quote));
  if (!latest) return false;
  const label = shortLabel(prices, quote.period.label);
  if (latest.label === label) return latest.stale;
  return latest.extras.some((extra) => extra.stale && extra.label === label && extra.metals.includes(metal.name));
}

/**
 * The quote that leads a metal's card: one with a price before none, current before earlier data, the more frequent
 * source first (the API lists frequencies most frequent first: 日, 周, 旬, 月), then the later period, then the API's own
 * order (international benchmarks before domestic ones within a frequency). A metal with no price leads with its
 * first quote, shown as 暂缺.
 */
export function headlineIndex(prices: MetalPrices, metal: Metal): number {
  const rank = (quote: Quote) => {
    const index = prices.latest.findIndex((entry) => entry.tag === tagOf(prices, quote));
    return index < 0 ? prices.latest.length : index;
  };
  const order = metal.quotes.map((quote, index) => ({ quote, index }));
  order.sort(
    (a, b) =>
      Number(a.quote.value === null) - Number(b.quote.value === null) ||
      Number(isBehind(prices, metal, a.quote)) - Number(isBehind(prices, metal, b.quote)) ||
      rank(a.quote) - rank(b.quote) ||
      (b.quote.period?.end ?? "").localeCompare(a.quote.period?.end ?? "") ||
      a.index - b.index,
  );
  return order[0]!.index;
}

/**
 * The opening words of a held quote's footnote (backend/read.ts HELD_MARK): its newest value jumped too far and waits
 * for the next period, so the quote still shows the last value that went in.
 */
export const HELD_MARK = "待下期确认";

/** Whether the quote's newest value is held back alone, waiting for the next period to confirm it. */
export function isHeld(prices: Pick<MetalPrices, "notes">, quote: Quote): boolean {
  if (quote.footnote === null) return false;
  return prices.notes.some((note) => note.ref === quote.footnote && note.text.startsWith(`${HELD_MARK}：`));
}

/** A decimal string with thousands separators; `decimals` fixes the places, else the published digits are kept. */
export function priceText(value: string, decimals: number | null): string {
  if (decimals !== null) {
    // Intl accepts a decimal string without the precision loss of a JavaScript number; lib.d.ts lacks that overload.
    return new Intl.NumberFormat("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value as unknown as number);
  }
  const [integer = "", fraction] = value.split(".");
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction === undefined ? "" : `.${fraction}`);
}

/** "+1.2%", "−1.6%" (a true minus sign) or "0.0%"; the direction decides the colour: up, down or flat. */
export function changeText(percent: string): { text: string; direction: "up" | "down" | "flat" } {
  if (percent === "0.0") return { text: "0.0%", direction: "flat" };
  return percent.startsWith("-") ? { text: `−${percent.slice(1)}%`, direction: "down" } : { text: `+${percent}%`, direction: "up" };
}

/**
 * Notes with a link that name a source (the World Bank's CC BY 4.0 licence): shown with that source's quotes as well
 * as in the notes, so the licence travels with the numbers it covers.
 */
export function licenceNotes(notes: Note[], source: Source): Note[] {
  return notes.filter((note) => note.ref === null && note.link && note.text.includes(source.name));
}

/** A note's text with its {link} placeholder split around the link. */
export function noteParts(note: Note): [string, string] {
  const [before = "", after = ""] = note.text.split("{link}");
  return [before, after];
}

/** One point of a quote's trend line (TASK-0627). */
export interface TrendPoint {
  start: string;
  end: string;
  label: string;
  value: number;
}
export const TREND_RANGES = [
  { key: "1m", days: 31, label: "1个月" },
  { key: "3m", days: 93, label: "3个月" },
  { key: "1y", days: 366, label: "1年" },
] as const;
export type TrendRange = (typeof TREND_RANGES)[number]["key"];

/** A quote's stored periods as numbers; none when the quote has no history or a value does not read as a number. */
export function trendPoints(quote: Quote): TrendPoint[] {
  const points = (quote.history ?? []).map((point) => ({ ...point.period, value: Number(point.value) }));
  return points.every((point) => Number.isFinite(point.value)) ? points : [];
}
/** The points whose period ended within `days` of the latest one. */
export function trendWindow(points: TrendPoint[], days: number): TrendPoint[] {
  const last = points.at(-1);
  if (!last) return [];
  const from = new Date(Date.parse(`${last.end}T00:00:00Z`) - days * 86400_000).toISOString().slice(0, 10);
  return points.filter((point) => point.end >= from);
}
/** Ranges worth offering: each must show more periods than the one before it, and at least two. */
export function trendRanges(points: TrendPoint[]) {
  let shown = 1;
  return TREND_RANGES.filter((range) => {
    const count = trendWindow(points, range.days).length;
    if (count <= shown) return false;
    shown = count;
    return true;
  });
}
/**
 * The vertical scale of a trend line. The band is never narrower than MIN_BAND of the level, so a week of prices
 * that moved by half a percent draws as nearly flat instead of filling the chart with peaks: the height of a move
 * on screen says how big it was.
 */
export const TREND_MIN_BAND = 0.04;
export function trendScale(values: number[]): { min: number; max: number } {
  const low = Math.min(...values),
    high = Math.max(...values),
    middle = (low + high) / 2,
    half = Math.max((high - low) / 2, (Math.abs(middle) * TREND_MIN_BAND) / 2) * 1.08 || 1;
  return { min: middle - half, max: middle + half };
}
/** A period is drawn as a flat step when it is longer than a day (ten-day and monthly prices are one value for the period). */
export const trendStepped = (points: TrendPoint[]) => points.some((point) => point.start !== point.end);
