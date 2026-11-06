/**
 * Provider peak/off-peak pricing windows, for model work that can wait: policy model stages, and on the news line the
 * re-merge look, story digest refreshes and the analysis of history.
 *
 * Source: DeepSeek's official API pricing page (api-docs.deepseek.com, “Models & Pricing”), checked 2026-11-05: calls
 * made off-peak are billed at half the peak rate. Peak is Monday–Friday 01:00–04:00 and 06:00–10:00 UTC (Beijing
 * 09:00–12:00 and 14:00–18:00, so the UTC weekday is also the Beijing weekday); every other hour, weekends included,
 * is off-peak. Chinese public holidays are not modelled: a holiday that falls on a weekday is treated like any other
 * weekday (its windows count as peak), which can only delay work, never move a paid call into a peak hour.
 * Update the constants below if the pricing page changes. No database or network; only offPeakWait reads the clock.
 */
import { environmentValue } from "../config.ts";

/** Weekdays (UTC, `Date#getUTCDay`) on which the peak windows apply: Monday to Friday. */
export const PROVIDER_PEAK_WEEKDAYS: readonly number[] = Object.freeze([1, 2, 3, 4, 5]);
/** Peak windows in UTC hours, start inclusive and end exclusive. */
export const PROVIDER_PEAK_WINDOWS_UTC: readonly { readonly startHour: number; readonly endHour: number }[] = Object.freeze([
  Object.freeze({ startHour: 1, endHour: 4 }),
  Object.freeze({ startHour: 6, endHour: 10 }),
]);

const HOUR = 3_600_000;
function peakWindow(now: Date) {
  if (Number.isNaN(now.getTime())) throw new Error("A valid time is required");
  if (!PROVIDER_PEAK_WEEKDAYS.includes(now.getUTCDay())) return null;
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const at = now.getTime() - dayStart;
  const window = PROVIDER_PEAK_WINDOWS_UTC.find((w) => at >= w.startHour * HOUR && at < w.endHour * HOUR);
  return window ? { dayStart, window } : null;
}

/** True while the provider bills its peak rate. */
export function isProviderPeak(now: Date): boolean {
  return peakWindow(now) !== null;
}

/** `now` itself when it is already off-peak, otherwise the end of the current peak window (the next off-peak instant). */
export function nextOffPeakStart(now: Date): Date {
  const peak = peakWindow(now);
  return peak ? new Date(peak.dayStart + peak.window.endHour * HOUR) : new Date(now.getTime());
}

/**
 * When work that can wait should start: null to go ahead now, otherwise the next off-peak start. A time the caller
 * passes (a test, a replay) is always judged; the wall clock is judged unless OFF_PEAK_DEFERRAL is "off", which the
 * test setup sets so tests about something else do not depend on the time of day they run.
 */
export function offPeakWait(at?: Date): Date | null {
  if (!at && environmentValue("OFF_PEAK_DEFERRAL") === "off") return null;
  const now = at ?? new Date();
  return isProviderPeak(now) ? nextOffPeakStart(now) : null;
}

/** The processing note on material that waits for the next off-peak start on purpose (alerts do not count it as stuck). */
export const OFF_PEAK_WAIT = "off_peak: 等到模型非高峰时段处理";
