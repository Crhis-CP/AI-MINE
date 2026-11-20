// The per-article shadow (package 2, design L PR-E): after a news judgement is committed, the worker runs the checks
// of checks.ts on it and stores what they found, the links in entities.article_links (through the entity library's
// store) and the rest in enrichment.analysis_checks with mode "observed". No model is called; analyses, articles and
// publications are only read, so nothing a reader sees changes. The content job only queues the work, after the
// judgement's transaction has committed, and a failure to queue it is logged and swallowed: the shadow can neither
// fail, hold up nor roll back the article it observes. The work runs in a queue of its own, one article at a time;
// a failed run is retried twice and then stays failed in pg-boss, which the runs page and the daily reconciliation count.
// The article is loaded with the analysis's own loader (editorial/input.ts), which reads the whole stored page, as the
// judgement itself did; the checks then read only what the judging steps were shown (checks.ts).
// Switch: the settings key observe.articles (owned by enrichment). Absent means on; the value "off" stops both the
// queueing and the queued work within a minute (docs/runbooks/article-observe.md).
import { z } from "zod";
import { type Db, sql, withCustomPlans } from "../../db.ts";
import { loadAnalyzeInput } from "../../editorial/input.ts";
import { enqueueOn } from "../../jobs/module-queues.ts";
import { defineQueue } from "../../modules.ts";
import { loadEntityIndex, replaceArticleLinks } from "../entities/store.ts";
import { ARTICLE_CHECK_RECIPE, type ArticleCheck, checkArticle } from "./checks.ts";
import type { DatelineKind } from "./dateline.ts";

const SWITCH_SETTING = "observe.articles";
/** How long a read of the switch is trusted: turning it off takes effect within this time, without a restart. */
const SWITCH_MAX_AGE_MS = 60_000;
let switchRead: { at: number; on: boolean } | null = null;

/**
 * Whether the shadow runs: on unless settings holds observe.articles = "off" (false is read the same way). The answer is
 * kept for up to a minute; `maxAgeMs: 0` reads the setting now.
 */
export async function articleObserveEnabled(opts: { maxAgeMs?: number; now?: number } = {}): Promise<boolean> {
  const now = opts.now ?? Date.now();
  if (switchRead && now - switchRead.at < (opts.maxAgeMs ?? SWITCH_MAX_AGE_MS) && now >= switchRead.at) return switchRead.on;
  const [row] = await sql<{ value: unknown }[]>`SELECT value FROM settings WHERE key = ${SWITCH_SETTING}`;
  const on = !row || (row.value !== "off" && row.value !== false);
  switchRead = { at: now, on };
  return on;
}

type ObserveJob = { lane: "news"; articleId: string; analysisId: number; language: string | null };
const Payload = z
  .object({ lane: z.literal("news"), articleId: z.string().min(1), analysisId: z.number().int().positive(), language: z.string().min(1).nullable() })
  .strict();

export type SkipReason = "missing" | "not_judged" | "superseded" | "stale";
export type ObserveOutcome =
  | { state: "skipped"; reason: SkipReason }
  | { state: "observed"; check: ArticleCheck; library: "database" | "code_seed"; stored: { check: boolean; links: number } | null };

/**
 * Runs the checks on one committed judgement and, with `write` (the default), stores them. Only a checkable judgement
 * is checked: complete (it carries the scores, even when there were none to give), past the prefilter (a waiting post
 * with no material has no prefilter answer) and not a BLOCK; the early scope row is none. Skipped too when a newer
 * judgement of the same revision exists (it has its own run) or the article has moved to a newer revision. The check
 * row is written once per judgement (a repeat keeps the first); the links of the revision are replaced, so a run after
 * the library grew refreshes them. Both writes share one transaction of their own, never the judgement's.
 */
export async function observeAnalysis(
  job: { articleId: string; analysisId: number; language: string | null },
  opts: { write?: boolean } = {},
): Promise<ObserveOutcome> {
  const [row] = await sql<
    {
      article_id: string;
      input_revision: number;
      relevance: string | null;
      subjects: string[] | null;
      title_zh: string | null;
      summary_zh: string | null;
      reason_zh: string | null;
      writer: string | null;
      occurred_at: string | null;
      geography: unknown;
      checkable: boolean;
      superseded: boolean;
    }[]
  >`
    SELECT a.article_id, a.input_revision, a.relevance, a.subjects, a.title_zh, a.summary_zh, a.reason_zh, a.output->>'writer' AS writer,
      a.output->'fact'->>'occurredAt' AS occurred_at, a.output->'geography' AS geography,
      coalesce(a.output ? 'scores' AND jsonb_typeof(a.output->'prefilter') = 'object' AND a.relevance IS DISTINCT FROM 'block', false) AS checkable,
      EXISTS (SELECT 1 FROM analyses n WHERE n.article_id = a.article_id AND n.input_revision = a.input_revision AND n.id > a.id) AS superseded
    FROM analyses a WHERE a.id = ${job.analysisId}`;
  if (!row || row.article_id !== job.articleId) return { state: "skipped", reason: "missing" };
  if (!row.checkable) return { state: "skipped", reason: "not_judged" };
  if (row.superseded) return { state: "skipped", reason: "superseded" };
  const article = await loadAnalyzeInput(job.articleId);
  if (!article) return { state: "skipped", reason: "missing" };
  if (article.revision !== row.input_revision) return { state: "skipped", reason: "stale" };
  const { index, source } = await loadEntityIndex();
  const check = await checkArticle(index, article, job.language, {
    subjects: row.subjects ?? [],
    titleZh: row.title_zh,
    summaryZh: row.summary_zh,
    reasonZh: row.reason_zh,
    writer: row.writer,
    occurredAt: row.occurred_at,
    geography: row.geography,
  });
  if (opts.write === false) return { state: "observed", check, library: source, stored: null };
  const stored = await sql.begin(async (tx) => {
    const inserted = await tx`
      INSERT INTO enrichment.analysis_checks (analysis_id, article_id, input_revision, lane, recipe, mode, verdict, figures, names, geography)
      VALUES (${job.analysisId}, ${job.articleId}, ${row.input_revision}, 'news', ${ARTICLE_CHECK_RECIPE}, 'observed', ${check.verdict},
        ${tx.json(check.figures as never)}, ${tx.json(check.names as never)}, ${tx.json(check.geography as never)})
      ON CONFLICT (analysis_id) DO NOTHING RETURNING analysis_id`;
    const links = await replaceArticleLinks(
      tx,
      { articleId: job.articleId, revision: row.input_revision, lane: "news", analysisId: job.analysisId },
      check.links,
    );
    return { check: inserted.length > 0, links };
  });
  return { state: "observed", check, library: source, stored };
}

/** The shadow's own queue: one article at a time, polled every few seconds, beside (never inside) the analysis queue. */
export const observeQueue = defineQueue<ObserveJob>({
  name: "news.enrichment.observe",
  options: { policy: "short", retryLimit: 2, retryDelay: 60, expireInSeconds: 300 },
  worker: { localConcurrency: 1, pollingIntervalSeconds: 5, batchSize: 1 },
  async run([job]) {
    if (!job) return;
    const data = Payload.parse(job);
    try {
      if (!(await articleObserveEnabled())) return { state: "off" };
      const outcome = await observeAnalysis(data);
      return outcome.state === "skipped"
        ? outcome
        : { state: outcome.state, library: outcome.library, verdict: outcome.check.verdict, links: outcome.check.links.length, stored: outcome.stored };
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          msg: "article observe failed",
          articleId: data.articleId,
          analysisId: data.analysisId,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
        }),
      );
      throw error;
    }
  },
});

/**
 * Called by the content job once a judgement is committed. Never throws, and waits on no more than the switch (read at
 * most once a minute) and one small insert: with the switch off nothing is queued, and any failure is logged and
 * dropped, because the article must not be held up or failed by its shadow.
 */
export async function queueArticleObserve(job: { articleId: string; analysisId: number; language: string | null }): Promise<void> {
  try {
    if (!(await articleObserveEnabled())) return;
    await enqueueOn(observeQueue, { lane: "news", ...job }, { singletonKey: `analysis:${job.analysisId}` });
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "article observe not queued",
        articleId: job.articleId,
        analysisId: job.analysisId,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      }),
    );
  }
}

export interface ArticleCheckSummary {
  /** Articles with a checkable judgement made in the window (complete, past the prefilter, not a BLOCK). */
  judged: number;
  /** Those of them with a check, each with the revision of its latest checked judgement there. */
  articles: Array<{ articleId: string; revision: number }>;
  /** Soft figure findings of those latest checks, and how many articles have one. The hard class is not summed here. */
  softFlags: number;
  softArticles: number;
  /** Datelines found at the top of those articles, by who issued the text. */
  datelines: Record<DatelineKind, number>;
}

/** A judgement is written in a transaction of seconds; an hour on either side covers any order its id and time take. */
const ID_MARGIN_MS = 3_600_000;

/**
 * The analysis ids that can have been written in [since, until): after `after` and up to `last`. Ids grow with time,
 * and each end is found by walking the primary key back from the newest row until a row older than the end's margin,
 * so it reads only the rows written since then, never the whole table (analyses.created_at has no index).
 */
export async function analysisIdRange(since: Date, until: Date, db: Db = sql): Promise<{ after: number; last: number }> {
  const [row] = await db<{ after: number; last: number }[]>`
    SELECT coalesce((SELECT id FROM analyses WHERE created_at < ${new Date(since.getTime() - ID_MARGIN_MS)} ORDER BY id DESC LIMIT 1), 0)::bigint AS after,
      coalesce((SELECT id FROM analyses WHERE created_at < ${new Date(until.getTime() + ID_MARGIN_MS)} ORDER BY id DESC LIMIT 1), 0)::bigint AS last`;
  return { after: Number(row?.after ?? 0), last: Number(row?.last ?? 0) };
}

/**
 * For the daily reconciliation: the articles with a checkable judgement made in [start, end), and the latest check of
 * each that has one. A check written later for an older judgement (the back-fill) is not that day's; one written just
 * after midnight for a judgement of the day before is. The judgements are read by id from just before `start`, so the
 * read is bounded by the rows written since then, with plans made for the actual bounds.
 */
export async function articleCheckSummary(start: Date, end: Date): Promise<ArticleCheckSummary> {
  const rows = await withCustomPlans(async (db) => {
    const ids = await analysisIdRange(start, end, db);
    return db<{ article_id: string; checked: boolean; input_revision: number | null; figures: unknown; geography: unknown }[]>`
      SELECT a.article_id, c.analysis_id IS NOT NULL AS checked, c.input_revision, c.figures, c.geography
      FROM analyses a LEFT JOIN enrichment.analysis_checks c ON c.analysis_id = a.id
      WHERE a.id > ${ids.after} AND a.id <= ${ids.last} AND a.created_at >= ${start} AND a.created_at < ${end}
        AND a.output ? 'scores' AND jsonb_typeof(a.output->'prefilter') = 'object' AND a.relevance IS DISTINCT FROM 'block'
      ORDER BY a.article_id, a.id DESC`;
  });
  const summary: ArticleCheckSummary = {
    judged: 0,
    articles: [],
    softFlags: 0,
    softArticles: 0,
    datelines: { release_wire: 0, news_agency: 0, unmarked: 0 },
  };
  const list = (value: unknown) => (Array.isArray(value) ? (value as Array<Record<string, unknown> | null>) : []);
  const judged = new Set<string>(),
    counted = new Set<string>();
  for (const row of rows) {
    judged.add(row.article_id);
    // Rows come newest first within an article: the first checked one is its latest check.
    if (!row.checked || counted.has(row.article_id)) continue;
    counted.add(row.article_id);
    summary.articles.push({ articleId: row.article_id, revision: row.input_revision! });
    const soft = list(row.figures).filter((finding) => finding?.class === "soft").length;
    summary.softFlags += soft;
    if (soft) summary.softArticles++;
    const kind = list(row.geography).find((note) => note?.kind === "dateline")?.dateline;
    if (kind === "release_wire" || kind === "news_agency" || kind === "unmarked") summary.datelines[kind]++;
  }
  summary.judged = judged.size;
  return summary;
}

/** Check rows are kept this long (the migration's promise); the daily retention job deletes older ones. */
export const CHECK_RETENTION_DAYS = 180;

export async function pruneAnalysisChecks(now = new Date(), db: Db = sql): Promise<number> {
  const deleted = await db`DELETE FROM enrichment.analysis_checks WHERE created_at < ${new Date(now.getTime() - CHECK_RETENTION_DAYS * 86_400_000)}`;
  return deleted.count;
}

/**
 * The back-fill's pages (scripts/entity-links-backfill.ts): checkable judgements made in [since, until) that are still
 * the latest of their article, by id after `afterId` and up to `lastId` (take both from analysisIdRange once), so each
 * page reads its own stretch of the primary key and no more. Older judgements are left out: readers see the latest one,
 * and a check of an older revision would be skipped as stale anyway.
 */
export async function observableAnalyses(
  range: { since: Date; until: Date; afterId: number; lastId: number; limit: number },
  db: Db = sql,
): Promise<Array<{ analysisId: number; articleId: string }>> {
  const rows = await db<{ id: number; article_id: string }[]>`
    SELECT a.id, a.article_id FROM analyses a
    WHERE a.id > ${range.afterId} AND a.id <= ${range.lastId} AND a.created_at >= ${range.since} AND a.created_at < ${range.until}
      AND a.output ? 'scores' AND jsonb_typeof(a.output->'prefilter') = 'object' AND a.relevance IS DISTINCT FROM 'block'
      AND NOT EXISTS (SELECT 1 FROM analyses n WHERE n.article_id = a.article_id
        AND (n.input_revision > a.input_revision OR (n.input_revision = a.input_revision AND n.id > a.id)))
    ORDER BY a.id LIMIT ${range.limit}`;
  return rows.map((r) => ({ analysisId: r.id, articleId: r.article_id }));
}
