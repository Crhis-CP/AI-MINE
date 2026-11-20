// The per-article shadow (package 2, design L PR-E): after a news judgement is committed, the worker runs the checks
// of checks.ts on it and stores what they found, the links in entities.article_links (through the entity library's
// store) and the rest in enrichment.analysis_checks with mode "observed". No model is called; analyses, articles and
// publications are only read, so nothing a reader sees changes. The content job only queues the work, after the
// judgement's transaction has committed, and a failure to queue it is logged and swallowed: the shadow can neither
// fail, hold up nor roll back the article it observes. The work runs in a queue of its own, one article at a time;
// a failed run is retried twice and then stays failed in pg-boss, which the runs page counts.
// Switch: the settings key observe.articles (owned by enrichment). Absent means on; the value "off" stops both the
// queueing and the queued work within a minute (docs/runbooks/article-observe.md).
import { z } from "zod";
import { type Db, sql } from "../../db.ts";
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
 * Runs the checks on one committed judgement and, with `write` (the default), stores them. Skipped when the row is
 * gone or is no complete relevant judgement (a prefilter BLOCK, the early scope row), when a newer judgement of the same
 * revision exists (it has its own run), or when the article has moved to a newer revision. The check row is written
 * once per judgement (a repeat keeps the first); the links of the revision are replaced, so a run after the library
 * grew refreshes them. Both writes share one transaction of their own, never the judgement's.
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
      complete: boolean;
      superseded: boolean;
    }[]
  >`
    SELECT a.article_id, a.input_revision, a.relevance, a.subjects, a.title_zh, a.summary_zh, a.reason_zh, a.output->>'writer' AS writer,
      a.output->'fact'->>'occurredAt' AS occurred_at, a.output->'geography' AS geography, coalesce(a.output ? 'scores', false) AS complete,
      EXISTS (SELECT 1 FROM analyses n WHERE n.article_id = a.article_id AND n.input_revision = a.input_revision AND n.id > a.id) AS superseded
    FROM analyses a WHERE a.id = ${job.analysisId}`;
  if (!row || row.article_id !== job.articleId) return { state: "skipped", reason: "missing" };
  if (!row.complete || row.relevance === "block") return { state: "skipped", reason: "not_judged" };
  if (row.superseded) return { state: "skipped", reason: "superseded" };
  const article = await loadAnalyzeInput(job.articleId);
  if (!article) return { state: "skipped", reason: "missing" };
  if (article.revision !== row.input_revision) return { state: "skipped", reason: "stale" };
  const { index, source } = await loadEntityIndex();
  const check = checkArticle(index, article, job.language, {
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
  /** Each article judged in the window that has a check, with the revision of its latest one. */
  articles: Array<{ articleId: string; revision: number }>;
  /** Soft figure findings of those latest checks, and how many articles have one. The hard class is not summed here. */
  softFlags: number;
  softArticles: number;
  /** Datelines found at the top of those articles, by who issued the text. */
  datelines: Record<DatelineKind, number>;
}

/**
 * For the daily reconciliation: the checks of the judgements made in [start, end), the latest one per article. A check
 * written later for an older judgement (the back-fill) is not that day's, and one written just after midnight for a
 * judgement of the day before is. Read through the check rows' created_at index from `start` on (a check is never older
 * than its judgement), each joined to its judgement by id: bounded by the checks written since then.
 */
export async function articleCheckSummary(start: Date, end: Date, db: Db = sql): Promise<ArticleCheckSummary> {
  const rows = await db<{ article_id: string; input_revision: number; figures: unknown; geography: unknown }[]>`
    SELECT DISTINCT ON (c.article_id) c.article_id, c.input_revision, c.figures, c.geography
    FROM enrichment.analysis_checks c JOIN analyses a ON a.id = c.analysis_id
    WHERE c.created_at >= ${start} AND a.created_at >= ${start} AND a.created_at < ${end}
    ORDER BY c.article_id, c.analysis_id DESC`;
  const summary: ArticleCheckSummary = { articles: [], softFlags: 0, softArticles: 0, datelines: { release_wire: 0, news_agency: 0, unmarked: 0 } };
  const list = (value: unknown) => (Array.isArray(value) ? (value as Array<Record<string, unknown> | null>) : []);
  for (const row of rows) {
    summary.articles.push({ articleId: row.article_id, revision: row.input_revision });
    const soft = list(row.figures).filter((finding) => finding?.class === "soft").length;
    summary.softFlags += soft;
    if (soft) summary.softArticles++;
    const kind = list(row.geography).find((note) => note?.kind === "dateline")?.dateline;
    if (kind === "release_wire" || kind === "news_agency" || kind === "unmarked") summary.datelines[kind]++;
  }
  return summary;
}

/** Check rows are kept this long (the migration's promise); the daily retention job deletes older ones. */
export const CHECK_RETENTION_DAYS = 180;

export async function pruneAnalysisChecks(now = new Date(), db: Db = sql): Promise<number> {
  const deleted = await db`DELETE FROM enrichment.analysis_checks WHERE created_at < ${new Date(now.getTime() - CHECK_RETENTION_DAYS * 86_400_000)}`;
  return deleted.count;
}

/**
 * The back-fill's pages (scripts/entity-links-backfill.ts): judgements made in [since, until) that are still the latest
 * of their article and complete and relevant, in id order after `afterId`. Older judgements are left out: readers see
 * the latest one, and a check of an older revision would be skipped as stale anyway.
 */
export async function observableAnalyses(
  range: { since: Date; until: Date; afterId: number; limit: number },
  db: Db = sql,
): Promise<Array<{ analysisId: number; articleId: string }>> {
  const rows = await db<{ id: number; article_id: string }[]>`
    SELECT a.id, a.article_id FROM analyses a
    WHERE a.id > ${range.afterId} AND a.created_at >= ${range.since} AND a.created_at < ${range.until}
      AND a.output ? 'scores' AND a.relevance IS DISTINCT FROM 'block'
      AND NOT EXISTS (SELECT 1 FROM analyses n WHERE n.article_id = a.article_id
        AND (n.input_revision > a.input_revision OR (n.input_revision = a.input_revision AND n.id > a.id)))
    ORDER BY a.id LIMIT ${range.limit}`;
  return rows.map((r) => ({ analysisId: r.id, articleId: r.article_id }));
}
