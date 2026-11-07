// Which full-text translations start now and which wait (TASK-0569, Owner 2026-11-07, DEC-78补充·新闻原文全文与中文译文).
// Pure: no database or network; only offPeakWait reads the clock.
import { offPeakWait } from "../providers/peak-hours.ts";
import { TRANSLATION_SEGMENT_BYTES } from "./translation-readiness.ts";

/**
 * Public items that are not selected are translated by the live pipeline only while they are this fresh (by the time
 * we found them). Older ones are reached by the bounded, resumable backfill (scripts/translate-backfill.ts), so a
 * source being republished never queues its whole history for paid translation at once.
 */
export const LIVE_TRANSLATION_DAYS = 2;
/** The backfill reaches back at most this far. */
export const BACKFILL_TRANSLATION_MAX_DAYS = 90;

const DAY = 86_400_000;
/** Queue priorities: higher runs first. Selected items keep the live analysis priority; the rest wait behind them. */
const PRIORITY = { selected: 0, later: -2 } as const;

/** True when a non-selected public item is fresh enough for the live pipeline to translate it on its own. */
export function liveTranslationWindow(discoveredAt: Date, now: Date): boolean {
  return now.getTime() - discoveredAt.getTime() <= LIVE_TRANSLATION_DAYS * DAY;
}

/**
 * Queue options for one body translation. Selected items run at once, as before. Every other admitted public item
 * goes through the same queue at a lower priority and, during the provider's peak hours, starts at the next off-peak
 * start (half price). The waiting job has its own singleton key, so an item selected while it waits still gets an
 * immediate job; the later one then finds the translation done and stops without a model call.
 * `at` is only passed by tests and replays; the wall clock is judged otherwise (see offPeakWait).
 */
export function translationJobOptions(articleId: string, selected: boolean, at?: Date) {
  if (selected) return { singletonKey: articleId, priority: PRIORITY.selected };
  const wait = offPeakWait(at);
  return { singletonKey: `later:${articleId}`, priority: PRIORITY.later, ...(wait ? { startAfter: wait } : {}) };
}

/** Rough tokens per Chinese character and per character of other text (HTML, Latin script) for the provider's tokenizer. */
const TOKENS_PER_HAN = 0.6;
const CHARS_PER_TOKEN = 3.5;
/** Body HTML beyond this is not translated (translationBudgetUnits) and shows as a partial translation. */
export const TRANSLATION_TEXT_LIMIT = 60_000;
/** Segments are cut at block boundaries below TRANSLATION_SEGMENT_BYTES, so they average about 90% full. */
const AVERAGE_SEGMENT_CHARS = Math.floor(TRANSLATION_SEGMENT_BYTES * 0.9);

/** Token estimate for a prompt text (mostly Chinese). */
export function promptTokenEstimate(text: string): number {
  const han = [...text.matchAll(/\p{Script=Han}/gu)].length;
  return Math.ceil(han * TOKENS_PER_HAN + (text.length - han) / CHARS_PER_TOKEN);
}

/**
 * Cost-report estimate for translating one body of `htmlChars` characters of foreign-language HTML; no model call.
 * Each segment is one request carrying the whole system prompt plus a ~30-token JSON envelope; the reply is the
 * Chinese text with the same tags (about 0.3 tokens per source character for English news HTML).
 *   calls  = max(1, ceil(min(H, 60000) / 3600))
 *   input  = calls × (S + 30) + ceil(min(H, 60000) / 3.5)
 *   output = ceil(min(H, 60000) × 0.3) + calls × 10
 * H = body HTML characters, S = system prompt tokens (promptTokenEstimate of translate-body). The system prompt is the
 * same for every segment, so with provider prefix caching most of `calls × S` is billed at the cache-hit rate.
 */
export function translationTokenEstimate(htmlChars: number, systemTokens: number) {
  const chars = Math.min(Math.max(0, htmlChars), TRANSLATION_TEXT_LIMIT);
  const calls = Math.max(1, Math.ceil(chars / AVERAGE_SEGMENT_CHARS));
  return {
    calls,
    input: calls * (systemTokens + 30) + Math.ceil(chars / CHARS_PER_TOKEN),
    output: Math.ceil(chars * 0.3) + calls * 10,
    cachedPrefix: Math.max(0, calls - 1) * systemTokens,
  };
}
