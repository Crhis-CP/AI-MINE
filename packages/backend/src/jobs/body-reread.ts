// News articles whose material stays under 20 characters (Owner 2026-11-08, DEC-78补充·只抓到标题的资讯：重抓正文，抓不到不上,
// TASK-0598). The analysis buys no paid step for them (editorial/analyze.ts awaitsMaterial); here their body is read
// again up to three times with growing gaps, and an article still too short after the last read fails with a reason
// that names its source, so the runs page lists the failures per source and its diagnosis page can retry them.
// Readers never see these articles and never cause a read. The sweep that performs the reads is in jobs/content.ts
// (it needs the processing queue); this file holds the schedule, the settling of an analysis that waited, and the
// one-off backfill of the articles that were judged on a title before this rule (scripts/body-reread-backfill.ts).
import { sql, type Db, type Tx } from "../db.ts";
import { publishArticleTx } from "../publication/publish.ts";
import { audit, auditedCommandsSince, previousAuditedCommand } from "../admin/auth.ts";
import { manualProcessingExclusions } from "@amp/backend/admin/content";
import { readSourceDateContext } from "@amp/backend/admin/sources";
import { articleMaterialTooShort, LEGACY_SUMMARY_MIN_CHARS } from "../lib/original-post-admission.ts";
import { offPeakWait } from "../providers/peak-hours.ts";

/**
 * Minutes after a read that left the article short before the next read: 30 minutes (a passing outage, host pacing, a
 * page whose text is posted shortly after its title), 3 hours (a longer outage or cooling host), 12 hours (overnight
 * maintenance, attachments added the next working morning). Four reads in about 16 hours in all, so a host sees at
 * most three extra requests per article and a news item that turns readable still arrives within its news day.
 */
export const BODY_REREAD_DELAYS_MINUTES: readonly number[] = Object.freeze([30, 180, 720]);
/** The processing note of an article waiting for its next read; the sweep selects on this prefix. */
export const BODY_REREAD_NOTE = "body_retry:";
/** The failure reason prefix; the runs page groups failures by their reason. */
export const BODY_UNREADABLE = "body_unreadable:";
export const BODY_REREAD_ACTION = "content.body-reread";
export const BODY_UNREADABLE_ACTION = "content.body-unreadable";
export const BODY_BACKFILL_ACTION = "content.body-backfill";
/** Re-reads queued per five-minute sweep: background work behind live extraction (host pacing still applies). */
export const BODY_REREAD_BATCH = 50;

const subject = (articleId: string) => `content:${articleId}`;
const backfillRequest = (articleId: string) => `body-backfill:${articleId}`;

export const bodyRereadNote = (next: number) => `${BODY_REREAD_NOTE} 正文不足 ${LEGACY_SUMMARY_MIN_CHARS} 字，等待第 ${next} 次重读`;

export type UnreadableCause = "unfetchable" | "not_permitted";
/** The reason shown on the runs page: the reads made and the source, so failures group per source. */
export function bodyUnreadableReason(rereads: number, sourceName: string, cause?: UnreadableCause): string {
  const what = cause === "unfetchable" ? "来源页面不能重读" : cause === "not_permitted" ? "来源权限不允许重读" : `重读 ${rereads} 次`;
  return `${BODY_UNREADABLE} 正文读取失败（${what}）｜信源：${sourceName}`.slice(0, 500);
}

/** When the next read is due after `rereads` scheduled reads of this cycle, or null when none is left. */
export function nextBodyReread(rereads: number, now: Date): Date | null {
  const minutes = BODY_REREAD_DELAYS_MINUTES[rereads];
  return minutes === undefined ? null : new Date(now.getTime() + minutes * 60_000);
}

/** Scheduled reads since the article last failed as unreadable: a retry from its diagnosis page starts a new cycle. */
export const bodyRereadsInCycle = (articleId: string, db: Db = sql) =>
  auditedCommandsSince("worker", BODY_REREAD_ACTION, subject(articleId), BODY_UNREADABLE_ACTION, db);

/** Records one scheduled read (the caller queues it in the same transaction). */
export async function recordBodyReread(db: Db, articleId: string, attempt: number, inputRevision: number) {
  await audit(
    "worker",
    BODY_REREAD_ACTION,
    subject(articleId),
    `正文不足 ${LEGACY_SUMMARY_MIN_CHARS} 字，按计划重读`,
    null,
    { attempt, inputRevision },
    undefined,
    db,
  );
}

/** Ends the waiting and refreshes the public projection in the caller's publication-fenced transaction. */
export async function failUnreadableBody(
  db: Tx,
  article: { id: string; revision: number; sourceName: string },
  rereads: number,
  cause?: UnreadableCause,
): Promise<boolean> {
  const reason = bodyUnreadableReason(rereads, article.sourceName, cause);
  const rows = await db`UPDATE articles SET processing_state='failed',processing_error=${reason},processing_attempts=0,
      processing_retry_at=NULL,processing_queued_at=NULL
    WHERE id=${article.id} AND revision=${article.revision} AND processing_state='analyzed' RETURNING id`;
  if (!rows.length) return false;
  await audit(
    "worker",
    BODY_UNREADABLE_ACTION,
    subject(article.id),
    reason,
    null,
    { inputRevision: article.revision, rereads, cause: cause ?? null },
    undefined,
    db,
  );
  await publishArticleTx(db, article.id);
  return true;
}

/**
 * After an analysis committed an article as waiting for material: the next read is scheduled, or after the last one the
 * article fails. Returns the content job state.
 */
export async function settleShortBody(articleId: string, revision: number, now = new Date()): Promise<"awaiting-body" | "body-unreadable" | "stale"> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
    const [a] = await tx<{ source_id: string; body_text: string | null; excerpt: string | null }[]>`
      SELECT source_id,body_text,excerpt FROM articles
      WHERE id=${articleId} AND revision=${revision} AND processing_state='analyzed' AND x_post IS NULL FOR UPDATE`;
    if (!a || !articleMaterialTooShort(a.body_text, a.excerpt) || (await manualProcessingExclusions([articleId], tx)).length) return "stale";
    const rereads = await bodyRereadsInCycle(articleId, tx);
    const due = nextBodyReread(rereads, now);
    if (!due) {
      const source = await readSourceDateContext(a.source_id, tx);
      return (await failUnreadableBody(tx, { id: articleId, revision, sourceName: source?.name ?? a.source_id }, rereads)) ? "body-unreadable" : "stale";
    }
    await tx`UPDATE articles SET processing_error=${bodyRereadNote(rereads + 1)},processing_retry_at=${due} WHERE id=${articleId} AND revision=${revision}`;
    return "awaiting-body";
  });
}

/** The one-off backfill marked this article: its analysis after a successful read is history (low priority, off-peak). */
export async function bodyBackfilled(articleId: string, db: Db = sql): Promise<boolean> {
  return !!(await previousAuditedCommand("worker", BODY_BACKFILL_ACTION, subject(articleId), backfillRequest(articleId), db));
}

// ── One-off backfill (scripts/body-reread-backfill.ts) ──────────────────────────────────────────────────────────────

export interface BodyBackfillCandidate {
  id: string;
  sourceId: string;
  sourceName: string;
  revision: number;
}

/**
 * Analysed news articles of editorial sources still under 20 characters of material and not already waiting for a read,
 * one page in id order (the backfill is resumable: a marked article waits, fails or has material, so it leaves this set).
 * `skipped` counts candidates a person controls (manual withdrawal or revision stays first) or already backfilled once.
 */
export async function bodyBackfillCandidates(afterId: string | null, limit = 500) {
  const rows = await sql<{ id: string; source_id: string; revision: number; body_text: string | null; excerpt: string | null }[]>`
    SELECT id,source_id,revision,body_text,excerpt FROM articles
    WHERE processing_state='analyzed' AND x_post IS NULL
      AND (processing_error IS NULL OR processing_error NOT LIKE ${`${BODY_REREAD_NOTE}%`})
      AND (length(regexp_replace(coalesce(body_text,''),'\\s','','g'))<${LEGACY_SUMMARY_MIN_CHARS}
        OR length(regexp_replace(coalesce(excerpt,''),'\\s','','g'))<${LEGACY_SUMMARY_MIN_CHARS})
      AND id>${afterId ?? ""} ORDER BY id LIMIT ${limit}`;
  const sources = new Map<string, Awaited<ReturnType<typeof readSourceDateContext>>>();
  const short = [];
  for (const row of rows) {
    if (!articleMaterialTooShort(row.body_text, row.excerpt)) continue;
    if (!sources.has(row.source_id)) sources.set(row.source_id, await readSourceDateContext(row.source_id));
    const source = sources.get(row.source_id);
    if (source?.lane !== "news" || source.participation_mode !== "editorial") continue;
    short.push({ id: row.id, sourceId: row.source_id, sourceName: source.name, revision: row.revision });
  }
  const manual = new Set(
    await manualProcessingExclusions(
      short.map((c) => c.id),
      sql,
    ),
  );
  const candidates: BodyBackfillCandidate[] = [];
  let skipped = 0;
  for (const c of short) {
    if (manual.has(c.id) || (await bodyBackfilled(c.id))) skipped++;
    else candidates.push(c);
  }
  return { candidates, skipped, last: rows.at(-1)?.id ?? null };
}

/** Per source: whether articles found in the last 14 days have bodies, the dry run's sign that a read may now succeed. */
export async function recentlyReadableSources(sourceIds: string[]): Promise<Set<string>> {
  if (!sourceIds.length) return new Set();
  const rows = await sql<{ source_id: string }[]>`SELECT DISTINCT source_id FROM articles
    WHERE source_id=ANY(${sourceIds}::text[]) AND discovered_at > now() - interval '14 days'
      AND length(coalesce(body_text,'')) >= 200`;
  return new Set(rows.map((r) => r.source_id));
}

/**
 * Puts one candidate into the read schedule: its next read is due now (or at the next off-peak start during the
 * provider's peak hours), and the analysis after a successful read waits for off-peak hours behind live work. The read
 * itself is the sweep's ordinary scheduled read, with its host pacing, robots and source permission checks.
 */
export async function scheduleBodyBackfill(candidate: BodyBackfillCandidate, now?: Date): Promise<Date | null> {
  return sql.begin(async (tx) => {
    const [a] = await tx<{ body_text: string | null; excerpt: string | null; processing_error: string | null }[]>`
      SELECT body_text,excerpt,processing_error FROM articles
      WHERE id=${candidate.id} AND revision=${candidate.revision} AND processing_state='analyzed' AND x_post IS NULL FOR UPDATE`;
    if (!a || !articleMaterialTooShort(a.body_text, a.excerpt) || a.processing_error?.startsWith(BODY_REREAD_NOTE)) return null;
    if ((await manualProcessingExclusions([candidate.id], tx)).length || (await bodyBackfilled(candidate.id, tx))) return null;
    const due = offPeakWait(now) ?? now ?? new Date();
    const rereads = await bodyRereadsInCycle(candidate.id, tx);
    await tx`UPDATE articles SET processing_error=${bodyRereadNote(rereads + 1)},processing_retry_at=${due}
      WHERE id=${candidate.id} AND revision=${candidate.revision}`;
    await audit(
      "worker",
      BODY_BACKFILL_ACTION,
      subject(candidate.id),
      "一次性补读只有标题的资讯正文（TASK-0598）",
      null,
      { inputRevision: candidate.revision, dueAt: due.toISOString() },
      backfillRequest(candidate.id),
      tx,
    );
    return due;
  });
}

/**
 * Paid model requests one analysis can make, for the backfill estimate: the prefilter (1); unless it blocks, the scores
 * (up to 2), the structure (1), the writing (the content understanding, falling back to the title/summary prompt: up to
 * 2) and a wording fix (up to 1). Event grouping and the full-text translation of selected items come on top.
 */
export const ANALYSIS_CALLS = Object.freeze({ min: 1, max: 7 });

/** The paid estimate the backfill prints: a range, its assumption and what it leaves out (PIT-111). */
export function bodyBackfillEstimate(likely: number, all: number): string[] {
  const range = (n: number) => `${n} × ${ANALYSIS_CALLS.min}–${ANALYSIS_CALLS.max} = ${n * ANALYSIS_CALLS.min}–${n * ANALYSIS_CALLS.max} 次`;
  return [
    "补读本身不调用模型；补读后正文达到 20 字的稿件会重新分析（付费，非高峰时段排在实时内容之后）：",
    `  预计能读到正文：${likely} 条（所属信源近 14 天有读到正文的稿件），付费模型请求估算 ${range(likely)}`,
    `  上限：全部 ${all} 条都能读到，${range(all)}`,
    "  每条步骤：预筛 1；未被预筛拦下时再加评分最多 2、结构化 1、写作最多 2、措辞修正最多 1；事件归组与精选全文翻译另计",
    `仍不足 20 字的：再按 +${BODY_REREAD_DELAYS_MINUTES[1]! / 60} 小时、+${BODY_REREAD_DELAYS_MINUTES[2]! / 60} 小时各读一次，仍读不到就标为“正文读取失败”，在运行页按信源列出`,
  ];
}
