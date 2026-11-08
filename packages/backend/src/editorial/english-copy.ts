// Writes one public news item's English title and summary (TASK-0595, Owner 2026-11-08). One short request per item
// through the AI gateway: the translation route (models "translate"), its quota, receipts and usage accounting, with
// the item's current material permit. The input is the published Chinese copy and the original title (english-copy-
// input.ts); an English original keeps its own title. The analysis and its scoring prompt are not touched.
// Called only from the worker's content.translate job; readers never reach it.
import { z } from "zod";
import { sql } from "../db.ts";
import { chatJson, markReceiptsCompleted, ModelOutputError, ModelPostReceiptGuardError } from "../providers/llm.ts";
import { ProviderRejectedError } from "../providers/receipts.ts";
import { ModelContentFiltered } from "../providers/model-fallback.ts";
import { prepareNewsFallback, lockNewsProcessingPermissions } from "../providers/news-fallback.ts";
import { requireRuntimeRunning, assertRuntimeControl } from "../operations/lane-controls.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import { readEnglishCopy } from "../enrichment/records.ts";
import { englishCopyCandidate, type EnglishCopyCandidate } from "../publication/publish.ts";
import { modelFor } from "./models.ts";
import { promptText } from "./prompts.ts";
import { englishCopyRecipe } from "./english-copy-input.ts";

/** English only: an answer with Chinese characters left in is not used (the page keeps the Chinese copy). */
const english = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((text) => !/\p{Script=Han}/u.test(text), "not English");
const TitleAndSummary = z.object({ title: english(300), summary: english(1500) });
const SummaryOnly = z.object({ summary: english(1500) });

/**
 * - ready: a copy for this exact input already exists (nothing paid);
 * - written: written and stored now;
 * - not_needed: the item gets no English copy (not public, no summary, an original post);
 * - stale: the Chinese copy or the material changed while writing; nothing stored, the next run writes the new one;
 * - denied: the current source permission does not allow sending it to a model;
 * - rejected: the model's answer was unusable or refused; its receipt is kept as failed, the page keeps the Chinese copy.
 */
export type EnglishCopyOutcome = "ready" | "written" | "not_needed" | "stale" | "denied" | "rejected";

const identity = (candidate: EnglishCopyCandidate | null) =>
  candidate ? { revision: candidate.revision, sourceId: candidate.sourceId, hash: candidate.input.hash } : null;

export async function writeEnglishCopy(articleId: string): Promise<EnglishCopyOutcome> {
  const candidate = await englishCopyCandidate(articleId);
  if (!candidate) return "not_needed";
  if (await readEnglishCopy(articleId, candidate.input.hash)) return "ready";
  const runtimeControl = await requireRuntimeRunning("news", ["processing"]);
  const fallback = await prepareNewsFallback({
    root: shutdownSignal.signal,
    expected: identity(candidate),
    current: async () => identity(await englishCopyCandidate(articleId)),
    articles: [{ id: articleId, revision: candidate.revision }],
  });
  if (!fallback) return "denied";
  const system = promptText("english-copy"),
    user = JSON.stringify(candidate.input.message);
  const keepTitle = candidate.input.keepTitle;
  let title: string, summary: string, receiptId: number, attemptId: string | null;
  try {
    const request = {
      model: await modelFor("translate"),
      purpose: "english_copy",
      sourceIds: [candidate.sourceId],
      runtimeControl,
      subject: `article:${articleId}@${candidate.revision}#en`,
      promptVersion: englishCopyRecipe(),
      system,
      user,
      fallbackPermit: fallback({ system, user }),
      temperature: 0.2,
      maxTokens: 600,
      timeoutMs: 60_000,
    };
    if (keepTitle) {
      const reply = await chatJson({ ...request, schema: SummaryOnly });
      ({ receiptId, attemptId } = reply);
      title = candidate.input.sourceTitle!;
      summary = reply.data.summary;
    } else {
      const reply = await chatJson({ ...request, schema: TitleAndSummary });
      ({ receiptId, attemptId } = reply);
      ({ title, summary } = reply.data);
    }
  } catch (error) {
    // The paid answer stays in its receipt; the permit changed after it arrived, so it is not shown.
    if (error instanceof ModelPostReceiptGuardError) return "denied";
    if (error instanceof ModelOutputError || error instanceof ModelContentFiltered || (error instanceof ProviderRejectedError && !error.retryable))
      return "rejected";
    throw error;
  }
  shutdownSignal.signal.throwIfAborted();
  const stored = await sql.begin(async (tx) => {
    await lockNewsProcessingPermissions([articleId], tx);
    await assertRuntimeControl(tx, runtimeControl);
    const current = await englishCopyCandidate(articleId, tx);
    if (current?.input.hash !== candidate.input.hash || current.revision !== candidate.revision) return false;
    await tx`INSERT INTO enrichment.english_copies(article_id,input_hash,recipe,title_en,summary_en,title_origin,input_revision,receipt_id,attempt_id)
      VALUES(${articleId},${candidate.input.hash},${englishCopyRecipe()},${title},${summary},${keepTitle ? "source" : "model"},${candidate.revision},
        ${receiptId},${attemptId})
      ON CONFLICT(article_id,input_hash) DO NOTHING`;
    return true;
  });
  if (!stored) return "stale";
  await markReceiptsCompleted([receiptId]);
  return "written";
}
