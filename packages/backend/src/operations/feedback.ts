import { FEEDBACK_LIMITS, FeedbackSubmissionFields } from "@amp/contracts/http/public";
// Feedback: content, optional email, page URL, one optional screenshot. It stays on the server and is
// forwarded only by the worker to the approved private feedback chat; admin pages keep the screenshot. Abuse control
// uses an unreadable source identifier (HMAC of client IP + UA family), persistent hourly limits and expiring moderator bans.
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { config, credential, isProduction } from "../config.ts";
import { feedbackSql as sql } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";

import { FeedbackRejected, feedbackPageUrl, feedbackImage } from "./feedback-validation.ts";
import { claimFeedbackQuota } from "./feedback-quota.ts";
export { FeedbackRejected } from "./feedback-validation.ts";
export { forwardPendingFeedback } from "./feedback-forward.ts";

let warnedMissingPublicSecret = false;

function identifierSecret(): string {
  const configured = credential("auth", "PUBLIC_RATE_LIMIT_SECRET");
  if (!configured && isProduction) throw new Error("PUBLIC_RATE_LIMIT_SECRET is required in production");
  if (!configured && !warnedMissingPublicSecret) {
    console.warn("PUBLIC_RATE_LIMIT_SECRET is missing; using the development feedback secret");
    warnedMissingPublicSecret = true;
  }
  return configured ?? "dev-feedback-secret";
}

export function feedbackEmailKey(email: string): string {
  return `email:${createHmac("sha256", identifierSecret()).update(email.trim().toLowerCase()).digest("base64url")}`;
}

export function feedbackSourceHash(ip: string, userAgent: string): string {
  const matches = userAgent.match(/(Chrome|Safari|Firefox|Edg|MicroMessenger|Mobile|Android|iPhone|iPad|Mac OS X|Windows)/g);
  const uaFamily = matches ? matches.slice(0, 4).join("/") : "";
  return createHmac("sha256", identifierSecret()).update(`${ip}|${uaFamily}`).digest("base64url").slice(0, 24);
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
  const fingerprint = sha256(stableJson({ content, email, pageUrl, screenshot: input.screenshot ? sha256(input.screenshot.data) : null }));
  const source = feedbackSourceHash(input.ip, input.userAgent);
  const emailKey = email ? feedbackEmailKey(email) : null;
  let file: string | null = null;
  let rejection: FeedbackRejected | undefined;
  const reject = (error: FeedbackRejected) => {
    rejection = error;
    return { id: 0 };
  };
  try {
    const result = await sql.begin(async (tx): Promise<{ id: number }> => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`feedback:${source}`}))`;
      await tx`SELECT pg_advisory_xact_lock(hashtext(${keyHash}))`;
      const now = new Date();
      const [ban] = await tx<{ expires_at: Date | null }[]>`SELECT expires_at FROM feedback_bans
        WHERE (source_hash=${source} OR source_hash=${emailKey}) AND (expires_at IS NULL OR expires_at>${now}) ORDER BY expires_at DESC NULLS FIRST LIMIT 1`;
      if (ban)
        return reject(
          new FeedbackRejected(
            ban.expires_at ? 429 : 403,
            ban.expires_at ? "rate_limited" : "forbidden",
            "暂时无法提交反馈。",
            ban.expires_at ? Math.max(1, Math.ceil((ban.expires_at.getTime() - now.getTime()) / 1000)) : undefined,
          ),
        );
      const [prior] = await tx<
        { feedback_id: number; payload_hash: string }[]
      >`SELECT feedback_id,payload_hash FROM feedback.submissions WHERE key_hash=${keyHash}`;
      const quota = await claimFeedbackQuota(tx, source, fingerprint, prior?.feedback_id);
      if (quota.error) return reject(quota.error);
      if (prior && prior.payload_hash !== payloadHash && prior.payload_hash !== fingerprint)
        return reject(new FeedbackRejected(409, "idempotency_conflict", "该提交编号已用于不同内容，请刷新表单后重新提交。"));
      if (quota.duplicate) {
        if (!prior) await tx`INSERT INTO feedback.submissions(key_hash,payload_hash,feedback_id) VALUES(${keyHash},${fingerprint},${quota.duplicate})`;
        return { id: quota.duplicate };
      }
      let screenshot: Awaited<ReturnType<typeof feedbackImage>>;
      try {
        screenshot = await feedbackImage(input.screenshot);
      } catch (error) {
        if (error instanceof FeedbackRejected) return reject(error);
        throw error;
      }
      let screenshotKey: string | null = null;
      if (screenshot) {
        const name = `${randomUUID()}.${screenshot.extension}`;
        const dir = path.join(config.dataDir, "feedback-screenshots");
        await mkdir(dir, { recursive: true });
        file = path.join(dir, name);
        await writeFile(file, screenshot.data);
        screenshotKey = `local:${name}`;
      }
      const [row] = await tx<{ id: number }[]>`INSERT INTO feedback(content,email,page_url,screenshot_key,source_hash,forward_status)
        VALUES(${content},${email},${pageUrl},${screenshotKey},${source},'pending') RETURNING id`;
      await tx`INSERT INTO feedback.submissions(key_hash,payload_hash,feedback_id) VALUES(${keyHash},${fingerprint},${row!.id})`;
      quota.submissions.push({ at: quota.now, id: row!.id, fingerprint });
      await tx`UPDATE feedback.submission_state SET submissions=${tx.json(quota.submissions)} WHERE source_hash=${source}`;
      return { id: row!.id };
    });
    if (rejection) throw rejection;
    return result;
  } catch (error) {
    if (file) await unlink(file).catch(() => {});
    throw error;
  }
}
