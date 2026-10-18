import { FEEDBACK_LIMITS } from "@amp/contracts/http/public";
import type { Db } from "../db.ts";
import { FeedbackRejected } from "./feedback-validation.ts";

export type Submission = { at: number; id: number; fingerprint: string };
const HOUR = 3600_000;
type QuotaResult =
  | { error: FeedbackRejected; duplicate?: never; submissions?: never; now?: never }
  | { error?: never; duplicate?: number; submissions: Submission[]; now: number };
/** Caller holds the source lock until its submission or rejection commits. No raw identifiers are stored. */
export async function claimFeedbackQuota(db: Db, source: string, fingerprint: string, savedId?: number): Promise<QuotaResult> {
  const now = Date.now();
  const [state] = await db<{ attempts: number[]; submissions: Submission[]; paused_until: Date | null }[]>`
    INSERT INTO feedback.submission_state(source_hash,expires_at) VALUES(${source},${new Date(now + HOUR)})
    ON CONFLICT(source_hash) DO UPDATE SET expires_at=EXCLUDED.expires_at RETURNING attempts,submissions,paused_until`;
  const attempts = state!.attempts.filter((at) => at > now - HOUR);
  const submissions = state!.submissions.filter((entry) => entry.at > now - HOUR);
  const duplicate = savedId ?? submissions.find((entry) => entry.fingerprint === fingerprint)?.id;
  const paused = state!.paused_until?.getTime() ?? 0;
  if (paused > now)
    return { error: new FeedbackRejected(429, "rate_limited", "反馈提交已暂时暂停，请稍后再试，草稿会保留。", Math.ceil((paused - now) / 1000)) };
  if (attempts.length >= FEEDBACK_LIMITS.attemptsPerHour || (!duplicate && submissions.length >= FEEDBACK_LIMITS.perHour)) {
    await db`UPDATE feedback.submission_state SET paused_until=${new Date(now + HOUR)},expires_at=${new Date(now + HOUR)} WHERE source_hash=${source}`;
    return { error: new FeedbackRejected(429, "rate_limited", "反馈提交过于频繁，已暂停 1 小时。请稍后再试，草稿会保留。", FEEDBACK_LIMITS.pauseSeconds) };
  }
  attempts.push(now);
  await db`UPDATE feedback.submission_state SET attempts=${db.json(attempts)},submissions=${db.json(submissions)},paused_until=NULL WHERE source_hash=${source}`;
  return { duplicate, submissions, now };
}
