// Background translation leaves room in the model quota for the steps a reader waits on (TASK-0580, Owner 2026-11-07).
// Model requests share one quota per provider (budgets: per hour and per day, retries included). Scoring, grouping
// and the AI 导读 decide what readers see; translating items that are not selected only improves pages already shown.
// So backlog translation pays only while both windows still have at least a quarter of their limit unused (half until
// TASK-0676); otherwise it waits and judges again. A fresh item, selected or not, is never held back here.
import { sql } from "../db.ts";
import { modelService } from "../providers/model-fallback-admission.ts";
import { modelFor } from "./models.ts";

/** Background translation may use up to this share of each window (hour, day); the rest is kept for core steps. */
export const BACKGROUND_QUOTA_SHARE = 0.75;
/** How long a held translation waits before it judges again. */
export const QUOTA_RECHECK_MS = 20 * 60_000;

/**
 * When a backlog translation must wait for quota, the time to judge again; null to go ahead (`ahead`: a fresh item,
 * TASK-0676). The quota judged is the one the request will draw on: before a paid segment, the model that segment is
 * paid with (`model`, fixed when the run started, so a route switched mid-body does not move the check away from it);
 * when a job is taken, the current translation route (the model chosen for "translate" now, so switching provider in
 * the admin moves the check with it; Codex review #372). Only when that cannot be resolved does it fall back to every
 * quota translation drew on in the last day. `at` is the caller's clock for the returned time; the windows are counted
 * by the database clock, as the quota check itself counts them.
 */
export async function translationQuotaWait(ahead: boolean, at?: Date, model?: string): Promise<Date | null> {
  if (ahead) return null;
  const current = await translationService(model);
  const services = current === null ? await recentTranslationServices() : [current];
  let held = false;
  for (const service of services) {
    if (await quotaPastShare(service)) held = true;
  }
  return held ? new Date((at ?? new Date()).getTime() + QUOTA_RECHECK_MS) : null;
}

/** Whether this quota is stopped or background translation has used its share of either window. */
async function quotaPastShare(service: string): Promise<boolean> {
  const [quota] = await sql<{ per_hour: number; per_day: number; hour: number; day: number }[]>`
    SELECT b.per_hour, b.per_day,
      (SELECT count(*)::int FROM receipt_attempts a WHERE coalesce(a.quota_service, a.service) = b.service AND a.origin = 'live'
        AND a.started_at > now() - interval '1 hour') AS hour,
      (SELECT count(*)::int FROM receipt_attempts a WHERE coalesce(a.quota_service, a.service) = b.service AND a.origin = 'live'
        AND a.started_at > now() - interval '1 day') AS day
    FROM budgets b WHERE b.service = ${service}`;
  if (!quota) return false;
  return (
    quota.per_hour <= 0 || quota.per_day <= 0 || quota.hour >= quota.per_hour * BACKGROUND_QUOTA_SHARE || quota.day >= quota.per_day * BACKGROUND_QUOTA_SHARE
  );
}

/** Every quota translation drew on in the last day: the fallback when the current route cannot be resolved. */
async function recentTranslationServices(): Promise<string[]> {
  const rows = await sql<{ service: string }[]>`
    SELECT DISTINCT coalesce(a.quota_service, a.service) AS service
    FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id
    WHERE r.purpose = 'translate_body' AND a.started_at > now() - interval '1 day'`;
  return rows.map((row) => row.service);
}

/** The quota service `model` (or else the current translation route) draws on, or null when it cannot be resolved now. */
async function translationService(model?: string): Promise<string | null> {
  try {
    return await modelService(model ?? (await modelFor("translate")), sql);
  } catch {
    return null;
  }
}
