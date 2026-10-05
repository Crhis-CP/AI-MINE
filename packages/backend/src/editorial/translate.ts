// Per-item worker translation and an enqueue-only cron repair, using durable strict segment checkpoints.
import { dbOf } from "../db.ts";
import { z } from "zod";
import { latestSuccessfulRunResult } from "../admin/runs.ts";
import { modelFor } from "./models.ts";
import { enqueue, QUEUES, shutdownSignal } from "../jobs/queue.ts";
import { promptText, promptVersion } from "./prompts.ts";
import { TRANSLATION_MANIFEST_FORMAT } from "./translation-readiness.ts";
import { runBodyTranslation } from "./translation-runtime.ts";
export { shield, unshield } from "./translation-readiness.ts";

const sql = dbOf("enrichment");
export const TRANSLATE_PROMPT_VERSION = promptVersion("translate-body");
const SYSTEM_BODY = promptText("translate-body");
// Route changes apply to new segments; each receipt retains its exact model/request identity.
const RECIPE = `${TRANSLATION_MANIFEST_FORMAT}:${TRANSLATE_PROMPT_VERSION}`;

export interface TranslateResult {
  articleId: string;
  status: "translated" | "partial" | "skipped";
  /** The article revision this result is about: the one read and translated, not a later one. */
  revision?: number;
  segments?: number;
  reason?: string;
}

/** Called only after the worker obtains a current revision from publication.prepareTranslation. */
export async function translateArticle(articleId: string, expectedRevision: number): Promise<TranslateResult> {
  const translated = await runBodyTranslation(
    articleId,
    {
      id: RECIPE,
      model: await modelFor("translate"),
      promptVersion: TRANSLATE_PROMPT_VERSION,
      system: SYSTEM_BODY,
    },
    expectedRevision,
  );
  const result: TranslateResult = { ...translated, articleId, status: translated.status === "stale" ? "partial" : translated.status };
  if (result.revision !== undefined)
    await sql`INSERT INTO translation_attempts(article_id,revision,attempts,outcome,reason)
    VALUES(${articleId},${result.revision},1,${result.status},${result.reason ?? null})
    ON CONFLICT(article_id) DO UPDATE SET revision=EXCLUDED.revision,outcome=EXCLUDED.outcome,reason=EXCLUDED.reason,
      attempts=CASE WHEN translation_attempts.revision=EXCLUDED.revision THEN translation_attempts.attempts+1 ELSE 1 END,updated_at=now()`;
  return result;
}

const RepairCursor = z.object({ cursor: z.strictObject({ version: z.literal(1), afterId: z.string().min(1).max(128).nullable() }) });

/** Bounded keyset repair, independent of age. recordRun persists progress; workers recheck eligibility. */
export async function translatePending(opts: { limit?: number; budgetMs?: number } = {}) {
  const started = Date.now();
  const limit = opts.limit ?? 30;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("translation repair limit must be from 1 to 1000");
  const previous = RepairCursor.safeParse(await latestSuccessfulRunResult("content.translate"));
  let afterId = previous.success ? previous.data.cursor.afterId : null;
  const rows = await sql<{ article_id: string }[]>`
    SELECT p.article_id FROM publications p JOIN articles a ON a.id = p.article_id
    LEFT JOIN translations tr ON tr.article_id = p.article_id AND tr.lang = 'zh'
    WHERE p.body_mode = 'full' AND a.language IS NOT NULL AND split_part(a.language, '-', 1) <> 'zh'
      AND p.article_id > ${afterId ?? ""}
      AND (tr.article_id IS NULL OR (tr.origin <> 'source' AND
           (tr.revision < a.revision OR NOT tr.complete OR tr.recipe IS DISTINCT FROM ${RECIPE})))
    ORDER BY p.article_id LIMIT ${limit}`;
  let enqueued = 0,
    scanned = 0;
  for (const row of rows) {
    if (shutdownSignal.signal.aborted || Date.now() - started >= (opts.budgetMs ?? 4 * 60_000)) break;
    const queued = await enqueue(QUEUES.translate, { articleId: row.article_id }, { singletonKey: row.article_id });
    if (queued === undefined) break; // An expired producer gives no durable acceptance evidence.
    if (queued) enqueued++;
    scanned++;
    afterId = row.article_id; // null means an existing durable singleton, so it must not starve later ids.
  }
  if (scanned === rows.length && rows.length < limit) afterId = null;
  return { enqueued, scanned, cursor: { version: 1 as const, afterId } };
}
