import { FEEDBACK_LIMITS, FeedbackSubmissionFields } from "@amp/contracts/http/public";
// Feedback: content, optional email, page URL, one optional screenshot. It stays on the server and is
// forwarded only by the worker to the approved private feedback chat; admin pages keep the screenshot. Abuse control
// uses an unreadable source identifier (HMAC of client IP + UA family), per-source bans and a rolling per-minute request window.
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config, credential, isProduction } from "../config.ts";
import { feedbackSql as sql } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";

import { FeedbackRejected, feedbackPageUrl, feedbackImage } from "./feedback-validation.ts";
import { claimFeedbackQuota } from "./feedback-quota.ts";
export { FeedbackRejected } from "./feedback-validation.ts";
export { forwardPendingFeedback } from "./feedback-forward.ts";

let warnedMissingPublicSecret = false;

export function feedbackSourceHash(ip: string, userAgent: string): string {
  const configured = credential("auth", "PUBLIC_RATE_LIMIT_SECRET");
  if (!configured && isProduction) throw new Error("PUBLIC_RATE_LIMIT_SECRET is required in production");
  if (!configured && !warnedMissingPublicSecret) {
    console.warn("PUBLIC_RATE_LIMIT_SECRET is missing; using the development feedback secret");
    warnedMissingPublicSecret = true;
  }
  const secret = configured ?? "dev-feedback-secret";
  const uaFamily = (userAgent.match(/(Chrome|Safari|Firefox|Edg|MicroMessenger|Mobile|Android|iPhone|iPad|Mac OS X|Windows)/g) ?? []).slice(0, 4).join("/");
  return createHmac("sha256", secret).update(`${ip}|${uaFamily}`).digest("base64url").slice(0, 24);
}

export interface FeedbackInput {
  idempotencyKey?: string;
  content: string;
  email?: string | null;
  pageUrl?: string | null;
  screenshot?: { mime: string; data: Buffer } | null;
  ip: string;
  userAgent: string;
}

export async function submitFeedback(input: FeedbackInput): Promise<{ id: number }> {
  if (!input.idempotencyKey || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.idempotencyKey))
    throw new FeedbackRejected(400, "idempotency_key_required", "提交编号缺失或格式不正确，请刷新反馈表单后重试。");
  const content = input.content.trim();
  if (content.length < FEEDBACK_LIMITS.minText) throw new FeedbackRejected(400, "invalid_request", "反馈内容至少 2 字。");
  if (content.length > FEEDBACK_LIMITS.maxText) throw new FeedbackRejected(400, "invalid_request", "反馈内容最多 5000 字。");
  const parsedEmail = FeedbackSubmissionFields.shape.email.safeParse(input.email);
  if (!parsedEmail.success) throw new FeedbackRejected(400, "invalid_request", "请填写有效邮箱（最多200字符），或留空。");
  const email = parsedEmail.data || null;
  const pageUrl = feedbackPageUrl(input.pageUrl);
  const keyHash = sha256(input.idempotencyKey.toLowerCase());
  const payloadHash = sha256(
    stableJson({ content, email, pageUrl, screenshot: input.screenshot ? { mime: input.screenshot.mime, hash: sha256(input.screenshot.data) } : null }),
  );
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${keyHash}))`;
    const [prior] = await tx<
      { feedback_id: number; payload_hash: string }[]
    >`SELECT feedback_id,payload_hash FROM feedback.submissions WHERE key_hash=${keyHash}`;
    if (prior) {
      if (prior.payload_hash !== payloadHash) throw new FeedbackRejected(409, "idempotency_conflict", "该提交编号已用于不同内容，请刷新表单后重新提交。");
      return { id: prior.feedback_id };
    }
    const source = feedbackSourceHash(input.ip, input.userAgent);
    const [banned] = await tx`SELECT 1 FROM feedback_bans WHERE source_hash = ${source}`;
    if (banned) throw new FeedbackRejected(403, "forbidden", "暂时无法提交反馈。");
    claimFeedbackQuota(source);
    const screenshot = await feedbackImage(input.screenshot);
    let screenshotKey: string | null = null;
    if (screenshot) {
      const name = `${randomUUID()}.${screenshot.extension}`;
      const dir = path.join(config.dataDir, "feedback-screenshots");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, name), screenshot.data);
      screenshotKey = `local:${name}`;
    }
    const [row] = await tx<{ id: number }[]>`
    INSERT INTO feedback (content, email, page_url, screenshot_key, source_hash, forward_status)
    VALUES (${content}, ${email}, ${pageUrl}, ${screenshotKey}, ${source}, 'pending') RETURNING id`;
    await tx`INSERT INTO feedback.submissions(key_hash,payload_hash,feedback_id) VALUES(${keyHash},${payloadHash},${row!.id})`;
    return { id: row!.id };
  });
}
