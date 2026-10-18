import { beijingDate, beijingMidnight, addDays } from "@amp/contracts/time";
import { sendAlert } from "../notify/deliver.ts";
// Feedback handling: list, status and note, per-source bans, and deletion on request
// (privacy notice: feedback material is removed once handling ends or when the sender asks).
import { unlink } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { feedbackSql as sql } from "../db.ts";
import { audit } from "./auth.ts";
import { Conflict } from "./sources.ts";

export const FEEDBACK_STATUSES = ["new", "triaged", "replied", "resolved", "spam", "archived"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export async function listFeedback(f: { status?: string; q?: string; page?: number; id?: string }) {
  const page = Math.max(1, f.page ?? 1);
  const q = f.q?.trim() ? `%${f.q.trim()}%` : null;
  const rows = await sql`
    SELECT fb.id, fb.content, fb.email, fb.page_url, split_part(fb.screenshot_key, ':', 1) AS screenshot, fb.source_hash, fb.status, fb.note,
           fb.created_at, fb.updated_at, fb.completed_at, fb.anonymized_at,
           EXISTS (SELECT 1 FROM feedback_bans b WHERE b.source_hash = fb.source_hash) AS banned,
           (SELECT count(*)::int FROM feedback o WHERE o.source_hash = fb.source_hash) AS from_source
    FROM feedback fb
    WHERE (${f.id ?? null}::text IS NULL OR fb.id::text=${f.id ?? null})
      AND (${f.status ?? null}::text IS NULL OR CASE fb.status WHEN 'triaged' THEN 'new' WHEN 'replied' THEN 'resolved' WHEN 'spam' THEN 'archived' ELSE fb.status END = ${f.status ?? null})
      AND (${q}::text IS NULL OR fb.content ILIKE ${q} OR fb.email ILIKE ${q} OR fb.page_url ILIKE ${q})
    ORDER BY fb.created_at DESC LIMIT 50 OFFSET ${(page - 1) * 50}`;
  const counts = await sql<{ status: string; n: number }[]>`SELECT status, count(*)::int AS n FROM feedback GROUP BY 1`;
  const bans = await sql`SELECT source_hash, reason, created_by, created_at FROM feedback_bans ORDER BY created_at DESC LIMIT 100`;
  const state = (s: string) => (s === "triaged" ? "new" : s === "replied" ? "resolved" : s === "spam" ? "archived" : s);
  const totals: Record<string, number> = {};
  for (const c of counts) totals[state(c.status)] = (totals[state(c.status)] ?? 0) + c.n;
  return { page, rows: rows.map((r) => ({ ...r, status: state(String(r.status)) })), counts: totals, bans, weeklySummary: await readWeeklyFeedbackSummary() };
}

export async function updateFeedback(id: number, input: { status?: string; note?: string | null; version: string }, actor: string) {
  if (input.status && !FEEDBACK_STATUSES.includes(input.status as FeedbackStatus)) throw new Error(`unknown status ${input.status}`);
  return sql.begin(async (tx) => {
    const [before] = await tx<
      { id: number; status: string; note: string | null; updated_at: Date; completed_at: Date | null }[]
    >`SELECT id, status, note, updated_at, completed_at FROM feedback WHERE id = ${id} FOR UPDATE`;
    if (!before) return null;
    if (before.updated_at.toISOString() !== input.version) throw new Conflict("这条反馈已被修改，请刷新后再操作");
    const [after] = await tx`
      UPDATE feedback SET completed_at=CASE
        WHEN coalesce(${input.status ?? null},status) IN ('resolved','spam','replied','archived')
          THEN coalesce(completed_at,now()) ELSE NULL END,
        status = coalesce(${input.status ?? null}, status), note = ${input.note === undefined ? before.note : input.note}, updated_at = now()
      WHERE id = ${id} RETURNING id, status, note, updated_at`;
    await audit(
      actor,
      "feedback.update",
      `feedback:${id}`,
      null,
      { status: before.status, note: before.note },
      { status: after!.status, note: after!.note },
      undefined,
      tx,
    );
    return after;
  });
}

/** Refuses further feedback from one source (an unreadable hash of IP and browser family). */
export async function banSource(sourceHash: string, reason: string, actor: string) {
  if (!reason.trim()) throw new Error("reason is required");
  await sql`INSERT INTO feedback_bans (source_hash, reason, created_by) VALUES (${sourceHash}, ${reason}, ${actor}) ON CONFLICT (source_hash) DO NOTHING`;
  await audit(actor, "feedback.ban", `feedback-source:${sourceHash}`, reason, null, null);
}

export async function unbanSource(sourceHash: string, actor: string) {
  const rows = await sql`DELETE FROM feedback_bans WHERE source_hash = ${sourceHash} RETURNING reason`;
  if (rows.length) await audit(actor, "feedback.unban", `feedback-source:${sourceHash}`, null, { reason: rows[0]!.reason }, null);
}

function screenshotPath(key: string | null): string | null {
  if (!key?.startsWith("local:")) return null;
  const name = key.slice("local:".length);
  return /^[\w.-]+$/.test(name) ? path.join(config.dataDir, "feedback-screenshots", name) : null;
}

export async function feedbackScreenshot(id: number): Promise<string | null> {
  const [row] = await sql<{ screenshot_key: string | null }[]>`SELECT screenshot_key FROM feedback WHERE id = ${id}`;
  return screenshotPath(row?.screenshot_key ?? null);
}

/** Removes the sender's material (text, email, page, screenshot) and keeps only the handling record. */
export async function eraseFeedback(id: number, reason: string, actor: string) {
  if (!reason.trim()) throw new Error("reason is required");
  const row = await sql.begin(async (tx) => {
    const [record] = await tx<{ screenshot_key: string | null }[]>`SELECT screenshot_key FROM feedback WHERE id=${id} FOR UPDATE`;
    if (!record) return null;
    await tx`UPDATE feedback SET content='（已按要求删除）',email=NULL,page_url=NULL,screenshot_key=NULL,
      forward_status='cancelled',forward_image_key=NULL,updated_at=now() WHERE id=${id}`;
    return record;
  });
  if (!row) return null;
  const file = screenshotPath(row.screenshot_key);
  const [referenced] = row.screenshot_key ? await sql`SELECT 1 FROM feedback WHERE screenshot_key=${row.screenshot_key} LIMIT 1` : [];
  if (file && !referenced) await unlink(file).catch(() => {});
  await audit(actor, "feedback.erase", `feedback:${id}`, reason, null, null);
  return { erased: true };
}

/** Clears only identifying attachments/contact details, preserving the feedback and handling history. */
export async function anonymizeExpiredFeedback(now = new Date()) {
  const cleaned = await sql.begin(async (tx) => {
    const rows = await tx<{ id: number; screenshot_key: string | null }[]>`SELECT id,screenshot_key FROM feedback
      WHERE completed_at IS NOT NULL AND completed_at <= ${now}::timestamptz - interval '180 days'
        AND status IN ('resolved','spam','replied','archived') AND anonymized_at IS NULL FOR UPDATE`;
    for (const row of rows) {
      if (row.screenshot_key) await tx`INSERT INTO feedback.feedback_private_deletions(screenshot_key) VALUES(${row.screenshot_key}) ON CONFLICT DO NOTHING`;
      await tx`UPDATE feedback SET email=NULL,screenshot_key=NULL,source_hash=NULL,forward_image_key=NULL,
        forward_status=CASE WHEN forwarded_at IS NULL THEN 'cancelled' ELSE forward_status END,
        content=regexp_replace(regexp_replace(content,'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}','[联系方式已移除]','g'),
          '([+]?[0-9][0-9 ()-]{7,}[0-9])','[联系方式已移除]','g'),
        page_url=split_part(split_part(page_url,'?',1),'#',1),anonymized_at=${now},updated_at=${now} WHERE id=${row.id}`;
      await audit("system", "feedback.anonymize", `feedback:${row.id}`, null, null, { at: now.toISOString() }, undefined, tx);
    }
    return rows.length;
  });
  const queued = await sql<{ screenshot_key: string }[]>`SELECT screenshot_key FROM feedback.feedback_private_deletions ORDER BY queued_at LIMIT 100`;
  for (const row of queued) {
    const [used] = await sql`SELECT 1 FROM feedback WHERE screenshot_key=${row.screenshot_key} LIMIT 1`;
    if (used) continue;
    const file = screenshotPath(row.screenshot_key);
    if (file)
      await unlink(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    await sql`DELETE FROM feedback.feedback_private_deletions WHERE screenshot_key=${row.screenshot_key}`;
  }
  return { cleaned };
}

/** Beijing calendar week; deterministic counts never include reader prose, contacts or screenshots. */
export async function weeklyFeedbackSummary(now = new Date()) {
  const today = beijingDate(now);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const week = addDays(today, -((weekday + 6) % 7));
  const bounds = { week, start: beijingMidnight(week), end: beijingMidnight(addDays(week, 7)) };
  const [counts, statuses, pages, oldest] = await Promise.all([
    sql<{ total: number; correction: number; technical: number }[]>`SELECT count(*)::int AS total,
      count(*) FILTER(WHERE content ~ '(错字|翻译|错误|事实|更正)')::int AS correction,
      count(*) FILTER(WHERE content ~ '(打不开|报错|无法|加载|故障)')::int AS technical
      FROM feedback WHERE created_at>=${bounds.start} AND created_at<${bounds.end}`,
    sql<
      { status: string; count: number }[]
    >`SELECT status,count(*)::int AS count FROM feedback WHERE created_at>=${bounds.start} AND created_at<${bounds.end} GROUP BY status ORDER BY status`,
    sql<
      { page: string; count: number }[]
    >`SELECT regexp_replace(split_part(split_part(page_url,'?',1),'#',1),'^https?://[^/]+','') AS page,count(*)::int AS count
      FROM feedback WHERE created_at>=${bounds.start} AND created_at<${bounds.end} AND page_url IS NOT NULL GROUP BY page ORDER BY count DESC,page LIMIT 20`,
    sql<{ id: number; created_at: Date }[]>`SELECT id,created_at FROM feedback WHERE status IN ('new','triaged') ORDER BY created_at,id LIMIT 10`,
  ]);
  const summary = {
    week: bounds.week,
    total: counts[0]!.total,
    types: { correction: counts[0]!.correction, technical: counts[0]!.technical },
    statuses,
    pages: pages.map((row) => ({
      count: Number(row.count),
      page: /^\/(?:all|about|feedback|sources|daily|weekly|monthly|hot|policy|items|stories|topics|policies)(?:\/[A-Za-z0-9_-]+)*\/?$/.test(String(row.page))
        ? row.page
        : "其他页面",
    })),
    oldest,
    url: "/admin/feedback",
  };
  await sql`INSERT INTO feedback.feedback_weekly_summaries(week_start,summary) VALUES(${bounds.week},${sql.json(summary as never)})
    ON CONFLICT(week_start) DO UPDATE SET summary=EXCLUDED.summary,generated_at=now()`;
  return summary;
}

export async function readWeeklyFeedbackSummary() {
  const [row] = await sql`SELECT summary,generated_at FROM feedback.feedback_weekly_summaries ORDER BY week_start DESC LIMIT 1`;
  return row ?? null;
}

/** Retries failed/disabled delivery and serialises concurrent runs without exposing reader content. */
export async function sendWeeklyFeedbackSummary(now = new Date(), send: typeof sendAlert = sendAlert) {
  const summary = await weeklyFeedbackSummary(now);
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`feedback-week:${summary.week}`}))`;
    const [current] = await tx`SELECT sent_at FROM feedback.feedback_weekly_summaries WHERE week_start=${summary.week} FOR UPDATE`;
    if (current?.sent_at) return { ...summary, delivery: "already_sent" };
    const outcome = await send(`反馈周汇总 · ${summary.week}`, [
      `本周收到 ${summary.total} 条反馈；事实或翻译更正 ${summary.types.correction} 条；功能故障 ${summary.types.technical} 条。`,
      `处理状态：${summary.statuses.map((row) => `${row.status} ${row.count}`).join("；")}`,
      `页面频次：${summary.pages.map((row) => `${row.page} ${row.count}`).join("；") || "无"}`,
      `${config.siteUrl.replace(/\/$/, "")}/admin/feedback`,
    ]);
    if (outcome === "sent") await tx`UPDATE feedback.feedback_weekly_summaries SET sent_at=now() WHERE week_start=${summary.week}`;
    return { ...summary, delivery: outcome };
  });
}
