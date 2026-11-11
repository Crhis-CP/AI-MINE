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

/**
 * The enqueue-time wait above is not enough on its own (TASK-0579, Codex review #362): a backlog or a retry can pick a
 * waiting job up in a peak hour, and a long body's segments can run into one. So the worker judges again when it takes
 * the job and before every paid segment: an item that is not selected at that moment waits for the next off-peak start
 * (null: go ahead). Selection is read then, so an item selected while it waited is translated at once.
 */
export function translationPeakWait(selected: boolean, at?: Date): Date | null {
  return selected ? null : offPeakWait(at);
}

/**
 * Queue options for the job that takes over from one that waited (same payload, same queue). The key carries the
 * off-peak start, so it never equals the running job's key: that one was either queued under `later:<id>` / `<id>`
 * or under an earlier off-peak start, which has passed. Jobs waiting for the same start collapse into one; a cron
 * repair duplicate under `later:<id>` is harmless, as it finds the translation complete and makes no model call.
 */
export function translationDeferralOptions(articleId: string, until: Date) {
  return { singletonKey: `later:${articleId}:off-peak:${until.toISOString()}`, priority: PRIORITY.later, startAfter: until };
}

/**
 * Queue options for an item's English title and summary (TASK-0595): the same queue, priorities and off-peak wait as
 * body translation, under keys of their own so the two never collapse into one job. The worker judges peak hours and
 * the background quota share again when it takes the job (jobs/content.ts runEnglishCopyJob).
 */
export function englishCopyJobOptions(articleId: string, selected: boolean, at?: Date) {
  if (selected) return { singletonKey: `en:${articleId}`, priority: PRIORITY.selected };
  const wait = offPeakWait(at);
  return { singletonKey: `en-later:${articleId}`, priority: PRIORITY.later, ...(wait ? { startAfter: wait } : {}) };
}

/** The job that takes over from an English-copy job that waited (see translationDeferralOptions). */
export function englishCopyDeferralOptions(articleId: string, until: Date) {
  return { singletonKey: `en-later:${articleId}:off-peak:${until.toISOString()}`, priority: PRIORITY.later, startAfter: until };
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
