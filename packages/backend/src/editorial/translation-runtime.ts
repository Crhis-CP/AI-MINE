import { prepareNewsFallback } from "../providers/news-fallback.ts";
import type { SourceSegment } from "./translation-readiness.ts";
// Strict segment runner used by the per-item worker; network calls stay outside content locks. Consecutive blocks go
// out together up to TRANSLATION_SEGMENT_BYTES (TASK-0711) and every block is still checked and saved on its own.
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
  translationBatch,
  TranslationBatchSchema,
  TranslationTextSchema,
  translationBudgetUnits,
  translationSourceManifest,
  translationLeaves,
  translationReplacement,
} from "./translation-readiness.ts";
import {
  beginTranslation,
  finishTranslation,
  recordTranslationBatchBlockFailure,
  recordTranslationFailure,
  rejectTranslationBatch,
  replaceTranslationSegment,
  saveTranslationSegment,
  translationCheckpoints,
  translationObservations,
  earlierRevisionAnswers,
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

export interface TranslationRunOptions {
  /**
   * Asked before every paid request (one block or a batch of blocks): a time means stop now and resume then
   * (TASK-0579, a non-selected item in the provider's peak hours). Saved blocks stay checkpoints, so the next run pays
   * only for the rest. `model` is the model this request will be paid with (fixed when the run starts), so a quota
   * check judges the quota it draws on.
   */
  beforePaidSegment?: (model: string) => Promise<Date | null>;
}

/** Caller verifies scope/source permission first. Paid work never holds a content transaction. */
export async function runBodyTranslation(articleId: string, recipe: TranslationRecipe, expectedRevision?: number, options: TranslationRunOptions = {}) {
  assertRunning();
  const body = await readCurrentBody(articleId);
  if (!body || !normalizeSourceLanguage(body.language)) return { status: "skipped" as const, revision: body?.revision, reason: "language_unidentified" };
  if (expectedRevision !== undefined && body.revision !== expectedRevision) return { status: "stale" as const, revision: body.revision };
  if (isChineseOriginal(body.language)) return { status: "skipped" as const, revision: body.revision, reason: "original_chinese" };
  const manifest = translationSourceManifest(body.body_html ?? "");
  if (manifest.capacity.length && !manifest.segments.length) return { status: "partial" as const, revision: body.revision, reason: "pending_capacity" };
  const run = await beginTranslation(body, recipe.id);
  if (!run) return { status: "skipped" as const, revision: body?.revision };
  const bodyInput = (current: typeof body | null) => {
    if (!current?.x_post) return current;
    const { x_post: _unusedPostView, ...originalBody } = current;
    return originalBody;
  };
  const fallbackInput = await prepareNewsFallback({
    root: shutdownSignal.signal,
    expected: bodyInput(body),
    current: async () => bodyInput(await readCurrentBody(articleId)),
    articles: [body],
    materialScope: "body",
  });
  const saved = await translationCheckpoints(run);
  let inheritedObservations = await translationObservations(body);
  const leaves = translationLeaves(
    run.source,
    saved.filter((row) => row.replacement).map((row) => row.index),
  );
  if (!leaves) throw new Error("Invalid translation leaf plan");
  const chosenUnits = translationBudgetUnits(run.body.body_html);
  let pendingReason: string | undefined = run.source.capacity.length ? "pending_capacity" : undefined;
  const checkpointOf = (leaf: SourceSegment) => saved.find((row) => row.index === leaf.index && row.sourceHash === leaf.sourceHash);
  // Blocks saved by this run, blocks that must now go out alone, and the binary split of a failed batch: the most
  // leaves a batch starting at that leaf may take.
  const done = new Set<number>();
  const alone = new Set<number>();
  const caps = new Map<number, number>();
  // Only a block with no stored attempt joins a batch. A block that failed, or whose answer is still unknown, keeps the
  // exact request it was sent with, so its retry limit and the unknown-outcome hold stay where they are.
  const batchable = (leaf: SourceSegment) =>
    leaf.parentIndex === undefined && chosenUnits.has(leaf.unitIndex) && !alone.has(leaf.index) && !done.has(leaf.index) && !checkpointOf(leaf);
  /** The same batch again while its answer is unknown: every block of it holds the batch's receipt, in order. */
  const unknownBatch = (position: number) => {
    const receipt = checkpointOf(leaves[position]!);
    if (receipt?.state !== "unknown" || !receipt.receiptId) return null;
    const group: SourceSegment[] = [];
    for (let i = position; i < leaves.length; i++) {
      const row = checkpointOf(leaves[i]!);
      if (row?.state !== "unknown" || row.receiptId !== receipt.receiptId || leaves[i]!.parentIndex !== undefined) break;
      group.push(leaves[i]!);
    }
    return group.length > 1 ? group : null;
  };

  /** One request for two or more blocks: "split" asks the caller to try each half; otherwise the loop revisits them. */
  const translateBatch = async (batch: SourceSegment[]) => {
    const parts = batch.map((leaf) => shield(leaf.html).html);
    const user = JSON.stringify({ texts: parts, ...(batch[0]!.reference ? { referenceOnly: batch[0]!.reference } : {}) });
    let reply: ChatJsonResult<unknown>;
    try {
      const observations = inheritedObservations;
      inheritedObservations = [];
      reply = await chatJson({
        model: recipe.model,
        purpose: "translate_body",
        sourceIds: [body.source_id],
        runtimeControl: run.runtimeControl,
        subject: `article:${articleId}@${body.revision}#${batch[0]!.index}`,
        promptVersion: recipe.promptVersion,
        system: recipe.system,
        user,
        fallbackPermit: fallbackInput?.({ system: recipe.system, user }),
        schema: z.unknown(),
        parse: (content) => content,
        temperature: 0.2,
        maxTokens: Math.min(8000, Math.ceil(parts.join("").length * 1.2) + 400 + 20 * parts.length),
        timeoutMs: 180_000,
        // A batch is bought once: a rejected batch answer is never bought again, its halves are asked instead.
        maxRejectedOutputs: 1,
        translationObservations: observations,
      });
    } catch (error) {
      if (error instanceof ModelPostReceiptGuardError) {
        const current = await readCurrentBody(articleId);
        if (!current || current.revision !== body.revision || current.body_html !== body.body_html)
          return { status: "stale" as const, revision: body.revision };
      }
      if (error instanceof ReceiptOutputLimitError || error instanceof ReceiptCooldownError) return "split" as const;
      if (error instanceof ReceiptUnknownError)
        for (const leaf of batch) await recordTranslationFailure(run, leaf.index, "unknown", error.receiptId, error.message, error.attemptId);
      throw error;
    }
    assertRunning();
    if (reply.attemptId === null) return { status: "partial" as const, revision: body.revision, reason: "unbound historical response" };
    let texts: string[] | null = null;
    let reason = `unfinished response: ${reply.finishReason}`;
    if (reply.finishReason === null || reply.finishReason === "" || reply.finishReason === "stop") {
      try {
        const parsed = TranslationBatchSchema.safeParse(JSON.parse(String(reply.data)));
        if (parsed.success && parsed.data.texts.length === batch.length) texts = parsed.data.texts;
        else reason = parsed.success ? "batch length changed" : String(parsed.error);
      } catch (error) {
        reason = String(error);
      }
    }
    const restored = texts ? batch.map((leaf, i) => restoreTranslationText(leaf.html, { text: texts[i] }) !== null) : [];
    if (!texts || !restored.some(Boolean)) {
      if ((await rejectTranslationBatch(run, reply, texts ? "no block of the batch passed its check" : reason)) === null)
        return { status: "stale" as const, revision: body.revision };
      return "split" as const;
    }
    for (const [i, leaf] of batch.entries()) {
      if (!restored[i]) {
        alone.add(leaf.index);
        const schema = TranslationTextSchema.safeParse({ text: texts[i] });
        const issue = schema.success ? "source structure changed" : String(schema.error);
        if ((await recordTranslationBatchBlockFailure(run, leaf.index, reply, issue)) === null) return { status: "stale" as const, revision: body.revision };
        continue;
      }
      if (!(await saveTranslationSegment(run, leaf.index, { ...reply, data: { text: texts[i]! } })))
        return { status: "stale" as const, revision: body.revision };
      done.add(leaf.index);
    }
    return "saved" as const;
  };

  // An unchanged block of an earlier revision keeps its paid answer before anything is packed (BR-ENR-18).
  for (const [index, earlier] of await earlierRevisionAnswers(
    run,
    leaves.filter((leaf) => chosenUnits.has(leaf.unitIndex) && !checkpointOf(leaf)),
  )) {
    const reused = { data: { text: earlier.text }, receiptId: earlier.receiptId, attemptId: earlier.attemptId, reused: true, model: recipe.model };
    if (await saveTranslationSegment(run, index, { ...reused, usage: null, finishReason: "stop" })) done.add(index);
  }

  for (let position = 0; position < leaves.length; position++) {
    const segment = leaves[position]!;
    if (!chosenUnits.has(segment.unitIndex)) {
      pendingReason = "text_limit";
      break;
    }
    assertRunning();
    if (done.has(segment.index) || checkpointOf(segment)?.state === "complete") continue;
    const batch = batchable(segment) ? translationBatch(leaves, position, batchable, caps.get(segment.index)) : (unknownBatch(position) ?? [segment]);
    const until = await options.beforePaidSegment?.(recipe.model);
    if (until) return { status: "deferred" as const, revision: body.revision, until };
    if (batch.length > 1) {
      const outcome = await translateBatch(batch);
      if (typeof outcome === "object") return outcome;
      // The batch's answer is known now, so none of its blocks waits on that receipt any longer.
      for (const leaf of batch) {
        const row = checkpointOf(leaf);
        if (row?.state === "unknown") saved.splice(saved.indexOf(row), 1);
      }
      if (outcome === "split") {
        const half = Math.ceil(batch.length / 2);
        caps.set(batch[0]!.index, half);
        caps.set(batch[half]!.index, batch.length - half);
      }
      // Saved blocks are skipped on the way back; a block that failed inside the batch now goes alone.
      position--;
      continue;
    }
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
    done.add(segment.index);
  }
  assertRunning();
  return {
    status: (await finishTranslation(run)) ? ("translated" as const) : ("partial" as const),
    revision: body!.revision,
    ...(pendingReason ? { reason: pendingReason } : {}),
  };
}
