// Background translation leaves room in the model quota for the steps a reader waits on (TASK-0580, Owner 2026-11-07).
// Model requests share one quota per provider (budgets: per hour and per day, retries included). Scoring, grouping
// and the AI 导读 decide what readers see; translating items that are not selected only improves pages already shown.
// So a translation that is not selected pays only while both windows still have at least half of their limit unused;
// otherwise it waits and judges again. A selected item is never held back here (its peak-hour rule is unchanged).
import { sql } from "../db.ts";
import { LIVE_TRANSLATION_DAYS } from "./translation-schedule.ts";

/** Background translation may use up to this share of each window (hour, day); the rest is kept for core steps. */
export const BACKGROUND_QUOTA_SHARE = 0.5;
/** How long a held translation waits before it judges again. */
export const QUOTA_RECHECK_MS = 20 * 60_000;

/**
 * When a translation that is not selected must wait for quota, the time to judge again; null to go ahead. The quota
 * judged is every provider quota translation has drawn on in the last day (normally one). `at` is the caller's clock
 * for the returned time; the windows are counted by the database clock, as the quota check itself counts them.
 */
export async function translationQuotaWait(selected: boolean, at?: Date): Promise<Date | null> {
  if (selected) return null;
  const quotas = await sql<{ service: string; per_hour: number; per_day: number; hour: number; day: number }[]>`
    WITH used AS (
      SELECT DISTINCT coalesce(a.quota_service, a.service) AS service
      FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id
      WHERE r.purpose = 'translate_body' AND a.started_at > now() - interval '1 day'
    )
    SELECT b.service, b.per_hour, b.per_day,
      (SELECT count(*)::int FROM receipt_attempts a WHERE coalesce(a.quota_service, a.service) = b.service AND a.origin = 'live'
        AND a.started_at > now() - interval '1 hour') AS hour,
      (SELECT count(*)::int FROM receipt_attempts a WHERE coalesce(a.quota_service, a.service) = b.service AND a.origin = 'live'
        AND a.started_at > now() - interval '1 day') AS day
    FROM budgets b JOIN used ON used.service = b.service`;
  const held = quotas.some(
    (q) => q.per_hour <= 0 || q.per_day <= 0 || q.hour >= q.per_hour * BACKGROUND_QUOTA_SHARE || q.day >= q.per_day * BACKGROUND_QUOTA_SHARE,
  );
  return held ? new Date((at ?? new Date()).getTime() + QUOTA_RECHECK_MS) : null;
}

/**
 * Whether a selected item still goes ahead of the quota and peak-hour waits: only while it is fresh (found within the
 * live translation window). Opening a source's full text republishes its history, and selected items from weeks ago
 * would otherwise all be translated at once, at any hour and past any share of the quota (2026-11-07: six such jobs
 * from mid-October were among the requests that kept the hourly quota full). An old selected item is backlog and
 * waits like any other background translation; it is still translated, only not ahead of core steps. The database
 * clock judges freshness, as it records discovery.
 */
export async function freshSelection(articleId: string, selected: boolean): Promise<boolean> {
  if (!selected) return false;
  const [row] = await sql<{ fresh: boolean }[]>`
    SELECT discovered_at > now() - make_interval(days => ${LIVE_TRANSLATION_DAYS}) AS fresh FROM articles WHERE id = ${articleId}`;
  return row?.fresh === true;
}
