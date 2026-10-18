import { prepareNewsFallback } from "../providers/news-fallback.ts";
// Strict segment runner used by the per-item worker; network calls stay outside content locks.
import { z } from "zod";
import { normalizeSourceLanguage } from "../sources/config-keys.ts";
import { readCurrentBody } from "../content/materials.ts";
import { chatJson, ModelPostReceiptGuardError, type ChatJsonResult } from "../providers/llm.ts";
import { ReceiptUnknownError, ReceiptOutputLimitError, ReceiptCooldownError } from "../providers/receipts.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import {
  isChineseOriginal,
  restoreTranslationText,
  shield,
  TranslationTextSchema,
  translationBudgetUnits,
  translationSourceManifest,
  translationLeaves,
  translationReplacement,
} from "./translation-readiness.ts";
import {
  beginTranslation,
  finishTranslation,
  recordTranslationFailure,
  replaceTranslationSegment,
  saveTranslationSegment,
  translationCheckpoints,
  translationObservations,
} from "./translation-store.ts";

export interface TranslationRecipe {
  id: string;
  model: string;
  promptVersion: string;
  system: string;
}
export class TranslationInterruptedError extends Error {}
const assertRunning = () => {
  if (shutdownSignal.signal.aborted) throw new TranslationInterruptedError("worker shutting down");
};

/** Caller verifies scope/source permission first. Paid work never holds a content transaction. */
export async function runBodyTranslation(articleId: string, recipe: TranslationRecipe, expectedRevision?: number) {
  assertRunning();
  const body = await readCurrentBody(articleId);
  if (!body || !normalizeSourceLanguage(body.language)) return { status: "skipped" as const, revision: body?.revision, reason: "language_unidentified" };
  if (expectedRevision !== undefined && body.revision !== expectedRevision) return { status: "stale" as const, revision: body.revision };
  if (isChineseOriginal(body.language)) return { status: "skipped" as const, revision: body.revision, reason: "original_chinese" };
  const manifest = translationSourceManifest(body.body_html ?? "");
  if (manifest.capacity.length && !manifest.segments.length) return { status: "partial" as const, revision: body.revision, reason: "pending_capacity" };
  const run = await beginTranslation(body, recipe.id);
  if (!run) return { status: "skipped" as const, revision: body?.revision };
  const fallbackInput = await prepareNewsFallback({ root: shutdownSignal.signal, expected: body, current: () => readCurrentBody(articleId), articles: [body] });
  const saved = await translationCheckpoints(run);
  let inheritedObservations = await translationObservations(body);
  const leaves = translationLeaves(
    run.source,
    saved.filter((row) => row.replacement).map((row) => row.index),
  );
  if (!leaves) throw new Error("Invalid translation leaf plan");
  const chosenUnits = translationBudgetUnits(run.body.body_html);
  let pendingReason: string | undefined = run.source.capacity.length ? "pending_capacity" : undefined;
  for (let position = 0; position < leaves.length; position++) {
    const segment = leaves[position]!;
    if (!chosenUnits.has(segment.unitIndex)) {
      pendingReason = "text_limit";
      break;
    }
    assertRunning();
    const checkpoint = saved.find((row) => row.index === segment.index && row.sourceHash === segment.sourceHash);
    if (checkpoint?.state === "complete") continue;
    const part = shield(segment.html).html;
    const user = JSON.stringify({ text: part, ...(segment.reference ? { referenceOnly: segment.reference } : {}) });
    let reply: ChatJsonResult<unknown>;
    try {
      const observations = inheritedObservations;
      inheritedObservations = [];
      reply = await chatJson({
        model: recipe.model,
        purpose: "translate_body",
        sourceIds: [body.source_id],
        runtimeControl: run.runtimeControl,
        subject: `article:${articleId}@${body!.revision}#${segment.index}`,
        promptVersion: recipe.promptVersion,
        system: recipe.system,
        user,
        fallbackPermit: fallbackInput?.({ system: recipe.system, user }),
        // Retain usage before strict validation: unusable output without known usage must not buy a retry.
        schema: z.unknown(),
        parse: (content) => content,
        temperature: 0.2,
        maxTokens: Math.min(8000, Math.ceil(part.length * 1.2) + 400),
        timeoutMs: 180_000,
        maxRejectedOutputs: segment.parentIndex === undefined ? 3 : 1,
        translationObservations: observations,
      });
    } catch (error) {
      if (error instanceof ModelPostReceiptGuardError) {
        const current = await readCurrentBody(articleId);
        if (!current || current.revision !== body.revision || current.body_html !== body.body_html)
          return { status: "stale" as const, revision: body.revision };
      }
      if (error instanceof ReceiptOutputLimitError) continue;
      if (error instanceof ReceiptCooldownError) {
        pendingReason = "retry_cooldown";
        continue;
      }
      if (error instanceof ReceiptUnknownError) await recordTranslationFailure(run, segment.index, "unknown", error.receiptId, error.message, error.attemptId);
      throw error;
    }
    assertRunning(); // The sent answer remains received and reusable when stopping between fragments.
    if (reply.attemptId === null) return { status: "partial" as const, revision: body!.revision, reason: "unbound historical response" };
    if (reply.finishReason === "length" && segment.parentIndex === undefined) {
      const replaced = await replaceTranslationSegment(run, segment.index, reply);
      if (replaced === null) return { status: "stale" as const, revision: body.revision };
      if (replaced) {
        leaves.splice(position, 1, ...translationReplacement(segment, run.source.segments.length)!);
        position--;
        continue;
      }
    }
    if (reply.finishReason !== null && reply.finishReason !== "" && reply.finishReason !== "stop")
      return { status: "partial" as const, revision: body!.revision, reason: reply.finishReason === "length" ? "truncated" : "unfinished response" };
    let raw: unknown;
    try {
      raw = JSON.parse(String(reply.data));
    } catch (error) {
      if ((await recordTranslationFailure(run, segment.index, "failed", reply.receiptId, String(error), reply.attemptId)) === null)
        return { status: "stale" as const, revision: body!.revision };
      continue;
    }
    if (restoreTranslationText(segment.html, raw) === null) {
      const schema = TranslationTextSchema.safeParse(raw);
      const reason = schema.success ? "source structure changed" : String(schema.error);
      if ((await recordTranslationFailure(run, segment.index, "failed", reply.receiptId, reason, reply.attemptId)) === null)
        return { status: "stale" as const, revision: body!.revision };
      continue;
    }
    const parsed = TranslationTextSchema.safeParse(raw);
    const data = parsed.success ? parsed.data : { text: (raw as { text: string }).text };
    if (!(await saveTranslationSegment(run, segment.index, { ...reply, data }))) return { status: "stale" as const, revision: body!.revision };
  }
  assertRunning();
  return {
    status: (await finishTranslation(run)) ? ("translated" as const) : ("partial" as const),
    revision: body!.revision,
    ...(pendingReason ? { reason: pendingReason } : {}),
  };
}
