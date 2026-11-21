// Small helpers the changelog's live blocks and the film player share (TASK-0367): price words, price layout, country names.
import { type Phrase, useLocale } from "../../../i18n";
import type { LiveMetal } from "./types";

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
  "国际 · LME 现货价": "International · LME cash",
  俄央行核算价: "Bank of Russia price",
};
export function usePriceWords() {
  const english = useLocale() === "en";
  return (text: string) => (english ? (ENGLISH[text] ?? text) : text);
}

/** Thousands separators and the quote's places (published digits kept when it fixes none). */
export function priceLabel(value: string, decimals: number | null): string {
  const [int = "", frac] = (decimals === null ? value : Number(value).toFixed(decimals)).split(".");
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac === undefined ? "" : `.${frac}`);
}

/** Where each point sits in a `w` × `h` box: x by order of publication, y by price. */
export function plot(metal: LiveMetal, w = 240, h = 64, pad = 4): Array<[number, number]> {
  const values = metal.points.map((p) => Number(p.value));
  const low = Math.min(...values),
    span = Math.max(...values) - low || 1;
  const n = Math.max(1, values.length - 1);
  return values.map((v, i) => [pad + ((w - 2 * pad) * i) / n, pad + (h - 2 * pad) * (1 - (v - low) / span)]);
}
