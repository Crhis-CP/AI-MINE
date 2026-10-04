// Feedback: content, optional email, page URL, one optional screenshot. It stays on the server and is
// never forwarded to a chat (INV-27); the screenshot is readable only from the admin pages. Abuse control
// uses an unreadable source identifier (HMAC of client IP + UA family), per-source bans and a per-minute limit.
import { createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config, credential, isProduction } from "../config.ts";
import { dbOf } from "../db.ts";
import { sha256 } from "../lib/ids.ts";

const sql = dbOf("feedback");
let warnedMissingPublicSecret = false;

export class FeedbackRejected extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter?: number;
  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

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

const recent = new Map<string, number[]>();
function rateLimit(source: string, perMinute = 5): void {
  const now = Date.now();
  const list = (recent.get(source) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= perMinute) throw new FeedbackRejected(429, "rate_limited", "提交太频繁，请稍后再试。", 60);
  list.push(now);
  recent.set(source, list);
  if (recent.size > 5000) for (const [k, v] of recent) if (v.every((t) => now - t > 60_000)) recent.delete(k);
}

export interface FeedbackInput {
  content: string;
  email?: string | null;
  pageUrl?: string | null;
  screenshot?: { mime: string; data: Buffer } | null;
  ip: string;
  userAgent: string;
}

export async function submitFeedback(input: FeedbackInput): Promise<{ id: number }> {
  const content = input.content.trim();
  if (content.length < 2) throw new FeedbackRejected(400, "invalid_request", "请写下反馈内容。");
  if (content.length > 5000) throw new FeedbackRejected(400, "invalid_request", "反馈内容最多 5000 字。");
  const email = input.email?.trim() || null;
  if (email && (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new FeedbackRejected(400, "invalid_request", "邮箱格式不正确。");
  const pageUrl = input.pageUrl?.trim().slice(0, 500) || null;
  const source = feedbackSourceHash(input.ip, input.userAgent);
  const [banned] = await sql`SELECT 1 FROM feedback_bans WHERE source_hash = ${source}`;
  if (banned) throw new FeedbackRejected(403, "forbidden", "暂时无法提交反馈。");
  rateLimit(source);

  let screenshotKey: string | null = null;
  if (input.screenshot) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(input.screenshot.mime)) throw new FeedbackRejected(400, "invalid_request", "截图需要是 PNG、JPG、WebP 或 GIF。");
    if (input.screenshot.data.length > 8 * 1024 * 1024) throw new FeedbackRejected(400, "invalid_request", "截图最大 8MB。");
    // The database keeps only an identifier; erasing the sender's material removes the file (admin/feedback.ts).
    const name = `${sha256(input.screenshot.data).slice(0, 24)}.${input.screenshot.mime.split("/")[1]}`;
    const dir = path.join(config.dataDir, "feedback-screenshots");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), input.screenshot.data);
    screenshotKey = `local:${name}`;
  }
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO feedback (content, email, page_url, screenshot_key, source_hash)
    VALUES (${content}, ${email}, ${pageUrl}, ${screenshotKey}, ${source}) RETURNING id`;
  return { id: row!.id };
}
