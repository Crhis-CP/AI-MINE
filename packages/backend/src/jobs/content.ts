import { RuntimeControlPaused, RuntimeControlStale } from "../operations/lane-controls.ts";
// Content processing: body extraction when the source needs it → analysis → publish → event grouping.
// Every article reaches the queues through queueProcessing, which records when it was queued, so the
// safety net only picks up articles nothing is working on and sends those still waiting for a body to
// extraction first. A provider outage makes an article wait and retry with backoff; only a permanent
// refusal or exhausted retries end in "failed", which the admin re-queues in bulk. Paused paid calls and
// switched-off model calls only make it wait, without using up its attempts.
import { needsGeographyAnalysis } from "../editorial/geography.ts";
import type { PgBoss } from "pg-boss";
import { normalizeSourceLanguage } from "../sources/config-keys.ts";
import { config } from "../config.ts";
import { dbOf, type Db } from "../db.ts";
import { extractArticleBody, pageFetchable } from "../content/extract.ts";
import { analyzeArticle, AnalysisInterruptedError } from "../editorial/analyze.ts";
import { isHistorical } from "../content/materials.ts";
import { publishArticle, prepareTranslation } from "../publication/publish.ts";
import { BudgetExceededError, ProviderRejectedError, ReceiptBusyError, ReceiptUnknownError } from "../providers/receipts.ts";
import { translateArticle } from "../editorial/translate.ts";
import { isChineseOriginal } from "../editorial/translation-readiness.ts";
import { ModelOutputError } from "../providers/llm.ts";
import { ensureQueue, enqueue, QUEUES, shutdownSignal } from "./queue.ts";

const sql = dbOf("content");

/** Minutes to wait after the n-th failed attempt; one more failure after the last ends in "failed". */
const RETRY_MINUTES = [5, 10, 20, 40, 60, 120, 240, 360];
/** Unusable model output is retried less: each retry is a paid call. */
const MAX_OUTPUT_FAILURES = 3;
/** Extraction gives up after this many errors and the article is judged on what it has. */
const MAX_EXTRACT_FAILURES = 3;
/** While model calls are switched off, a waiting article looks again this often. */
const MODELS_OFF_WAIT_SECONDS = 3600;
/** A queued article whose job left no trace for this long is queued again. */
const QUEUED_STALE = "30 minutes";

type Step = "extract" | "analyze";

interface Route {
  step: Step;
  /** Not an editorial source: no analysis; the post goes straight to event grouping as discussion evidence. */
  signal: boolean;
  historical: boolean;
  language: string | null;
  /** The source is on the news line; policy material never enters news processing. */
  news: boolean;
}

/**
 * The article's next step: its body first while none is confirmed and the source asks for full text,
 * or when there is only a title or a feed summary (the analysis judges the whole article).
 */
async function route(articleId: string, db: Db): Promise<Route | null> {
  const [row] = await db<
    {
      body_status: string;
      language: string | null;
      participation_mode: string;
      lane: string;
      kind: string;
      config: Record<string, unknown>;
      url: string;
      bare: boolean;
      backfill: boolean;
      published_at: Date | null;
      discovered_at: Date;
    }[]
  >`
    SELECT a.body_status, a.language, s.participation_mode, s.lane, s.kind, s.config, a.url, coalesce(a.body_text, '') = '' AS bare,
           a.backfill, a.published_at, a.discovered_at
    FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  if (!row) return null;
  const historical = isHistorical(row);
  const signal = row.participation_mode !== "editorial";
  const pending = row.body_status === "pending";
  const wantsBody = row.config.fetchPublicContent === true || !!row.config.detail || row.kind === "web_list";
  const needsPage = !signal && (wantsBody || (row.bare && pageFetchable(row.url, row.kind)));
  return { step: pending && needsPage ? "extract" : "analyze", signal, historical, language: normalizeSourceLanguage(row.language), news: row.lane === "news" };
}

/**
 * Queue order (pg-boss serves higher priority first): live work before history, so a new source's
 * first import or a backfill never holds up today's news; discussion evidence waits behind reports
 * in the serial grouping queue, history behind both.
 */
const PRIORITY = { live: 0, liveSignal: -1, history: -2 } as const;

/**
 * The one way to hand an article to processing. `attemptTag` makes an explicit re-evaluation a new
 * (paid) request; the same tag reuses its receipt. With `db`, the job commits with the caller's write.
 * Posts of non-editorial sources skip the analysis queue: they only need recording and grouping.
 */
export async function queueProcessing(
  articleId: string,
  opts: { step?: Step; attemptTag?: string; db?: Db; lowPriority?: boolean } = {},
): Promise<string | null> {
  const db = opts.db ?? sql;
  const r = await route(articleId, db);
  if (!r) return null;
  // Material of a policy source is stored, never processed as news (ADR-0016): settled as skipped, like a post of a
  // non-editorial source, so no sweep, requeue or backlog alert takes it up and publication keeps it out.
  if (!r.news) {
    await db`UPDATE articles SET processing_state = 'skipped', processing_attempts = 0, processing_retry_at = NULL, processing_queued_at = NULL
      WHERE id = ${articleId}`;
    return null;
  }
  if (!r.language) {
    await unidentifiedLanguage(articleId, db);
    return null;
  }
  const step = opts.step ?? r.step;
  await db`UPDATE articles SET processing_queued_at = now() WHERE id = ${articleId}`;
  if (step === "extract")
    return enqueue(
      QUEUES.extractBody,
      { articleId },
      { singletonKey: articleId, priority: opts.lowPriority || r.historical ? PRIORITY.history : PRIORITY.live },
      opts.db,
    );
  if (r.signal && !opts.attemptTag) {
    return enqueue(
      QUEUES.group,
      { articleId, signalOnly: true },
      { singletonKey: articleId, priority: opts.lowPriority || r.historical ? PRIORITY.history : PRIORITY.liveSignal },
      opts.db,
    );
  }
  const tagged = !!opts.attemptTag;
  return enqueue(
    QUEUES.analyze,
    tagged ? { articleId, attemptTag: opts.attemptTag } : { articleId },
    {
      singletonKey: tagged ? `manual:analyze:${articleId}:${opts.attemptTag}` : articleId,
      priority: opts.lowPriority || r.historical ? PRIORITY.history : PRIORITY.live,
    },
    opts.db,
  );
}

async function unidentifiedLanguage(articleId: string, db: Db = sql) {
  await db`UPDATE articles SET processing_state='failed',processing_error='language_unidentified: 来源语言未识别',
    processing_retry_at=NULL,processing_queued_at=NULL WHERE id=${articleId}`;
}

/**
 * A post of a non-editorial source: recorded (hot_signal material only feeds heat; isolated material
 * never reaches public surfaces). Returns whether it is discussion evidence to group.
 */
export async function settleNonEditorial(articleId: string): Promise<{ group: boolean }> {
  const [row] = await sql<{ participation_mode: string; backfill: boolean; published_at: Date | null; discovered_at: Date }[]>`
    UPDATE articles a SET processing_state = 'skipped', processing_attempts = 0, processing_retry_at = NULL, processing_queued_at = NULL
    FROM sources s WHERE s.id = a.source_id AND a.id = ${articleId} AND s.participation_mode <> 'editorial'
    RETURNING s.participation_mode, a.backfill, a.published_at, a.discovered_at`;
  if (!row) return { group: false };
  await publishArticle(articleId);
  return { group: row.participation_mode === "hot_signal" && !isHistorical(row) };
}

/** attemptTag makes an explicit re-evaluation a new (paid) request; the same tag reuses its receipt. */
export async function processArticle(articleId: string, opts: { attemptTag?: string } = {}): Promise<{ state: string }> {
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
  if (!normalizeSourceLanguage(found.language)) {
    await unidentifiedLanguage(articleId);
    await publishArticle(articleId);
    return { state: "unknown-language" };
  }
  const row = { ...found, historical: isHistorical(found) };
  if (row.participation_mode !== "editorial") {
    // Normally queued straight for grouping (queueProcessing); an explicit re-evaluation lands here.
    const { group } = await settleNonEditorial(articleId);
    if (group) await enqueue(QUEUES.group, { articleId, signalOnly: true }, { singletonKey: articleId, priority: PRIORITY.liveSignal });
    return { state: "skipped" };
  }
  try {
    // A Chinese original is public on its excerpt once the prefilter has not blocked it (BR-ENR-06).
    const early = isChineseOriginal(normalizeSourceLanguage(found.language)) ? () => publishArticle(articleId) : undefined;
    const result = await analyzeArticle(articleId, { attemptTag: opts.attemptTag }, early);
    if (!result) return { state: "missing" };
    // Only a title or a feed summary: the article page first; extraction queues the analysis again.
    if (result.needsBody || !result.output) {
      await queueProcessing(articleId, { step: "extract" });
      return { state: "fetching-body" };
    }
    if (result.stale) return { state: "stale" }; // the newer revision has its own job
    const publication = await publishArticle(articleId);
    // History is archived but founds no event (isHistorical).
    if (result.output.relevance === "pass" && publication?.visibility === "public" && !row.historical)
      await enqueue(QUEUES.group, { articleId }, { singletonKey: articleId, priority: PRIORITY.live });
    return { state: result.output.relevance };
  } catch (error) {
    if (error instanceof AnalysisInterruptedError || shutdownSignal.signal.aborted) throw error;
    // A model outage or paused paid calls do not hold a Chinese original back; a BLOCK already given keeps it out.
    await publishArticle(articleId);
    if (error instanceof ReceiptUnknownError) {
      // The provider may have billed this request: stop. Requeueing alone meets the same unknown receipt; the
      // owner checks it and, once it is confirmed unbilled, releases it, which requeues the article (admin/runs.ts).
      await sql`UPDATE articles SET processing_state = 'failed', processing_error = ${`receipt ${error.receiptId} outcome unknown`} WHERE id = ${articleId}`;
      return { state: "unknown-receipt" };
    }
    throw error;
  }
}

/** Waits and retries for passing trouble; marks "failed" for refusals and exhausted retries. */
export async function afterFailure(articleId: string, error: unknown): Promise<{ state: string; retryAt?: Date }> {
  // Let pg-boss retry this job after restart, reusing settled receipts. A deploy is not an article
  // failure and must neither consume processing_attempts nor turn an incomplete chain terminal.
  if (error instanceof AnalysisInterruptedError || shutdownSignal.signal.aborted) throw error;
  const message = String(error instanceof Error ? error.message : error).slice(0, 500);
  if (
    error instanceof RuntimeControlPaused ||
    error instanceof RuntimeControlStale ||
    error instanceof ReceiptBusyError ||
    error instanceof BudgetExceededError ||
    !config.modelCallsEnabled
  ) {
    // Not the article's fault: the same request is in flight, the budget window is full, or model calls are
    // switched off. A Chinese original stays public meanwhile and is judged once calls are back on.
    const seconds =
      error instanceof BudgetExceededError
        ? error.retryAfterSeconds
        : error instanceof ReceiptBusyError || error instanceof RuntimeControlPaused || error instanceof RuntimeControlStale
          ? 60
          : MODELS_OFF_WAIT_SECONDS;
    const retryAt = new Date(Date.now() + seconds * 1000);
    await sql`UPDATE articles SET processing_state = 'new', processing_error = ${message}, processing_retry_at = ${retryAt}, processing_queued_at = NULL WHERE id = ${articleId}`;
    return { state: "waiting", retryAt };
  }
  const [a] = await sql<{ processing_attempts: number }[]>`SELECT processing_attempts FROM articles WHERE id = ${articleId}`;
  const attempts = (a?.processing_attempts ?? 0) + 1;
  const refused = error instanceof ProviderRejectedError && !error.retryable;
  const exhausted = attempts > RETRY_MINUTES.length || (error instanceof ModelOutputError && attempts >= MAX_OUTPUT_FAILURES);
  if (refused || exhausted) {
    await sql`UPDATE articles SET processing_state = 'failed', processing_error = ${message}, processing_attempts = ${attempts},
                processing_retry_at = NULL, processing_queued_at = NULL WHERE id = ${articleId}`;
    return { state: "failed" };
  }
  const retryAt = new Date(Date.now() + RETRY_MINUTES[attempts - 1]! * 60_000);
  await sql`UPDATE articles SET processing_state = 'new', processing_error = ${message}, processing_attempts = ${attempts},
              processing_retry_at = ${retryAt}, processing_queued_at = NULL WHERE id = ${articleId}`;
  return { state: "retrying", retryAt };
}

export async function registerContentJobs(boss: PgBoss, concurrency = Number(process.env.ANALYZE_CONCURRENCY || 6)) {
  await ensureQueue(QUEUES.translate);
  await boss.work<{ articleId: string }>(QUEUES.translate, { localConcurrency: concurrency, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (!job) return;
    try {
      const revision = await prepareTranslation(job.data.articleId);
      if (revision === null) return { state: "not-needed-or-not-permitted" };
      const result = await translateArticle(job.data.articleId, revision);
      if (result.status !== "translated") throw new Error(result.reason ?? "translation remains incomplete");
      const publication = await publishArticle(job.data.articleId);
      const r = await route(job.data.articleId, sql);
      if (publication?.visibility === "public" && r && !r.historical)
        await enqueue(QUEUES.group, { articleId: job.data.articleId }, { singletonKey: job.data.articleId, priority: PRIORITY.live });
      return result;
    } catch (error) {
      if (error instanceof RuntimeControlPaused || error instanceof RuntimeControlStale) return afterFailure(job.data.articleId, error);
      throw error;
    }
  });
  await ensureQueue(QUEUES.analyze);
  await boss.work<{ articleId: string; attemptTag?: string }>(QUEUES.analyze, { localConcurrency: concurrency, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (!job) return;
    const { articleId, attemptTag } = job.data;
    try {
      const result = await processArticle(articleId, { attemptTag });
      if (result.state !== "unknown-receipt") {
        await sql`UPDATE articles SET processing_attempts = 0, processing_retry_at = NULL, processing_queued_at = NULL WHERE id = ${articleId}`;
      }
      return result;
    } catch (error) {
      return afterFailure(articleId, error);
    }
  });
}

/**
 * Body extraction before analysis. Failures are retried a few times; after that the article is judged
 * on the excerpt it has ("unconfirmed" body, never a wrong one).
 */
export async function registerExtractionJobs(boss: PgBoss) {
  await ensureQueue(QUEUES.extractBody);
  await boss.work<{ articleId: string; crawlSessionId?: string }>(QUEUES.extractBody, { localConcurrency: 4, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (!job) return;
    const { articleId } = job.data;
    try {
      const state = await extractArticleBody(articleId, undefined, job.data.crawlSessionId);
      await queueProcessing(articleId, { step: "analyze" });
      return { state };
    } catch (error) {
      if (error instanceof RuntimeControlPaused || error instanceof RuntimeControlStale) return afterFailure(articleId, error);
      if (error instanceof CrawlObsolete) return { state: "obsolete" };
      if (error instanceof CrawlDeferred) {
        await enqueue(
          QUEUES.extractBody,
          { articleId, crawlSessionId: error.sessionId },
          { startAfter: error.retryAt, singletonKey: `${articleId}:${error.reservationId}:${error.retryAt.toISOString()}` },
        );
        return { state: "deferred", retryAt: error.retryAt.toISOString() };
      }
      const message = String(error instanceof Error ? error.message : error).slice(0, 500);
      const [a] = await sql<{ processing_attempts: number }[]>`
        UPDATE articles SET processing_attempts = processing_attempts + 1, processing_error = ${`extract: ${message}`},
          processing_queued_at = NULL, processing_retry_at = now() + interval '10 minutes'
        WHERE id = ${articleId} RETURNING processing_attempts`;
      if ((a?.processing_attempts ?? MAX_EXTRACT_FAILURES) < MAX_EXTRACT_FAILURES) return { state: "retrying" };
      await sql`UPDATE articles SET body_status = 'unconfirmed', processing_attempts = 0, processing_retry_at = NULL WHERE id = ${articleId} AND body_status = 'pending'`;
      await queueProcessing(articleId, { step: "analyze" });
      return { state: "unconfirmed" };
    }
  });
}

/**
 * Safety net: articles waiting for processing that no queue holds (crash between write and enqueue,
 * a lost job, a retry that came due). Articles already queued or running are left alone.
 */
export async function sweepUnprocessed(): Promise<{ enqueued: number }> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM articles
    WHERE processing_state = 'new' AND created_at < now() - interval '3 minutes'
      AND (processing_retry_at IS NULL OR processing_retry_at <= now())
      AND (processing_queued_at IS NULL OR processing_queued_at < now() - ${QUEUED_STALE}::interval)
    ORDER BY discovered_at DESC LIMIT 500`;
  for (const r of rows) await queueProcessing(r.id);
  return { enqueued: rows.length };
}

/** How the runs page groups failures: the message with ids and numbers masked. */
export const failureGroupSql = sql`regexp_replace(left(coalesce(processing_error, '(no message)'), 120), '[0-9a-f]{8,}|[0-9]{4,}', '…', 'g')`;

/**
 * Admin: failed articles of the last 30 days back into processing, all or one failure group. The
 * first ones are queued now; the safety net picks up the rest within minutes.
 */
export async function requeueFailed(group: string | null): Promise<{ requeued: number }> {
  const rows = await sql<{ id: string }[]>`
    UPDATE articles SET processing_state = 'new', processing_attempts = 0, processing_retry_at = NULL, processing_error = NULL
    WHERE processing_state = 'failed' AND discovered_at > now() - interval '30 days'
      AND (${group}::text IS NULL OR ${failureGroupSql} = ${group})
    RETURNING id`;
  for (const r of rows.slice(0, 500)) await queueProcessing(r.id);
  return { requeued: rows.length };
}

// Policy processing shares only this frozen composition entry; its queues and state remain separate.
export { registerPolicyJobs, sweepPolicyMaterials } from "./policy.ts";

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

export { registerModelConnectionProbeJobs, runModelConnectionProbe } from "../providers/model-probe.ts";
import { CrawlDeferred, CrawlObsolete } from "../acquisition/crawl.ts";
