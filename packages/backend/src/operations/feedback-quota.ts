import { FEEDBACK_LIMITS } from "@amp/contracts/http/public";
import { FeedbackRejected } from "./feedback-validation.ts";

const recent = new Map<string, number[]>();
/** New attempts count after text validation; a saved submission is returned before this point. */
export function claimFeedbackQuota(sourceHash: string): void {
  const now = Date.now(),
    cutoff = now - 60_000;
  const attempts = (recent.get(sourceHash) ?? []).filter((at) => at > cutoff);
  if (attempts.length >= FEEDBACK_LIMITS.perMinute) throw new FeedbackRejected(429, "rate_limited", "提交太频繁，请稍后再试。", 60);
  attempts.push(now);
  recent.set(sourceHash, attempts);
  if (recent.size > 5000) for (const [key, timestamps] of recent) if (timestamps.every((at) => at <= cutoff)) recent.delete(key);
}
