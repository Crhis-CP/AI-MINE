// Per-item worker translation and an enqueue-only cron repair, using durable strict segment checkpoints.
import { sql } from "../db.ts";
import { z } from "zod";
import { latestSuccessfulRunResult } from "../admin/runs.ts";
import { modelFor } from "./models.ts";
import { QUEUES, shutdownSignal } from "../jobs/queue.ts";
import { enqueueJob as enqueue } from "../jobs/module-queues.ts";
import { promptText, promptVersion } from "./prompts.ts";
import { TRANSLATION_MANIFEST_FORMAT } from "./translation-readiness.ts";
import { releasedTranslationScopes } from "../providers/receipts.ts";
import { runBodyTranslation } from "./translation-runtime.ts";
export { shield, unshield } from "./translation-readiness.ts";

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

type AttemptState = { attempts: number | null; outcome: string | null; reason: string | null };
function stopReason(row: AttemptState | undefined, recovered: boolean): string | null {
  if (row?.outcome === "partial" && ["text_limit", "pending_capacity"].includes(row.reason ?? "")) return row.reason;
  return row && (row.attempts ?? 0) >= 3 && row.outcome !== "translated" && !recovered ? "attempts_exhausted" : null;
}
async function bodyTranslationStop(articleId: string, revision: number): Promise<string | null> {
  const [row] = await sql<AttemptState[]>`SELECT attempts,outcome,reason FROM translation_attempts WHERE article_id=${articleId} AND revision=${revision}`;
  if (!stopReason(row, false)) return null;
  const scope = `article:${articleId}@${revision}`;
  return stopReason(row, (await releasedTranslationScopes([scope])).has(scope));
}

/** Called only after the worker obtains a current revision from publication.prepareTranslation. */
export async function translateArticle(articleId: string, expectedRevision: number): Promise<TranslateResult> {
  const stopped = await bodyTranslationStop(articleId, expectedRevision);
  if (stopped) return { articleId, status: "skipped", reason: stopped };
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
  if (translated.status === "stale") return { articleId, status: "partial", revision: translated.revision, reason: "input_changed" };
  const result: TranslateResult = { ...translated, articleId, status: translated.status };
  if (result.revision !== undefined && result.reason !== "retry_cooldown")
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
  const rows = await sql<({ article_id: string; revision: number } & AttemptState)[]>`
    SELECT p.article_id,a.revision,ta.attempts,ta.outcome,ta.reason FROM publications p JOIN articles a ON a.id = p.article_id
    LEFT JOIN translations tr ON tr.article_id = p.article_id AND tr.lang = 'zh'
    LEFT JOIN translation_attempts ta ON ta.article_id=p.article_id AND ta.revision=a.revision
    WHERE p.selected AND p.visibility='public' AND p.body_mode = 'full' AND a.language IS NOT NULL AND split_part(a.language, '-', 1) <> 'zh'
      AND p.article_id > ${afterId ?? ""}
      AND (tr.article_id IS NULL OR (tr.origin <> 'source' AND
           (tr.revision < a.revision OR NOT tr.complete OR tr.recipe IS DISTINCT FROM ${RECIPE})))
    ORDER BY p.article_id LIMIT ${limit}`;
  const recovered = await releasedTranslationScopes(rows.filter((row) => !!stopReason(row, false)).map((row) => `article:${row.article_id}@${row.revision}`));
  let enqueued = 0,
    scanned = 0;
  for (const row of rows) {
    if (shutdownSignal.signal.aborted || Date.now() - started >= (opts.budgetMs ?? 4 * 60_000)) break;
    if (!stopReason(row, recovered.has(`article:${row.article_id}@${row.revision}`))) {
      const queued = await enqueue(QUEUES.translate, { articleId: row.article_id, lane: "news" }, { singletonKey: row.article_id });
      if (queued === undefined) break; // An expired producer gives no durable acceptance evidence.
      if (queued) enqueued++;
    }
    scanned++;
    afterId = row.article_id; // null means an existing durable singleton, so it must not starve later ids.
  }
  if (scanned === rows.length && rows.length < limit) afterId = null;
  return { enqueued, scanned, cursor: { version: 1 as const, afterId } };
}
