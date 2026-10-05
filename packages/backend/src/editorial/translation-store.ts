import * as cheerio from "cheerio";
import { dbOf, type Db, type Tx } from "../db.ts";
import { commitBodyResult, type CurrentBody } from "../content/materials.ts";
import { sanitizeBody } from "../content/sanitize.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { canReplaceTranslationResponse, settleTranslationResponse, type TranslationObservation } from "../providers/receipts.ts";
import type { ChatJsonResult } from "../providers/llm.ts";
import {
  assembleTranslation,
  restoreTranslationText,
  translationSourceManifest,
  translationLeaves,
  translationReplacement,
  type SourceSegment,
  type StoredTranslation,
  type TranslationCheckpoint,
} from "./translation-readiness.ts";

const sql = dbOf("enrichment");
export interface TranslationSession {
  body: CurrentBody & { body_html: string };
  recipe: string;
  source: ReturnType<typeof translationSourceManifest>;
}

/** Preserve observed holds from earlier recipes too; the gateway validates each receipt/attempt pair. */
export async function translationObservations(body: CurrentBody): Promise<TranslationObservation[]> {
  return sql<TranslationObservation[]>`SELECT DISTINCT receipt_id::text AS "receiptId",attempt_id AS "attemptId"
    FROM enrichment.translation_segments WHERE article_id=${body.id} AND revision=${body.revision} AND receipt_id IS NOT NULL`;
}
interface StoredSegment {
  segment_index: number;
  segment_hash: string;
  state: "complete" | "failed" | "unknown";
  failed_attempts: number;
  attempt_id: string | null;
  response_text: string | null;
  response_hash: string | null;
  restored_html: string | null;
  restored_hash: string | null;
  parent_index: number | null;
  replacement_plan: unknown;
}

function segmentAt(run: TranslationSession, index: number): SourceSegment | undefined {
  const count = run.source.segments.length;
  if (index < count) return run.source.segments[index];
  const parent = run.source.segments[Math.floor((index - count) / 2)];
  return parent && translationReplacement(parent, count)?.find((part) => part.index === index);
}

function replacementPlan(run: TranslationSession, index: number) {
  const parent = run.source.segments[index],
    children = parent && translationReplacement(parent, run.source.segments.length);
  return children
    ? { format: "half-v1", children: children.map((part) => ({ index: part.index, sourceHash: part.sourceHash, referenceHash: sha256(part.reference) })) }
    : null;
}

async function activeSegment(run: TranslationSession, segment: SourceSegment, tx: Tx) {
  const parent = segment.parentIndex ?? segment.index;
  const [row] = await tx`SELECT replacement_plan FROM enrichment.translation_segments
    WHERE article_id=${run.body.id} AND revision=${run.body.revision} AND recipe=${run.recipe}
      AND source_hash=${run.source.sourceHash} AND segment_index=${parent}`;
  return segment.parentIndex === undefined
    ? !row?.replacement_plan
    : !!row?.replacement_plan && stableJson(row.replacement_plan) === stableJson(replacementPlan(run, parent));
}

/** Claim a target identity before paid work; source-provided translations are never replaced. */
export async function beginTranslation(body: CurrentBody, recipe: string): Promise<TranslationSession | null> {
  if (!body.body_html || !recipe) return null;
  const session: TranslationSession = { body: { ...body, body_html: body.body_html }, recipe, source: translationSourceManifest(body.body_html) };
  if (!session.source.segments.length || session.source.capacity.length) return null;
  const claimed = await commitBodyResult(body, async (tx) => {
    const [current] = await tx`SELECT revision,recipe,source_hash,origin FROM translations WHERE article_id=${body.id} AND lang='zh' FOR UPDATE`;
    if (current?.origin === "source" || current?.revision > body.revision) return false;
    if (current?.revision === body.revision && current.recipe === recipe && current.source_hash === session.source.sourceHash) return true;
    await tx`INSERT INTO translations(article_id,lang,revision,complete,origin,recipe,source_hash)
      VALUES(${body.id},'zh',${body.revision},false,'model',${recipe},${session.source.sourceHash})
      ON CONFLICT(article_id,lang) DO UPDATE SET revision=EXCLUDED.revision,complete=false,origin='model',recipe=EXCLUDED.recipe,
        source_hash=EXCLUDED.source_hash,manifest=NULL,body_html=NULL,body_text=NULL,receipt_id=NULL`;
    return true;
  });
  return claimed ? session : null;
}

async function withCurrentTranslation<T>(run: TranslationSession, write: (tx: Tx) => Promise<T>): Promise<T | null> {
  return commitBodyResult(run.body, async (tx) => {
    const rows = await tx`SELECT article_id FROM translations WHERE article_id=${run.body.id} AND lang='zh' AND revision=${run.body.revision}
      AND recipe=${run.recipe} AND source_hash=${run.source.sourceHash} AND origin='model' FOR UPDATE`;
    return rows.length ? write(tx) : null;
  });
}

export async function translationCheckpoints(run: TranslationSession, tx: Tx | typeof sql = sql) {
  const rows = await tx<
    StoredSegment[]
  >`SELECT segment_index,segment_hash,state,failed_attempts,attempt_id,response_text,response_hash,restored_html,restored_hash,parent_index,replacement_plan
    FROM enrichment.translation_segments WHERE article_id=${run.body.id} AND revision=${run.body.revision}
      AND recipe=${run.recipe} AND source_hash=${run.source.sourceHash} ORDER BY segment_index`;
  return rows.map((row): TranslationCheckpoint & { failedAttempts: number; replacement: boolean } => {
    const segment = segmentAt(run, row.segment_index);
    if (row.replacement_plan && (row.parent_index !== null || stableJson(row.replacement_plan) !== stableJson(replacementPlan(run, row.segment_index))))
      throw new Error("Invalid translation replacement identity");
    const restored = segment && row.response_text !== null ? restoreTranslationText(segment.html, { text: row.response_text }) : null;
    const verified =
      row.attempt_id !== null &&
      (segment?.parentIndex ?? null) === row.parent_index &&
      restored !== null &&
      restored === row.restored_html &&
      sha256(restored) === row.restored_hash &&
      sha256(row.response_text!) === row.response_hash;
    return {
      index: row.segment_index,
      sourceHash: row.segment_hash,
      revision: run.body.revision,
      recipe: run.recipe,
      state: row.state === "complete" && !verified ? "pending" : row.state,
      text: row.response_text ?? "",
      failedAttempts: row.failed_attempts,
      replacement: !!row.replacement_plan,
    };
  });
}

/** Only a checked response supplied by the actual gateway caller becomes a reusable checkpoint. */
export async function saveTranslationSegment(run: TranslationSession, index: number, reply: ChatJsonResult<{ text: string }>): Promise<boolean> {
  const segment = segmentAt(run, index);
  const restored = segment && restoreTranslationText(segment.html, reply.data);
  if (!segment || restored == null) return false;
  return (
    (await withCurrentTranslation(run, async (tx) => {
      if (!(await activeSegment(run, segment, tx))) return false;
      const settled = await settleTranslationResponse(tx, reply, { accepted: true });
      if (!settled) return false;
      await tx`INSERT INTO enrichment.translation_segments(article_id,revision,recipe,source_hash,segment_index,segment_hash,state,
      receipt_id,attempt_id,failed_attempts,response_text,response_hash,restored_html,restored_hash,parent_index)
      VALUES(${run.body.id},${run.body.revision},${run.recipe},${run.source.sourceHash},${index},${segment.sourceHash},'complete',
        ${reply.receiptId},${reply.attemptId},${settled.rejected},${reply.data.text},${sha256(reply.data.text)},${restored},${sha256(restored)},${segment.parentIndex ?? null})
      ON CONFLICT(article_id,revision,recipe,source_hash,segment_index) DO UPDATE SET state='complete',receipt_id=EXCLUDED.receipt_id,attempt_id=EXCLUDED.attempt_id,failed_attempts=EXCLUDED.failed_attempts,
        response_text=EXCLUDED.response_text,response_hash=EXCLUDED.response_hash,restored_html=EXCLUDED.restored_html,
        restored_hash=EXCLUDED.restored_hash,last_error=NULL,updated_at=now()`;
      return true;
    })) ?? false
  );
}

export async function recordTranslationFailure(
  run: TranslationSession,
  index: number,
  state: "failed" | "unknown",
  receiptId: number | null,
  error: string,
  attemptId: string | null = null,
) {
  const segment = segmentAt(run, index);
  if (!segment) throw new Error("Translation segment does not exist");
  return withCurrentTranslation(run, async (tx) => {
    if (!(await activeSegment(run, segment, tx))) return null;
    const settled =
      state === "failed" && receiptId !== null ? await settleTranslationResponse(tx, { receiptId, attemptId }, { accepted: false, reason: error }) : null;
    if (state === "failed" && !settled) return null;
    await tx`INSERT INTO enrichment.translation_segments(article_id,revision,recipe,source_hash,segment_index,segment_hash,state,receipt_id,attempt_id,failed_attempts,last_error,parent_index)
      VALUES(${run.body.id},${run.body.revision},${run.recipe},${run.source.sourceHash},${index},${segment.sourceHash},${state},${receiptId},${attemptId},
        ${settled?.rejected ?? 0},${error.slice(0, 300)},${segment.parentIndex ?? null})
      ON CONFLICT(article_id,revision,recipe,source_hash,segment_index) DO UPDATE SET state=EXCLUDED.state,receipt_id=EXCLUDED.receipt_id,attempt_id=EXCLUDED.attempt_id,
        failed_attempts=CASE WHEN EXCLUDED.state='failed' THEN EXCLUDED.failed_attempts ELSE translation_segments.failed_attempts END,
        last_error=EXCLUDED.last_error,updated_at=now()
      WHERE translation_segments.state<>'complete'`;
  });
}

/** Keep the parent received; only the current known truncation can choose its two deterministic children. */
export async function replaceTranslationSegment(run: TranslationSession, index: number, reply: ChatJsonResult<unknown>) {
  const segment = run.source.segments[index],
    plan = replacementPlan(run, index);
  if (!segment || !plan) return false;
  return withCurrentTranslation(run, async (tx) => {
    if (!(await canReplaceTranslationResponse(tx, reply))) return false;
    const [existing] = await tx`SELECT replacement_plan,receipt_id,attempt_id FROM enrichment.translation_segments
      WHERE article_id=${run.body.id} AND revision=${run.body.revision} AND recipe=${run.recipe}
        AND source_hash=${run.source.sourceHash} AND segment_index=${index}`;
    if (existing?.replacement_plan)
      return stableJson(existing.replacement_plan) === stableJson(plan) && existing.receipt_id === reply.receiptId && existing.attempt_id === reply.attemptId;
    await tx`INSERT INTO enrichment.translation_segments(article_id,revision,recipe,source_hash,segment_index,segment_hash,state,receipt_id,attempt_id,replacement_plan,last_error)
      VALUES(${run.body.id},${run.body.revision},${run.recipe},${run.source.sourceHash},${index},${segment.sourceHash},'failed',
        ${reply.receiptId},${reply.attemptId},${tx.json(plan)},'truncated; one replacement')
      ON CONFLICT(article_id,revision,recipe,source_hash,segment_index) DO UPDATE SET replacement_plan=EXCLUDED.replacement_plan,
        state='failed',receipt_id=EXCLUDED.receipt_id,attempt_id=EXCLUDED.attempt_id,last_error=EXCLUDED.last_error,updated_at=now()`;
    return true;
  });
}

export async function finishTranslation(run: TranslationSession): Promise<boolean> {
  return (
    (await withCurrentTranslation(run, async (tx) => {
      const checkpoints = await translationCheckpoints(run, tx),
        replacements = checkpoints.filter((part) => part.replacement).map((part) => part.index);
      const leaves = translationLeaves(run.source, replacements);
      if (!leaves) return false;
      const ordered = leaves.map((part) => checkpoints.find((checkpoint) => checkpoint.index === part.index));
      if (ordered.some((part) => !part)) return false;
      const assembled = assembleTranslation(
        run.body.body_html,
        { revision: run.body.revision, recipe: run.recipe },
        ordered as TranslationCheckpoint[],
        replacements,
      );
      if (!assembled) return false;
      const html = sanitizeBody(assembled.html),
        tree = cheerio.load(html, null, false);
      if (tree.html() !== assembled.html) return false; // Sanitisation must not silently remove source structure.
      await tx`UPDATE translations SET body_html=${html},body_text=${tree.root().text().trim()},complete=true,
      manifest=${tx.json(assembled.manifest)},created_at=now() WHERE article_id=${run.body.id} AND lang='zh'`;
      return true;
    })) ?? false
  );
}

/** Only the promoted/read-safe fields cross the enrichment port; never checkpoint or receipt rows. */
export async function readStoredTranslation(articleId: string, db: Db = sql): Promise<StoredTranslation | null> {
  const [row] = await db<StoredTranslation[]>`SELECT revision,body_html,complete,origin,recipe,source_hash,manifest
    FROM translations WHERE article_id=${articleId} AND lang='zh'`;
  return row ?? null;
}
