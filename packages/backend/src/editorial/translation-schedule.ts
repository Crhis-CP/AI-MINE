// Which full-text translations start now and which wait (TASK-0569, Owner 2026-11-07, DEC-78补充·新闻原文全文与中文译文).
// Pure: no database or network; only offPeakWait reads the clock.
import { offPeakWait } from "../providers/peak-hours.ts";
import { translationBudgetUnits, translationSourceManifest } from "./translation-readiness.ts";

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
/** Token estimate for a prompt text (mostly Chinese). */
export function promptTokenEstimate(text: string): number {
  const han = [...text.matchAll(/\p{Script=Han}/gu)].length;
  return Math.ceil(han * TOKENS_PER_HAN + (text.length - han) / CHARS_PER_TOKEN);
}

/**
 * Cost-report estimate for translating one body of foreign-language HTML; no model call. It walks the same plan the
 * worker does: the source manifest's segments (every block is its own segment, so twenty short paragraphs are twenty
 * requests), in order, stopping at the first block beyond the 60,000-character budget (translationBudgetUnits).
 * Per segment, one request carries the whole system prompt S, a ~30-token JSON envelope, the segment's text and the
 * previous segment's reference line; the reply is Chinese with the same tags (about 0.3 tokens per source character
 * for English news HTML, plus ~10 for the envelope). The system prompt is the same for every segment, so with
 * provider prefix caching most of `calls × S` is billed at the cache-hit rate (`cachedPrefix`). Codex review #362:
 * the earlier estimate assumed ~3,600-character segments and undercounted bodies of many short paragraphs.
 */
export function translationTokenEstimate(html: string, systemTokens: number) {
  const manifest = translationSourceManifest(html);
  const chosen = translationBudgetUnits(html);
  let calls = 0,
    input = 0,
    output = 0;
  for (const segment of manifest.segments) {
    if (!chosen.has(segment.unitIndex)) break;
    calls++;
    input += systemTokens + 30 + Math.ceil(segment.html.length / CHARS_PER_TOKEN) + (segment.reference ? promptTokenEstimate(segment.reference) : 0);
    output += Math.ceil(segment.html.length * 0.3) + 10;
  }
  return { calls, input, output, cachedPrefix: Math.max(0, calls - 1) * systemTokens };
}
