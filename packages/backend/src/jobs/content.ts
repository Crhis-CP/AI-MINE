import { applyPresentationRefresh } from "../admin/content-presentation.ts";
import { manualProcessingExclusions } from "@amp/backend/admin/content";
import { audit, previousAuditedCommand } from "../admin/auth.ts";
import { isModelRouteWaiting, modelRouteWaitSeconds } from "../providers/model-fallback.ts";
import { RuntimeControlPaused, RuntimeControlStale, runtimeControlSnapshot, assertRuntimeControl } from "../operations/lane-controls.ts";
// Content processing: body extraction when the source needs it → analysis → publish → event grouping.
// Every article reaches the queues through queueProcessing, which records when it was queued, so the
// safety net only picks up articles nothing is working on and sends those still waiting for a body to
// extraction first. A provider outage makes an article wait and retry with backoff; only a permanent
// refusal or exhausted retries end in "failed", which the admin re-queues in bulk. Paused paid calls and
// switched-off model calls only make it wait, without using up its attempts.
import { needsGeographyAnalysis } from "../editorial/geography.ts";
import type { PgBoss } from "pg-boss";
import { normalizeSourceLanguage } from "../sources/config-keys.ts";
import { sourceParticipants } from "../sources/participants.ts";
import { config, englishCopyEnabled, sourceCollectionEnabled } from "../config.ts";
import { sql, type Db } from "../db.ts";
import { extractArticleBody, pageFetchable } from "../content/extract.ts";
import { analyzeArticle, AnalysisInterruptedError, incompleteCopyJudgements } from "../editorial/analyze.ts";
import { isHistorical, readCurrentBody, resetMaterialProcessing } from "../content/materials.ts";
import { recordedMaterialWaits, readGroupingAnalysis } from "../enrichment/records.ts";
import { beginMaterialGrouping, EDITORIAL_RESUME_PENDING } from "../content/grouping.ts";
import { captureEventWithdrawal, removeAutomaticDateMembership } from "@amp/backend/events/group";
import {
  readSourceDateContext,
  readCurrentSourcePolicy,
  evaluateSourcePolicy,
  lockSourceCollectionActive,
  SourceCollectionPaused,
} from "@amp/backend/admin/sources";
import { bodyReadingKey } from "../content/body-reading-key.ts";
import { usableSourceText } from "../lib/text.ts";
import {
  publishArticle,
  prepareTranslationRun,
  articleWithdrawalHeld,
  publicationVisibilities,
  englishCopyCandidate,
  refreshEnglishCopy,
} from "../publication/publish.ts";
import { LIVE_TRANSLATION_DAYS, englishCopyDeferralOptions, translationDeferralOptions, translationPeakWait } from "../editorial/translation-schedule.ts";
import { writeEnglishCopy } from "../editorial/english-copy.ts";
import { readEnglishCopy } from "../enrichment/records.ts";
import { translationQuotaWait } from "../editorial/translation-quota.ts";
import { ACCOUNT_OUT_SQL, accountOutOfMoney } from "../providers/provider-errors.ts";
import { BudgetExceededError, ProviderRejectedError, ReceiptBusyError, ReceiptUnknownError } from "../providers/receipts.ts";
import { translateArticle } from "../editorial/translate.ts";
import { isChineseOriginal } from "../editorial/translation-readiness.ts";
import { ModelOutputError } from "../providers/llm.ts";
import { OFF_PEAK_WAIT, offPeakWait } from "../providers/peak-hours.ts";
import { articleMaterialTooShort, originalPostInputBlocked } from "../lib/original-post-admission.ts";
import {
  BODY_REREAD_BATCH,
  BODY_REREAD_DELAYS_MINUTES,
  BODY_REREAD_NOTE,
  bodyBackfilled,
  bodyRereadsInCycle,
  failUnreadableBody,
  recordBodyReread,
  settleShortBody,
} from "./body-reread.ts";
import { ensureQueue, QUEUES, shutdownSignal } from "./queue.ts";
import { enqueueJob as enqueue, work } from "./module-queues.ts";
import { SELECTION } from "@amp/industry/selection";

/** Minutes to wait after the n-th failed attempt; one more failure after the last ends in "failed". */
const RETRY_MINUTES = [5, 10, 20, 40, 60, 120, 240, 360];
/** Unusable model output is retried less: each retry is a paid call. */
const MAX_OUTPUT_FAILURES = 3;
/** Extraction gives up after this many errors and the article is judged on what it has. */
const MAX_EXTRACT_FAILURES = 3;
/**
 * Minutes before each rewrite of copy that came back without a usable Chinese title or summary (TASK-0594). Each is a
 * new paid writing request; the judging steps reuse their receipts. After the last, the article ends in "failed" with
 * its reason on the runs page, where the owner can queue it again (requeueFailed asks under the next number).
 */
const COPY_RETRY_MINUTES = [30, 180];
export const COPY_INCOMPLETE = "copy_incomplete";
/** While model calls are switched off, a waiting article looks again this often. */
const MODELS_OFF_WAIT_SECONDS = 3600;
/** How long an article waits before looking again while the model account is out of money (one refused call each time). */
export const ACCOUNT_WAIT_SECONDS = 600;
/** A queued article whose job left no trace for this long is queued again. */
const QUEUED_STALE = "30 minutes";

type Step = "extract" | "analyze";

interface Route {
  revision: number;
  originalPost: boolean;
  step: Step;
  /** Not an editorial source: no analysis; the post goes straight to event grouping as discussion evidence. */
  signal: boolean;
  historical: boolean;
  language: string | null;
  /** The source is on the news line; policy material never enters news processing. */
  news: boolean;
  lane: "news" | "policy";
}

/**
 * The article's next step: its body first while none is confirmed and the source asks for full text,
 * or when there is only a title or a feed summary (the analysis judges the whole article).
 */
async function route(articleId: string, db: Db): Promise<Route | null> {
  const [row] = await db<
    {
      revision: number;
      body_status: string;
      language: string | null;
      participation_mode: string;
      lane: "news" | "policy";
      kind: string;
      config: Record<string, unknown>;
      url: string;
      bare: boolean;
      backfill: boolean;
      published_at: Date | null;
      discovered_at: Date;
      original_post: boolean;
    }[]
  >`
    SELECT a.revision, a.body_status, a.language, s.participation_mode, s.lane, s.kind, s.config, a.url, coalesce(a.body_text, '') = '' AS bare,
           a.backfill, a.published_at, a.discovered_at, a.x_post IS NOT NULL AS original_post
    FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  if (!row) return null;
  const historical = isHistorical(row);
  const signal = row.participation_mode !== "editorial";
  const pending = row.body_status === "pending";
  const wantsBody = row.config.fetchPublicContent === true || !!row.config.detail || row.kind === "web_list";
  const needsPage = !row.original_post && !signal && (wantsBody || (row.bare && pageFetchable(row.url, row.kind)));
  return {
    revision: row.revision,
    originalPost: row.original_post,
    step: pending && needsPage ? "extract" : "analyze",
    signal,
    historical,
    language: normalizeSourceLanguage(row.language),
    news: row.lane === "news",
    lane: row.lane,
  };
}

/**
 * Queue order (pg-boss serves higher priority first): live work before history, so a new source's
 * first import or a backfill never holds up today's news; discussion evidence waits behind reports
 * in the serial grouping queue, history behind both.
 */
const PRIORITY = { live: 0, liveSignal: -1, history: -2 } as const;

/** Repairs use the same current material priority as first admission. */
export async function groupingQueuePriority(articleId: string, db: Db = sql): Promise<number> {
  const current = await route(articleId, db);
  return current?.historical ? PRIORITY.history : current?.signal ? PRIORITY.liveSignal : PRIORITY.live;
}

/**
 * The one way to hand an article to processing. `attemptTag` makes an explicit re-evaluation a new
 * (paid) request; the same tag reuses its receipt. With `db`, the job commits with the caller's write.
 * Posts of non-editorial sources skip the analysis queue: they only need recording and grouping.
 */
export async function queueProcessing(
  articleId: string,
  opts: { step?: Step; attemptTag?: string; db?: Db; lowPriority?: boolean; offPeak?: boolean; now?: Date } = {},
): Promise<string | null> {
  const db = opts.db ?? sql;
  const r = await route(articleId, db);
  if (!r) return null;
  // Material of a policy source is stored, never processed as news (ADR-0016): settled as skipped, like a post of a
  // non-editorial source, so no sweep, requeue or backlog alert takes it up and publication keeps it out.
  if (!r.news) {
    await db`UPDATE articles SET processing_state = 'skipped', processing_attempts = 0, processing_retry_at = NULL, processing_queued_at = NULL
      WHERE id = ${articleId} AND revision=${r.revision}`;
    return null;
  }
  if (!r.language) {
    await unidentifiedLanguage(articleId, r.revision, db);
    return null;
  }
  const step = r.originalPost ? "analyze" : (opts.step ?? r.step);
  const record = async (pending: Promise<string | null>) => {
    const jobId = await pending;
    if (jobId) await db`UPDATE articles SET processing_queued_at=now() WHERE id=${articleId} AND revision=${r.revision}`;
    return jobId;
  };
  if (step === "extract")
    return record(
      enqueue(
        QUEUES.extractBody,
        { lane: "news", articleId },
        { singletonKey: articleId, priority: opts.lowPriority || r.historical ? PRIORITY.history : PRIORITY.live },
        opts.db,
      ),
    );
  if (r.signal && !opts.attemptTag) {
    return record(
      enqueue(
        QUEUES.group,
        { lane: "news", articleId, signalOnly: true },
        { singletonKey: articleId, priority: opts.lowPriority || r.historical ? PRIORITY.history : PRIORITY.liveSignal },
        opts.db,
      ),
    );
  }
  const tagged = !!opts.attemptTag;
  // History (found long after it was published, or an old article the body backfill read again) can wait: at the
  // provider's peak hours its analysis starts at the next off-peak start (half price). The retry time keeps the safety
  // net from queueing it earlier.
  const offPeak = (r.historical || opts.offPeak) && !tagged ? offPeakWait(opts.now) : null;
  if (offPeak) await db`UPDATE articles SET processing_retry_at=${offPeak}, processing_error=${OFF_PEAK_WAIT} WHERE id=${articleId} AND revision=${r.revision}`;
  return record(
    enqueue(
      QUEUES.analyze,
      { ...(tagged ? { articleId, attemptTag: opts.attemptTag } : { articleId }), lane: "news" },
      {
        singletonKey: tagged ? `manual:analyze:${articleId}:${opts.attemptTag}` : articleId,
        priority: opts.lowPriority || r.historical ? PRIORITY.history : PRIORITY.live,
        ...(offPeak ? { startAfter: offPeak } : {}),
      },
      opts.db,
    ),
  );
}

async function unidentifiedLanguage(articleId: string, revision: number, db: Db = sql) {
  await db`UPDATE articles SET processing_state='failed',processing_error='language_unidentified: 来源语言未识别',
    processing_retry_at=NULL,processing_queued_at=NULL WHERE id=${articleId} AND revision=${revision}`;
}

/**
 * A post of a non-editorial source: recorded (hot_signal material only feeds heat; isolated material
 * never reaches public surfaces). Returns whether it is discussion evidence to group.
 */
export async function settleNonEditorial(articleId: string, expectedRevision?: number): Promise<{ group: boolean }> {
  const [row] = await sql<{ participation_mode: string; backfill: boolean; published_at: Date | null; discovered_at: Date }[]>`
    UPDATE articles a SET processing_state = 'skipped', processing_attempts = 0, processing_retry_at = NULL, processing_queued_at = NULL
    FROM sources s WHERE s.id = a.source_id AND a.id = ${articleId} AND s.participation_mode <> 'editorial' AND (${expectedRevision ?? null}::integer IS NULL OR a.revision=${expectedRevision ?? null})
    RETURNING s.participation_mode, a.backfill, a.published_at, a.discovered_at`;
  if (!row) return { group: false };
  await publishArticle(articleId);
  return { group: row.participation_mode === "hot_signal" && !isHistorical(row) };
}

/** Grouping spends model calls; capped noise below the floor (SELECTION.groupFloor) is not grouped. */
export function worthGrouping(output: { selected: boolean; score: number | null }): boolean {
  return output.selected || output.score === null || output.score >= SELECTION.groupFloor;
}

/** attemptTag makes an explicit re-evaluation a new (paid) request; the same tag reuses its receipt. */
export async function processArticle(articleId: string, opts: { attemptTag?: string; expectedRevision?: number } = {}): Promise<{ state: string }> {
  const [found] = await sql<
    {
      participation_mode: string;
      processing_state: string;
      revision: number;
      language: string | null;
      backfill: boolean;
      published_at: Date | null;
      discovered_at: Date;
    }[]
  >`
    SELECT s.participation_mode, a.processing_state, a.revision, a.language, a.backfill, a.published_at, a.discovered_at FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  if (!found) return { state: "missing" };
  if (opts.expectedRevision !== undefined && found.revision !== opts.expectedRevision) return { state: "stale" };
  if (!normalizeSourceLanguage(found.language)) {
    await unidentifiedLanguage(articleId, found.revision);
    await publishArticle(articleId);
    return { state: "unknown-language" };
  }
  const row = { ...found, historical: isHistorical(found) };
  if (row.participation_mode !== "editorial") {
    // Normally queued straight for grouping (queueProcessing); an explicit re-evaluation lands here.
    const { group } = await settleNonEditorial(articleId, found.revision);
    if (group) await enqueue(QUEUES.group, { lane: "news", articleId, signalOnly: true }, { singletonKey: articleId, priority: PRIORITY.liveSignal });
    return { state: "skipped" };
  }
  try {
    // A Chinese original is public on its excerpt once the prefilter has not blocked it (BR-ENR-06).
    const early = isChineseOriginal(normalizeSourceLanguage(found.language)) ? () => publishArticle(articleId) : undefined;
    const result = await analyzeArticle(articleId, { attemptTag: opts.attemptTag, expectedRevision: found.revision }, early);
    if (!result) return { state: "missing" };
    if (result.stale) return { state: "stale" }; // the newer revision has its own job
    // Only a title or a feed summary: the article page first; extraction queues the analysis again.
    if (result.needsBody || !result.output) {
      await queueProcessing(articleId, { step: "extract" });
      return { state: "fetching-body" };
    }
    const publication = await publishArticle(articleId);
    // Under 20 characters of material: nothing was paid. Its body is read again on a schedule; after the last read it
    // fails with its reason (Owner 2026-11-08, TASK-0598). It stays hidden from readers either way (no Chinese copy).
    if (result.awaitingBody) return { state: await settleShortBody(articleId, found.revision) };
    // History founds no event but may attach to the fact it reposts (events/group.ts); it waits behind live work.
    if (result.output.relevance === "pass" && publication?.visibility === "public" && worthGrouping(result.output))
      await enqueue(QUEUES.group, { lane: "news", articleId }, { singletonKey: articleId, priority: row.historical ? PRIORITY.history : PRIORITY.live });
    if (result.copyIncomplete) return copyRewrite(articleId, found.revision, result.copyAttempt ?? 0);
    return { state: result.output.relevance };
  } catch (error) {
    if (error instanceof AnalysisInterruptedError || shutdownSignal.signal.aborted) throw error;
    // A model outage or paused paid calls do not hold a Chinese original back; a BLOCK already given keeps it out.
    await publishArticle(articleId);
    if (error instanceof ReceiptUnknownError) {
      // The provider may have billed this request: stop. Requeueing alone meets the same unknown receipt; the
      // owner checks it and, once it is confirmed unbilled, releases it, which requeues the article (admin/runs.ts).
      const rows =
        await sql`UPDATE articles SET processing_state = 'failed', processing_error = ${`receipt ${error.receiptId} outcome unknown`} WHERE id = ${articleId} AND revision=${found.revision} RETURNING id`;
      return { state: rows.length ? "unknown-receipt" : "stale" };
    }
    throw error;
  }
}

/**
 * Copy a model wrote without a usable Chinese title or summary used to end the article as "analyzed": nothing judged
 * it again and it never reached readers (2026-11-08: about 517 items). It now waits and is written again (the safety
 * net queues it once its time has come), and after the last rewrite ends in "failed" with the reason shown.
 */
async function copyRewrite(articleId: string, revision: number, attempt: number): Promise<{ state: string; retryAt?: Date }> {
  const minutes = COPY_RETRY_MINUTES[attempt];
  if (minutes === undefined) {
    const rows = await sql`UPDATE articles SET processing_state='failed', processing_retry_at=NULL, processing_queued_at=NULL,
        processing_error=${`${COPY_INCOMPLETE}: 模型 ${attempt + 1} 次都没有写出完整的中文标题和导读`}
      WHERE id=${articleId} AND revision=${revision} AND processing_state='analyzed' RETURNING id`;
    return { state: rows.length ? "copy-failed" : "stale" };
  }
  const retryAt = new Date(Date.now() + minutes * 60_000);
  const rows = await sql`UPDATE articles SET processing_state='new', processing_retry_at=${retryAt}, processing_queued_at=NULL,
      processing_error=${`${COPY_INCOMPLETE}: 中文标题或导读为空，${minutes} 分钟后重写（第 ${attempt + 1} 次）`}
    WHERE id=${articleId} AND revision=${revision} AND processing_state='analyzed' RETURNING id`;
  return rows.length ? { state: "copy-retry", retryAt } : { state: "stale" };
}

/** Waits and retries for passing trouble; marks "failed" for refusals and exhausted retries. */
export async function afterFailure(articleId: string, error: unknown, expectedRevision: number): Promise<{ state: string; retryAt?: Date }> {
  // Let pg-boss retry this job after restart, reusing settled receipts. A deploy is not an article
  // failure and must neither consume processing_attempts nor turn an incomplete chain terminal.
  if (error instanceof AnalysisInterruptedError || shutdownSignal.signal.aborted) throw error;
  return sql.begin(async (tx) => {
    const [current] = await tx<
      { revision: number; processing_attempts: number }[]
    >`SELECT revision,processing_attempts FROM articles WHERE id=${articleId} FOR UPDATE`;
    if (!current) return { state: "missing" };
    if (current.revision !== expectedRevision) return { state: "stale" };
    const message = String(error instanceof Error ? error.message : error).slice(0, 500);
    if (
      isModelRouteWaiting(error) ||
      error instanceof RuntimeControlPaused ||
      error instanceof RuntimeControlStale ||
      error instanceof ReceiptBusyError ||
      error instanceof BudgetExceededError ||
      !config.modelCallsEnabled
    ) {
      // Not the article's fault: the same request is in flight, the budget window is full, or model calls are
      // switched off. A Chinese original stays public meanwhile and is judged once calls are back on.
      const seconds = isModelRouteWaiting(error)
        ? modelRouteWaitSeconds(error)
        : error instanceof BudgetExceededError
          ? error.retryAfterSeconds
          : error instanceof ReceiptBusyError || error instanceof RuntimeControlPaused || error instanceof RuntimeControlStale
            ? 60
            : MODELS_OFF_WAIT_SECONDS;
      const retryAt = new Date(Date.now() + seconds * 1000);
      await tx`UPDATE articles SET processing_state = 'new', processing_error = ${message}, processing_retry_at = ${retryAt}, processing_queued_at = NULL WHERE id = ${articleId}`;
      return { state: "waiting", retryAt };
    }
    if (accountOutOfMoney(message)) {
      // The model account has no money left (HTTP 402, “Insufficient Balance”): nothing is wrong with the article and
      // nothing will work until the Owner tops up. Wait and look again; attempts are not used up, so once the balance
      // is back the article is processed like any other, with no one having to requeue it (TASK-0630).
      const retryAt = new Date(Date.now() + ACCOUNT_WAIT_SECONDS * 1000);
      await tx`UPDATE articles SET processing_state = 'new', processing_error = ${message}, processing_retry_at = ${retryAt}, processing_queued_at = NULL WHERE id = ${articleId}`;
      return { state: "waiting", retryAt };
    }
    const attempts = current.processing_attempts + 1;
    const refused = error instanceof ProviderRejectedError && !error.retryable;
    const exhausted = attempts > RETRY_MINUTES.length || (error instanceof ModelOutputError && attempts >= MAX_OUTPUT_FAILURES);
    if (refused || exhausted) {
      await tx`UPDATE articles SET processing_state = 'failed', processing_error = ${message}, processing_attempts = ${attempts},
                processing_retry_at = NULL, processing_queued_at = NULL WHERE id = ${articleId}`;
      return { state: "failed" };
    }
    const retryAt = new Date(Date.now() + RETRY_MINUTES[attempts - 1]! * 60_000);
    await tx`UPDATE articles SET processing_state = 'new', processing_error = ${message}, processing_attempts = ${attempts},
              processing_retry_at = ${retryAt}, processing_queued_at = NULL WHERE id = ${articleId}`;
    return { state: "retrying", retryAt };
  }) as Promise<{ state: string; retryAt?: Date }>;
}

async function materialRevision(articleId: string): Promise<number | undefined> {
  return (await sql<{ revision: number }[]>`SELECT revision FROM articles WHERE id=${articleId}`)[0]?.revision;
}

/** Tests and replays pass the time to judge; the worker judges the wall clock (see offPeakWait). */
export type JobClock = { now?: () => Date };

/** Why a translation or English copy waits (TASK-0676): the off-peak price, the backlog quota share, or a paused lane. */
export type DeferralReason = "peak" | "quota" | "paused";

/**
 * A backlog translation picked up (or reaching a segment) in the provider's peak hours waits for the next off-peak
 * start in a new job on the same queue (TASK-0579); one held for model quota (TASK-0580) or by a paused lane waits the
 * same way until it judges again. The state keeps the name `deferred_peak` for every wait (it is the same deferral);
 * `reason` says which wait it was (TASK-0676). A queue that gives no acceptance throws, so pg-boss retries this job and
 * it judges again; a key already waiting for the same start already covers it.
 */
async function deferTranslation(articleId: string, until: Date, reason: DeferralReason) {
  const queued = await enqueue(QUEUES.translate, { articleId, lane: "news" }, translationDeferralOptions(articleId, until));
  if (queued === undefined) throw new Error("translation deferral was not accepted by the queue");
  return { state: "deferred_peak", reason, until: until.toISOString() };
}

/** The first wait that applies to work that does not go ahead now, with its reason; null to go ahead. */
async function backgroundWait(ahead: boolean, at?: Date, model?: string): Promise<{ until: Date; reason: DeferralReason } | null> {
  const peak = translationPeakWait(ahead, at);
  if (peak) return { until: peak, reason: "peak" };
  const quota = await translationQuotaWait(ahead, at, model);
  return quota ? { until: quota, reason: "quota" } : null;
}

/**
 * Whether an item goes ahead of the peak-hour and quota waits (TASK-0676, Owner 2026-11-13): any item found within the
 * live translation window, selected or not, so a new article's Chinese translation follows it within minutes. Older
 * items are backlog and still wait for the off-peak price and the quota share. Judged at each moment it is asked.
 * Republishing a source's history does not put its old items ahead, selected or not: freshness is by discovery time,
 * read from the database clock that records it (2026-11-07: six mid-October selected items once kept the hourly quota
 * full).
 */
export async function freshItem(articleId: string): Promise<boolean> {
  const [row] = await sql<{ fresh: boolean }[]>`
    SELECT discovered_at > now() - make_interval(days => ${LIVE_TRANSLATION_DAYS}) AS fresh FROM articles WHERE id = ${articleId}`;
  return row?.fresh === true;
}

/** A paused news lane: a translation or English-copy job looks again after this long, without using up its retries. */
const PAUSE_WAIT_MS = 30 * 60_000;

/** One content.translate job. Exported for tests; the worker registers it below. */
export async function runTranslationJob(data: { articleId: string }, clock: JobClock = {}) {
  const inputRevision = await materialRevision(data.articleId);
  if (inputRevision === undefined) return { state: "missing" };
  try {
    const prepared = await prepareTranslationRun(data.articleId);
    if (prepared === null) return { state: "not-needed-or-not-permitted" };
    // Judged when the job is taken, before any paid step (the quote, the body), and again before every paid segment.
    // A fresh item, selected or not, goes ahead of both waits (TASK-0676); older items are backlog: they wait for the
    // off-peak price and leave a quarter of the model quota to core steps (TASK-0579/0580).
    const consumed = await backgroundWait(await freshItem(data.articleId), clock.now?.());
    if (consumed) return await deferTranslation(data.articleId, consumed.until, consumed.reason);
    let segmentReason: DeferralReason = "peak";
    const beforePaidSegment = async (model: string) => {
      if (await freshItem(data.articleId)) return null;
      const wait = await backgroundWait(false, clock.now?.(), model);
      if (wait) segmentReason = wait.reason;
      return wait?.until ?? null;
    };
    const result = await translateArticle(data.articleId, prepared.revision, { beforePaidSegment });
    if (result.reason === "deferred_peak" && result.until) return await deferTranslation(data.articleId, result.until, segmentReason);
    if (result.status === "skipped" && ["no_post_text", "quote_not_permitted", "post_admission_disabled"].includes(result.reason ?? "")) {
      await publishArticle(data.articleId);
      return result;
    }
    if (result.reason === "attempts_exhausted") return result;
    if (result.status !== "translated" && ["text_limit", "pending_capacity"].includes(result.reason ?? "")) {
      await publishArticle(data.articleId);
      return result;
    }
    if (result.status !== "translated") throw new Error(result.reason ?? "translation remains incomplete");
    const publication = await publishArticle(data.articleId);
    const r = await route(data.articleId, sql);
    if (publication?.visibility === "public" && r)
      await enqueue(
        QUEUES.group,
        { lane: "news", articleId: data.articleId },
        { singletonKey: data.articleId, priority: r.historical ? PRIORITY.history : PRIORITY.live },
      );
    return result;
  } catch (error) {
    // A paused lane only postpones the translation. The article is already analysed: afterFailure would set it back
    // to "new" and the sweep would pay for its whole analysis again (TASK-0608).
    if (error instanceof RuntimeControlPaused || error instanceof RuntimeControlStale)
      return deferTranslation(data.articleId, new Date((clock.now?.() ?? new Date()).getTime() + PAUSE_WAIT_MS), "paused");
    throw error;
  }
}

/** An English-copy job that waits (peak hours, the background quota share, a paused lane) continues in a new job. */
async function deferEnglishCopy(articleId: string, until: Date, reason: DeferralReason) {
  const queued = await enqueue(QUEUES.translate, { articleId, lane: "news", english: true }, englishCopyDeferralOptions(articleId, until));
  if (queued === undefined) throw new Error("English copy deferral was not accepted by the queue");
  return { state: "deferred_peak", reason, until: until.toISOString() };
}

/**
 * One English title and summary (content.translate with `english`, TASK-0595). Nothing is paid unless EN_COPY_ENABLED
 * is the exact literal true. It waits like a background translation: through the provider's peak hours and while
 * background work has used its share of the model quota, unless the item is a fresh selection (TASK-0579/0580).
 * A copy that already exists for the current input is only shown, at no cost.
 */
export async function runEnglishCopyJob(data: { articleId: string }, clock: JobClock = {}) {
  if (!englishCopyEnabled()) return { state: "disabled" };
  try {
    const candidate = await englishCopyCandidate(data.articleId);
    if (!candidate) return { state: "not_needed" };
    if (!(await readEnglishCopy(data.articleId, candidate.input.hash))) {
      const wait = await backgroundWait(await freshItem(data.articleId), clock.now?.());
      if (wait) return await deferEnglishCopy(data.articleId, wait.until, wait.reason);
    }
    const outcome = await writeEnglishCopy(data.articleId);
    if (outcome === "written" || outcome === "ready") await refreshEnglishCopy(data.articleId);
    return { state: outcome };
  } catch (error) {
    if (error instanceof RuntimeControlPaused || error instanceof RuntimeControlStale)
      return deferEnglishCopy(data.articleId, new Date((clock.now?.() ?? new Date()).getTime() + PAUSE_WAIT_MS), "paused");
    throw error;
  }
}

/**
 * History's analysis is queued for the next off-peak start when it arrives in a peak hour (queueProcessing), but a
 * backlog or a retry can still pick the job up in a later peak hour. Judged again when the job is taken (TASK-0579):
 * it then waits like an article whose model calls are paused, through its retry time and the five-minute safety net,
 * which queues it again once that time has passed. Explicit re-evaluations (attemptTag) never wait.
 */
async function historicalAnalysisWait(articleId: string, revision: number, at?: Date): Promise<Date | null> {
  const until = offPeakWait(at);
  if (!until) return null;
  const r = await route(articleId, sql);
  if (!r || r.signal || r.revision !== revision || !(r.historical || (await bodyBackfilled(articleId)))) return null;
  const waiting = await sql`UPDATE articles SET processing_retry_at=${until}, processing_error=${OFF_PEAK_WAIT}, processing_queued_at=NULL
    WHERE id=${articleId} AND revision=${revision} AND processing_state='new'`;
  return waiting.count ? until : null;
}

/** One content.analyze job. Exported for tests; the worker registers it below. */
export async function runAnalysisJob(data: { articleId: string; attemptTag?: string }, clock: JobClock = {}) {
  const { articleId, attemptTag } = data;
  const inputRevision = await materialRevision(articleId);
  if (inputRevision === undefined) return { state: "missing" };
  try {
    const until = attemptTag ? null : await historicalAnalysisWait(articleId, inputRevision, clock.now?.());
    if (until) return { state: "deferred_peak", until: until.toISOString() };
    const result = await processArticle(articleId, { attemptTag, expectedRevision: inputRevision });
    // A scheduled body read keeps its due time; a rewrite keeps its own wait time (copyRewrite).
    if (result.state === "awaiting-body")
      await sql`UPDATE articles SET processing_attempts = 0, processing_queued_at = NULL WHERE id = ${articleId} AND revision=${inputRevision}`;
    else if (result.state !== "unknown-receipt" && result.state !== "copy-retry") {
      await sql`UPDATE articles SET processing_attempts = 0, processing_retry_at = NULL, processing_queued_at = NULL WHERE id = ${articleId} AND revision=${inputRevision}`;
    }
    return result;
  } catch (error) {
    return afterFailure(articleId, error, inputRevision);
  }
}

export async function registerContentJobs(boss: PgBoss, concurrency = Number(process.env.ANALYZE_CONCURRENCY || 6)) {
  await ensureQueue(QUEUES.translate);
  await work(boss, QUEUES.translate, { localConcurrency: concurrency, pollingIntervalSeconds: 2 }, articleJobLane, (data) =>
    data.english ? runEnglishCopyJob(data) : runTranslationJob(data),
  );
  await ensureQueue(QUEUES.analyze);
  await work(boss, QUEUES.analyze, { localConcurrency: concurrency, pollingIntervalSeconds: 2 }, articleJobLane, (data) => runAnalysisJob(data));
}

/** An old article the body backfill read again (TASK-0598) is history: its paid analysis waits behind live work and off-peak. */
async function analysisAfterRead(articleId: string): Promise<{ step: "analyze"; lowPriority?: boolean; offPeak?: boolean }> {
  return (await bodyBackfilled(articleId)) ? { step: "analyze", lowPriority: true, offPeak: true } : { step: "analyze" };
}

/**
 * Body extraction before analysis. Temporary failures are retried a few times; an oversized response
 * cannot succeed with the same limit, so it immediately continues on its excerpt ("unconfirmed" body).
 */
export async function registerExtractionJobs(boss: PgBoss) {
  await ensureQueue(QUEUES.extractBody);
  await work(boss, QUEUES.extractBody, { localConcurrency: 4, pollingIntervalSeconds: 2 }, articleJobLane, async (data) => {
    const { articleId } = data;
    if (data.presentation) {
      const command = data.presentation;
      try {
        if ((await readCurrentBody(articleId))?.x_post) throw new Error("原帖正文来自已保存的原帖材料，不能使用网页正文展示刷新");
        return await applyPresentationRefresh(
          articleId,
          { version: command.version, reason: command.reason },
          command.requestId,
          command.actor,
          data.crawlSessionId,
        );
      } catch (error) {
        if (error instanceof CrawlDeferred) {
          await enqueue(
            QUEUES.extractBody,
            { ...data, crawlSessionId: error.sessionId },
            { startAfter: error.retryAt, singletonKey: `presentation:${articleId}:${command.requestId}:${error.reservationId}:${error.retryAt.toISOString()}` },
          );
          return { state: "deferred", retryAt: error.retryAt.toISOString() };
        }
        const reason = error instanceof Error ? error.message.slice(0, 500) : "正文展示刷新失败，请重新预览后重试";
        await audit(
          command.actor,
          "content.rerun.presentation.failed",
          `content:${articleId}`,
          reason,
          null,
          { requestId: command.requestId, version: command.version },
          command.requestId,
        );
        return { state: "needs-preview", reason };
      }
    }
    const inputRevision = await materialRevision(articleId);
    if (inputRevision === undefined) return { state: "missing" };
    try {
      const state = await extractArticleBody(articleId, undefined, data.crawlSessionId, inputRevision);
      const current = await readCurrentBody(articleId);
      const stored = state === "ok" || state === "partial";
      if (!current || current.revision < inputRevision || current.revision > inputRevision + (stored ? 1 : 0)) return { state: "stale" };
      const resultRevision = current.revision;
      if (stored && resultRevision === inputRevision)
        await enqueue(QUEUES.republishSource, { lane: "news", sourceId: current.source_id }, { singletonKey: current.source_id });
      const changed = await sql`UPDATE articles SET processing_error = NULL, processing_retry_at = NULL, processing_queued_at = NULL
          WHERE id = ${articleId} AND revision=${resultRevision} AND processing_state = 'new' RETURNING id`;
      if (!changed.length) return { state: "stale-or-settled" };
      await queueProcessing(articleId, await analysisAfterRead(articleId));
      return { state };
    } catch (error) {
      if (error instanceof RuntimeControlPaused || error instanceof RuntimeControlStale) return afterFailure(articleId, error, inputRevision);
      if (error instanceof CrawlObsolete) return { state: "obsolete" };
      if (error instanceof CrawlDeferred) {
        const waiting = await recordExtractDeferral(articleId, error, inputRevision);
        if (waiting === "stale") return { state: "stale" };
        if (waiting === "unconfirmed") {
          await queueProcessing(articleId, await analysisAfterRead(articleId));
          return { state: "unconfirmed" };
        }
        await enqueue(
          QUEUES.extractBody,
          { lane: "news", articleId, crawlSessionId: error.sessionId },
          { startAfter: error.retryAt, singletonKey: `${articleId}:${error.reservationId}:${error.retryAt.toISOString()}` },
        );
        return { state: "deferred", retryAt: error.retryAt.toISOString() };
      }
      const message = String(error instanceof Error ? error.message : error).slice(0, 500);
      const oversized = error instanceof Error && error.message.startsWith("Response too large");
      const [a] = await sql<{ processing_attempts: number }[]>`
        UPDATE articles SET processing_attempts = processing_attempts + 1, processing_error = ${`extract: ${message}`},
          processing_queued_at = NULL, processing_retry_at = now() + interval '10 minutes'
        WHERE id = ${articleId} AND revision=${inputRevision} AND processing_state = 'new' RETURNING processing_attempts`;
      if (!a) return { state: "stale" };
      if (!oversized && a.processing_attempts < MAX_EXTRACT_FAILURES) return { state: "retrying" };
      const changed = await sql`UPDATE articles SET body_status = 'unconfirmed', processing_attempts = 0, processing_retry_at = NULL
          WHERE id = ${articleId} AND revision=${inputRevision} AND processing_state = 'new' AND body_status = 'pending' RETURNING id`;
      if (!changed.length) return { state: "stale-or-settled" };
      await queueProcessing(articleId, await analysisAfterRead(articleId));
      return { state: "unconfirmed" };
    }
  });
}

/**
 * Safety net: articles waiting for processing that no queue holds (crash between write and enqueue,
 * a lost job, a retry that came due). Articles already queued or running are left alone.
 */
let bodyResumeCursor = "";
/** Audit ids persist retries; this per-worker cursor only bounds metadata scans. */
async function resumeMaterialWaits(): Promise<number> {
  if (!sourceCollectionEnabled("news")) return 0;
  const control = await runtimeControlSnapshot("news", ["collection"]);
  if (control.paused) return 0;
  const waits = (await recordedMaterialWaits(sql)).sort((a, b) => (a.article_id < b.article_id ? -1 : a.article_id > b.article_id ? 1 : 0));
  const batch = [...waits.filter((w) => w.article_id > bodyResumeCursor), ...waits.filter((w) => w.article_id <= bodyResumeCursor)].slice(0, 500);
  let resumed = 0;
  for (const wait of batch) {
    bodyResumeCursor = wait.article_id;
    try {
      resumed += await sql.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout='2s'`;
        await tx`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
        await assertRuntimeControl(tx, control);
        const [identity] = await tx<{ source_id: string }[]>`SELECT source_id FROM articles WHERE id=${wait.article_id}`;
        if (!identity) return 0;
        await lockSourceCollectionActive(tx, identity.source_id);
        const source = await readSourceDateContext(identity.source_id, tx);
        if (source?.lane !== "news" || source.participation_mode !== "editorial") return 0;
        const [current] = await tx<
          {
            source_id: string;
            revision: number;
            url: string;
            language: string | null;
            body_text: string | null;
            excerpt: string | null;
            original_post: boolean;
          }[]
        >`
          SELECT source_id,revision,url,language,body_text,excerpt,x_post IS NOT NULL AS original_post FROM articles
          WHERE id=${wait.article_id} AND processing_state='analyzed' AND revision=${wait.input_revision} AND body_status<>'ok' FOR UPDATE`;
        if (
          !current ||
          current.source_id !== source.id ||
          (await manualProcessingExclusions([wait.article_id], tx)).length > 0 ||
          (current.original_post && originalPostInputBlocked({ text: current.body_text ?? "" })) ||
          !normalizeSourceLanguage(current.language) ||
          !pageFetchable(current.url, source.kind) ||
          (current.original_post
            ? usableSourceText(current.body_text) || usableSourceText(current.excerpt)
            : !articleMaterialTooShort(current.body_text, current.excerpt))
        )
          return 0;
        const permission = await readCurrentSourcePolicy(source.id, tx);
        if (!permission) return 0;
        for (const capability of ["fetch", "store_metadata", "process_locally", "store_fulltext"] as const) {
          const allowed = await evaluateSourcePolicy(
            {
              source_id: source.id,
              expected_permission_version: permission.permission_version,
              lane: "news",
              capability,
              resource: { url: current.url, document_type: source.config.policyProfile?.identity?.documentType?.value ?? null, attachment: false },
            },
            undefined,
            tx,
          );
          if (allowed.decision !== "allow") return 0;
        }
        if (!(await recordedMaterialWaits(tx, wait.article_id)).some((w) => w.input_revision === current.revision)) return 0;
        const requestId = bodyReadingKey({ id: wait.article_id, revision: current.revision, url: current.url }, source.config, permission.permission_version);
        const target = `content:${wait.article_id}`,
          action = "content.body-resume";
        if (await previousAuditedCommand("worker", "content.body-read", target, requestId, tx)) return 0;
        await resetMaterialProcessing(wait.article_id, true, tx);
        const jobId = await queueProcessing(wait.article_id, { step: "extract", lowPriority: true, db: tx });
        if (!(await previousAuditedCommand("worker", action, target, requestId, tx)))
          await audit("worker", action, target, "读取能力就绪后自动续接缺材料记录", null, { jobId, inputRevision: current.revision }, requestId, tx);
        return jobId ? 1 : 0;
      });
    } catch (error) {
      if (error instanceof SourceCollectionPaused) continue;
      if (error instanceof RuntimeControlPaused || error instanceof RuntimeControlStale) break;
      throw error;
    }
  }
  return resumed;
}

/** A scheduled read needs what a material resume needs: fetching, storing and processing the page under the current permission. */
async function rereadPermitted(tx: Db, source: NonNullable<Awaited<ReturnType<typeof readSourceDateContext>>>, url: string): Promise<boolean> {
  const permission = await readCurrentSourcePolicy(source.id, tx);
  if (!permission) return false;
  for (const capability of ["fetch", "store_metadata", "process_locally", "store_fulltext"] as const) {
    const allowed = await evaluateSourcePolicy(
      {
        source_id: source.id,
        expected_permission_version: permission.permission_version,
        lane: "news",
        capability,
        resource: { url, document_type: source.config.policyProfile?.identity?.documentType?.value ?? null, attachment: false },
      },
      undefined,
      tx,
    );
    if (allowed.decision !== "allow") return false;
  }
  return true;
}
/**
 * Scheduled body reads that came due (TASK-0598, jobs/body-reread.ts): each read is recorded, then queued at low
 * priority through ordinary extraction, so host pacing, robots and the source's permissions apply as on any first read.
 * An article whose page cannot be read again (not a fetchable page, or the source no longer permits it) fails now; one
 * whose source is paused waits an hour; one that left news processing stops waiting.
 */
async function resumeBodyRereads(): Promise<number> {
  if (!sourceCollectionEnabled("news")) return 0;
  const control = await runtimeControlSnapshot("news", ["collection"]);
  if (control.paused) return 0;
  const due = await sql<{ id: string }[]>`SELECT id FROM articles
    WHERE processing_state='analyzed' AND processing_error LIKE ${`${BODY_REREAD_NOTE}%`} AND processing_retry_at <= now()
    ORDER BY processing_retry_at, id LIMIT ${BODY_REREAD_BATCH}`;
  let queued = 0;
  for (const { id } of due) {
    try {
      queued += await sql.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout='2s'`;
        // Manual publication takes this fence before the material lock as well.
        await tx`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
        await assertRuntimeControl(tx, control);
        const [identity] = await tx<{ source_id: string }[]>`SELECT source_id FROM articles WHERE id=${id}`;
        if (!identity) return 0;
        await lockSourceCollectionActive(tx, identity.source_id);
        const source = await readSourceDateContext(identity.source_id, tx);
        const [current] = await tx<{ revision: number; url: string; body_text: string | null; excerpt: string | null }[]>`
          SELECT revision,url,body_text,excerpt FROM articles
          WHERE id=${id} AND source_id=${identity.source_id} AND processing_state='analyzed' AND x_post IS NULL
            AND processing_error LIKE ${`${BODY_REREAD_NOTE}%`} AND processing_retry_at <= now() FOR UPDATE`;
        if (!current) return 0;
        if (
          source?.lane !== "news" ||
          source.participation_mode !== "editorial" ||
          !articleMaterialTooShort(current.body_text, current.excerpt) ||
          (await manualProcessingExclusions([id], tx)).length
        ) {
          await tx`UPDATE articles SET processing_error=NULL,processing_retry_at=NULL WHERE id=${id} AND revision=${current.revision}`;
          return 0;
        }
        const article = { id, revision: current.revision, sourceName: source.name },
          rereads = await bodyRereadsInCycle(id, tx);
        const cause = !pageFetchable(current.url, source.kind) ? "unfetchable" : (await rereadPermitted(tx, source, current.url)) ? null : "not_permitted";
        if (cause || rereads >= BODY_REREAD_DELAYS_MINUTES.length) {
          await failUnreadableBody(tx, article, rereads, cause ?? undefined);
          return 0;
        }
        await recordBodyReread(tx, id, rereads + 1, current.revision);
        await resetMaterialProcessing(id, true, tx);
        return (await queueProcessing(id, { step: "extract", lowPriority: true, db: tx })) ? 1 : 0;
      });
    } catch (error) {
      if (error instanceof SourceCollectionPaused) {
        await sql`UPDATE articles SET processing_retry_at=now() + interval '1 hour'
          WHERE id=${id} AND processing_state='analyzed' AND processing_error LIKE ${`${BODY_REREAD_NOTE}%`}`;
        continue;
      }
      if (error instanceof RuntimeControlPaused || error instanceof RuntimeControlStale) break;
      throw error;
    }
  }
  return queued;
}

let editorialResumeCursor = "";
/** A real source edit records the intent; unchanged discoveries never authorize paid processing. */
async function resumeEditorialSources(): Promise<number> {
  if (!sourceCollectionEnabled("news") || !config.modelCallsEnabled) return 0;
  const control = await runtimeControlSnapshot("news", ["collection", "processing", "publication"]);
  if (control.paused) return 0;
  const pending = await sql<{ id: string; source_id: string }[]>`SELECT id,source_id FROM articles
    WHERE processing_state='skipped' AND processing_error=${EDITORIAL_RESUME_PENDING}
    ORDER BY (id>${editorialResumeCursor}) DESC,id LIMIT 500`;
  let resumed = 0;
  for (const candidate of pending) {
    editorialResumeCursor = candidate.id;
    try {
      resumed += await sql.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout='2s'`;
        await assertRuntimeControl(tx, control);
        await lockSourceCollectionActive(tx, candidate.source_id);
        const source = await readSourceDateContext(candidate.source_id, tx);
        if (source?.lane !== "news" || source.participation_mode !== "editorial") return 0;
        await tx`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
        const [material] = await tx<{ revision: number; url: string; language: string | null }[]>`SELECT revision,url,language FROM articles
          WHERE id=${candidate.id} AND source_id=${source.id} AND processing_state='skipped'
            AND processing_error=${EDITORIAL_RESUME_PENDING} FOR UPDATE`;
        if (!material || !normalizeSourceLanguage(material.language)) return 0;
        const dismiss = async () => {
          await tx`UPDATE articles SET processing_error=NULL WHERE id=${candidate.id} AND revision=${material.revision}
            AND processing_state='skipped' AND processing_error=${EDITORIAL_RESUME_PENDING}`;
          return 0;
        };
        const judgement = await readGroupingAnalysis(candidate.id, material.revision, tx);
        if (judgement?.relevance != null || (await manualProcessingExclusions([candidate.id], tx)).length) return dismiss();
        await captureEventWithdrawal(tx, candidate.id);
        if (await articleWithdrawalHeld(tx, candidate.id, null, null)) return dismiss();
        const permission = await readCurrentSourcePolicy(source.id, tx);
        if (!permission) return 0;
        for (const capability of ["process_locally", "external_model"] as const) {
          const allowed = await evaluateSourcePolicy(
            {
              source_id: source.id,
              expected_permission_version: permission.permission_version,
              lane: "news",
              capability,
              resource: { url: material.url, document_type: source.config.policyProfile?.identity?.documentType?.value ?? null, attachment: false },
            },
            undefined,
            tx,
          );
          if (allowed.decision !== "allow") return 0;
        }
        if ((await removeAutomaticDateMembership(candidate.id, tx)) === null) return dismiss();
        await beginMaterialGrouping(candidate.id, material.revision, true, tx);
        await resetMaterialProcessing(candidate.id, false, tx);
        const jobId = await queueProcessing(candidate.id, { lowPriority: true, db: tx });
        await audit(
          "worker",
          "content.editorial-resume",
          `content:${candidate.id}`,
          "来源用途已由负责人改为编辑，继续尚未判断的当前材料",
          null,
          { sourceId: source.id, revision: material.revision, jobId },
          undefined,
          tx,
        );
        return jobId ? 1 : 0;
      });
    } catch (error) {
      if (error instanceof SourceCollectionPaused) continue;
      if (error instanceof RuntimeControlPaused || error instanceof RuntimeControlStale) break;
      throw error;
    }
  }
  return resumed;
}

/**
 * Articles that were marked failed only because the model account was out of money, back into the queue (TASK-0630).
 * Since that change such a refusal waits instead of failing, so this finds the ones failed before it and any that
 * reach “failed” by another path. They wait ACCOUNT_WAIT_SECONDS like the others, so an empty account is asked once
 * per article per wait, not on every sweep. Fourteen days: older news is no longer worth a paid judgement.
 */
export async function reviveAccountFailures(): Promise<{ revived: number }> {
  const rows = await sql<{ id: string }[]>`
    UPDATE articles SET processing_state = 'new', processing_attempts = 0, processing_queued_at = NULL,
      processing_retry_at = now() + ${`${ACCOUNT_WAIT_SECONDS} seconds`}::interval
    WHERE processing_state = 'failed' AND discovered_at > now() - interval '14 days' AND processing_error ~* ${ACCOUNT_OUT_SQL}
    RETURNING id`;
  return { revived: rows.length };
}

export async function sweepUnprocessed(): Promise<{ enqueued: number }> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM articles
    WHERE processing_state = 'new' AND created_at < now() - interval '3 minutes'
      AND (processing_retry_at IS NULL OR processing_retry_at <= now())
      AND (processing_queued_at IS NULL OR processing_queued_at < now() - ${QUEUED_STALE}::interval)
    ORDER BY discovered_at DESC LIMIT 500`;
  for (const r of rows) await queueProcessing(r.id);
  await reviveAccountFailures();
  return { enqueued: rows.length + (await resumeMaterialWaits()) + (await resumeBodyRereads()) + (await resumeEditorialSources()) };
}

/**
 * A paced fetch can wait without failing the article. Keep that reason on the article, or the stuck-content
 * alert only sees a blank. Host pacing does not use up extraction attempts. A source-reader failure is not
 * pacing: it uses the same three tries as any other extract failure, then the article continues unconfirmed.
 * Persist the same deadline as its delayed job so the safety net cannot enqueue an earlier attempt.
 */
export async function recordExtractDeferral(articleId: string, error: CrawlDeferred, expectedRevision: number): Promise<"waiting" | "unconfirmed" | "stale"> {
  const revision = expectedRevision;
  const message = `extract: ${error.message}`.slice(0, 500);
  if (error.reason !== "source_reader_pending") {
    const changed = await sql`UPDATE articles SET processing_error = ${message}, processing_retry_at = ${error.retryAt}, processing_queued_at = NULL
        WHERE id = ${articleId} AND revision=${revision} AND processing_state = 'new' RETURNING id`;
    return changed.length ? "waiting" : "stale";
  }
  const [a] = await sql<{ processing_attempts: number }[]>`
    UPDATE articles SET processing_attempts = processing_attempts + 1, processing_error = ${message},
      processing_queued_at = NULL, processing_retry_at = ${error.retryAt}
    WHERE id = ${articleId} AND revision=${revision} AND processing_state = 'new' RETURNING processing_attempts`;
  if (!a) return "stale";
  if (a.processing_attempts < MAX_EXTRACT_FAILURES) return "waiting";
  const changed = await sql`UPDATE articles SET body_status = 'unconfirmed', processing_attempts = 0, processing_retry_at = NULL
    WHERE id = ${articleId} AND revision=${revision} AND body_status = 'pending' RETURNING id`;
  return changed.length ? "unconfirmed" : "stale";
}

/** How the runs page groups failures: the message with ids and numbers masked. */
export const failureGroupSql = () => sql`regexp_replace(left(coalesce(processing_error, '(no message)'), 120), '[0-9a-f]{8,}|[0-9]{4,}', '…', 'g')`;

/**
 * Admin: failed articles of the last 30 days back into processing, all or one failure group. The
 * first ones are queued now; the safety net picks up the rest within minutes.
 */
export async function requeueFailed(group: string | null): Promise<{ requeued: number }> {
  const rows = await sql<{ id: string }[]>`
    UPDATE articles SET processing_state = 'new', processing_attempts = 0, processing_retry_at = NULL, processing_error = NULL
    WHERE processing_state = 'failed' AND discovered_at > now() - interval '30 days'
      AND (${group}::text IS NULL OR ${failureGroupSql()} = ${group})
    RETURNING id`;
  for (const r of rows.slice(0, 500)) await queueProcessing(r.id);
  return { requeued: rows.length };
}

/** One item whose model copy came back incomplete before rewrites existed (TASK-0594); see scripts/resume-copy.ts. */
export interface IncompleteCopyCandidate {
  id: string;
  sourceId: string;
  language: string | null;
  title: string;
  writer: string;
  promptVersion: string | null;
  visibility: string | null;
}

/**
 * Editorial news items left "analyzed" with incomplete model copy on their current revision, paged by id. Read-only.
 * Items under a manual control are left out: a rewrite would pay for copy a person decides.
 */
export async function incompleteCopyCandidates(afterId: string | null, limit: number): Promise<IncompleteCopyCandidate[]> {
  // Each module reads its own records: analysed articles here; their sources, latest judgements and publications through
  // those modules. Pages of analysed articles are scanned in id order until `limit` items are found.
  const matched: Array<Omit<IncompleteCopyCandidate, "visibility">> = [];
  let cursor = afterId ?? "";
  while (matched.length < limit) {
    const articles = await sql<{ id: string; sourceId: string; language: string | null; title: string; revision: number }[]>`
      SELECT id, source_id AS "sourceId", language, title, revision FROM articles
      WHERE processing_state='analyzed' AND id > ${cursor} ORDER BY id LIMIT 500`;
    if (!articles.length) break;
    cursor = articles[articles.length - 1]!.id;
    const editorial = new Set(
      (await sourceParticipants([...new Set(articles.map((a) => a.sourceId))]))
        .filter((s) => s.lane === "news" && s.participation_mode === "editorial")
        .map((s) => s.id),
    );
    // Manual controls are excluded page by page, before counting toward `limit`: a page held entirely by operators
    // must not end the scan while later pages still have candidates (Codex review, TASK-0594).
    const held = new Set(
      await manualProcessingExclusions(
        articles.map((a) => a.id),
        sql,
      ),
    );
    const scoped = articles.filter((a) => editorial.has(a.sourceId) && !held.has(a.id));
    const judged = await incompleteCopyJudgements(scoped);
    for (const a of scoped) {
      const copy = judged.get(a.id);
      if (copy && matched.length < limit)
        matched.push({ id: a.id, sourceId: a.sourceId, language: a.language, title: a.title, writer: copy.writer, promptVersion: copy.promptVersion });
    }
  }
  if (!matched.length) return [];
  const ids = matched.map((r) => r.id);
  const visibility = await publicationVisibilities(ids);
  return matched.map((r) => ({ ...r, visibility: visibility.get(r.id) ?? null }));
}

/** Hands one such item back to processing at low priority; its next analysis asks the writer anew (incompleteCopies). */
export async function resumeIncompleteCopy(articleId: string): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [a] = await tx<{ revision: number }[]>`SELECT revision FROM articles WHERE id=${articleId} AND processing_state='analyzed' FOR UPDATE`;
    if (!a || (await manualProcessingExclusions([articleId], tx)).length) return false;
    await tx`UPDATE articles SET processing_state='new', processing_attempts=0, processing_retry_at=NULL, processing_queued_at=NULL,
      processing_error=${`${COPY_INCOMPLETE}: 补写此前没有写完的中文标题和导读`} WHERE id=${articleId} AND revision=${a.revision}`;
    // A job already held for this article (or none accepted) leaves it "new": the safety net queues it within minutes.
    await queueProcessing(articleId, { lowPriority: true, db: tx });
    return true;
  });
}

// Policy processing shares only this frozen composition entry; its queues and state remain separate.
export { registerPolicyJobs, sweepPolicyMaterials, policyQueues } from "./policy.ts";

/** Explicit low-priority preparation; dry-run is the default and no automatic paid sweep is enabled. */
export async function prepareGeographyBackfill(options: { limit?: number; enqueue?: boolean } = {}) {
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid geography backfill bound");
  const rows = await sql<
    { id: string; revision: number }[]
  >`SELECT id,revision FROM articles WHERE processing_state IN ('analyzed','published') AND processing_queued_at IS NULL ORDER BY discovered_at DESC,id LIMIT ${limit}`;
  const candidates: { id: string; revision: number }[] = [];
  let enqueued = 0;
  for (const row of rows) {
    const current = await route(row.id, sql);
    if (current?.news && !current.signal && (await needsGeographyAnalysis(row.id, row.revision))) candidates.push(row);
  }
  if (options.enqueue === true) for (const candidate of candidates) if (await queueProcessing(candidate.id, { step: "analyze", lowPriority: true })) enqueued++;
  return { candidates, enqueued };
}

export { registerModelConnectionProbeJobs, runModelConnectionProbe, sweepModelConnectionProbes } from "../providers/model-probe.ts";
import { CrawlDeferred, CrawlObsolete } from "../acquisition/crawl.ts";

/** Resolve legacy article jobs against their source before any processing or state write. */
export async function articleJobLane(data: { articleId: string }) {
  return (await route(data.articleId, sql))?.lane ?? null;
}
