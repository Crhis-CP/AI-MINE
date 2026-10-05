// Explicit runner preparation; the existing cron/t adapter switches in its own atomic change.
import { z } from "zod";
import { readCurrentBody } from "../content/materials.ts";
import { chatJson, type ChatJsonResult } from "../providers/llm.ts";
import { ReceiptUnknownError, ReceiptOutputLimitError } from "../providers/receipts.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import { restoreTranslationText, shield, TranslationTextSchema } from "./translation-readiness.ts";
import { beginTranslation, finishTranslation, recordTranslationFailure, saveTranslationSegment, translationCheckpoints } from "./translation-store.ts";

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
export async function runBodyTranslation(articleId: string, recipe: TranslationRecipe) {
  assertRunning();
  const body = await readCurrentBody(articleId);
  const run = body && (await beginTranslation(body, recipe.id));
  if (!run) return { status: "skipped" as const, revision: body?.revision };
  const saved = await translationCheckpoints(run);
  for (const segment of run.source.segments) {
    assertRunning();
    const checkpoint = saved.find((row) => row.index === segment.index && row.sourceHash === segment.sourceHash);
    if (checkpoint?.state === "complete") continue;
    const part = shield(segment.html).html;
    let reply: ChatJsonResult<unknown>;
    try {
      reply = await chatJson({
        model: recipe.model,
        purpose: "translate_body",
        subject: `article:${articleId}@${body!.revision}#${segment.index}`,
        promptVersion: recipe.promptVersion,
        system: recipe.system,
        user: JSON.stringify({ text: part }),
        // Retain usage before strict validation: unusable output without known usage must not buy a retry.
        schema: z.unknown(),
        parse: (content) => content,
        temperature: 0.2,
        maxTokens: Math.min(8000, Math.ceil(part.length * 1.2) + 400),
        timeoutMs: 180_000,
        maxRejectedOutputs: 3,
      });
    } catch (error) {
      if (error instanceof ReceiptOutputLimitError) continue;
      if (error instanceof ReceiptUnknownError) await recordTranslationFailure(run, segment.index, "unknown", error.receiptId, error.message);
      throw error;
    }
    assertRunning(); // The sent answer remains received and reusable when stopping between fragments.
    if (reply.attemptId === null) return { status: "partial" as const, revision: body!.revision, reason: "unbound historical response" };
    if (reply.finishReason !== null && reply.finishReason !== "" && reply.finishReason !== "stop")
      return { status: "partial" as const, revision: body!.revision, reason: reply.finishReason === "length" ? "truncated" : "unfinished response" };
    let parsed: z.infer<typeof TranslationTextSchema>;
    try {
      parsed = TranslationTextSchema.parse(JSON.parse(String(reply.data)));
      if (restoreTranslationText(segment.html, parsed) === null) throw new Error("source structure changed");
    } catch (error) {
      if ((await recordTranslationFailure(run, segment.index, "failed", reply.receiptId, String(error), reply.attemptId)) === null)
        return { status: "stale" as const, revision: body!.revision };
      continue;
    }
    if (!(await saveTranslationSegment(run, segment.index, { ...reply, data: parsed }))) return { status: "stale" as const, revision: body!.revision };
  }
  assertRunning();
  return { status: (await finishTranslation(run)) ? ("translated" as const) : ("partial" as const), revision: body!.revision };
}
