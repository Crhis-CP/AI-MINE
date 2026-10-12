import type { Tx } from "../db.ts";
import { FeedbackRejected } from "./feedback-validation.ts";

/** Claims share the submission transaction: rejecting either bucket rolls back both claims. */
export async function claimFeedbackQuota(tx: Tx, sourceHash: string) {
  const [daily] = await tx`INSERT INTO feedback.quota_buckets(scope,bucket_key,window_start,used)
    VALUES('site_day','site',date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai',1)
    ON CONFLICT(scope,bucket_key,window_start) DO UPDATE SET used=feedback.quota_buckets.used+1
    WHERE feedback.quota_buckets.used < 500 RETURNING used`;
  if (!daily) throw new FeedbackRejected(429, "rate_limited", "今日提交较多，请稍后再试。", 3600);
  const [hourly] = await tx`INSERT INTO feedback.quota_buckets(scope,bucket_key,window_start,used)
    VALUES('client_hour',${sourceHash},date_trunc('hour',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai',1)
    ON CONFLICT(scope,bucket_key,window_start) DO UPDATE SET used=feedback.quota_buckets.used+1
    WHERE feedback.quota_buckets.used < 5 RETURNING used`;
  if (!hourly) throw new FeedbackRejected(429, "rate_limited", "提交较频繁，请稍后再试。", 3600);
}
