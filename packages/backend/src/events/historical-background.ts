import type { z } from "zod";
import { HistoricalCandidateRequest, HistoricalBackgroundConfirmation, type HistoricalBackgroundCandidate } from "@amp/contracts/site";
import { lockNewsModelMaterials } from "@amp/backend/content/materials";
import { readHistoricalBackgroundCandidates, lockReportPublications } from "@amp/backend/publication/publish";
import { sql, type Db } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { assertRuntimeControl, requireRuntimeRunning } from "../operations/lane-controls.ts";
import { lockNewsProcessingPermissions } from "../providers/news-fallback.ts";
import { chatJson, ModelOutputError } from "../providers/llm.ts";
import { ModelContentFiltered } from "../providers/model-fallback.ts";
import { completeReceipt } from "../providers/receipts.ts";
import { modelFor } from "../editorial/models.ts";
import { sourceParticipants } from "../sources/participants.ts";
import { relationInput } from "./group.ts";
import {
  PAIR_BATCH_PROMPT_VERSION,
  PAIR_BATCH_SYSTEM,
  PAIR_SYSTEM,
  PairBatchSchema,
  PairSchema,
  RELATE_PROMPT_VERSION,
  candidateKey,
  completeDecisions,
  firmlyTied,
  pairBatchUser,
  pairUser,
  type ReportView,
} from "./relate.ts";
import { historicalSnapshot, projectHistoricalBackgrounds, HistoricalBackgroundSuperseded } from "./historical-background-store.ts";

type Snapshot = Awaited<ReturnType<typeof historicalSnapshot>>[number];
type Reviewed = { model: string; system: string; user: string; answer: { data: z.infer<typeof PairSchema>; receiptId: number } };

async function reportsOf(snapshots: Snapshot[]): Promise<ReportView[]> {
  const sources = await sourceParticipants(snapshots.map((r) => r.original.source_id));
  return snapshots.map(({ original }) => ({
    articleId: original.id,
    revision: original.revision,
    title: original.original_text.split("\n")[0]!,
    source: sources.find((s) => s.id === original.source_id)?.name ?? original.source_id,
    firstParty: false,
    at: original.published_at,
    summary: null,
  }));
}

/**
 * Two or more candidates are independent pairs sharing the query: one request asks them all (the
 * query's original is sent once), and each answer is still validated and recorded per pair. Unusable
 * output or a superseded snapshot falls back to the per-pair path; runtime and receipt waits propagate.
 */
async function reviewBatch(
  request: HistoricalCandidateRequest,
  candidates: HistoricalBackgroundCandidate[],
  control: Awaited<ReturnType<typeof requireRuntimeRunning>>,
): Promise<Map<string, Reviewed> | null> {
  if (candidates.length < 2) return null;
  const ids = [request.query.articleId, ...candidates.map((c) => c.binding.articleId)];
  try {
    const before = await historicalSnapshot(ids);
    if (stableJson(before.map((row) => row.binding)) !== stableJson([request.query, ...candidates.map((c) => c.binding)]))
      throw new HistoricalBackgroundSuperseded("历史背景候选版本已变化");
    const check = async (db: Db = sql) => {
      if (stableJson(await historicalSnapshot(ids, db)) !== stableJson(before)) throw new HistoricalBackgroundSuperseded("历史背景输入或人工归属已变化");
    };
    const reports = await reportsOf(before);
    const prepared = await relationInput(
      reports,
      PAIR_BATCH_SYSTEM,
      () => pairBatchUser(reports[0]!, reports.slice(1)),
      () => check(),
    );
    const model = await modelFor("groupReview");
    const answer = await chatJson({
      model,
      lane: "news",
      purpose: "group_review",
      subject: `article:${ids[0]}@${request.query.materialRevision}`,
      promptVersion: PAIR_BATCH_PROMPT_VERSION,
      system: PAIR_BATCH_SYSTEM,
      ...prepared,
      schema: PairBatchSchema.refine((value) => completeDecisions(value.decisions, candidates.length), "Each candidate requires exactly one answer"),
      temperature: 0,
      maxTokens: 2560 * candidates.length,
      maxPhysicalAttempts: 1,
      runtimeControl: control,
    });
    return new Map(
      candidates.map((candidate, i): [string, Reviewed] => {
        const d = answer.data.decisions.find((row) => row.id === candidateKey(i))!;
        const data = { a: "", b: "", relation: d.relation, difference: d.difference, evidence: d.evidence, confidence: d.confidence };
        return [candidate.binding.articleId, { model, system: PAIR_BATCH_SYSTEM, user: prepared.user, answer: { data, receiptId: answer.receiptId } }];
      }),
    );
  } catch (error) {
    if (error instanceof ModelOutputError || error instanceof ModelContentFiltered || error instanceof HistoricalBackgroundSuperseded) return null;
    throw error;
  }
}

/** One pair on its own: the path for a single candidate and the fallback when a batch answer is unusable. */
async function reviewPair(
  request: HistoricalCandidateRequest,
  before: Snapshot[],
  check: () => Promise<void>,
  control: Awaited<ReturnType<typeof requireRuntimeRunning>>,
): Promise<Reviewed> {
  const reports = await reportsOf(before);
  // The frozen public bindings above replace selected-only reading context; neither report claims selected coverage.
  const prepared = await relationInput(reports, PAIR_SYSTEM, () => pairUser(reports[0]!, reports[1]!), check);
  const model = await modelFor("groupReview");
  const answer = await chatJson({
    model,
    lane: "news",
    purpose: "group_review",
    subject: `article:${request.query.articleId}@${request.query.materialRevision}`,
    promptVersion: RELATE_PROMPT_VERSION,
    system: PAIR_SYSTEM,
    ...prepared,
    schema: PairSchema,
    temperature: 0,
    maxTokens: 2560,
    maxPhysicalAttempts: 1,
    runtimeControl: control,
  });
  return { model, system: PAIR_SYSTEM, user: prepared.user, answer };
}

/** One bounded query. History is evidence only: this path never creates a fact, signal, pick or notification. */
export async function confirmHistoricalBackground(input: HistoricalCandidateRequest) {
  const request = HistoricalCandidateRequest.parse(input);
  const control = await requireRuntimeRunning("news", ["processing", "publication"]);
  const query = (await historicalSnapshot([request.query.articleId]))[0]!;
  const storyPublicId = query.memberships[0]?.public_id;
  const result = { examined: 0, linked: 0, unrelated: 0, incomplete: 0 };
  if (!storyPublicId) return result;
  const candidates = await readHistoricalBackgroundCandidates(request);
  const batched = await reviewBatch(request, candidates, control);
  for (const candidate of candidates) {
    const ids = [request.query.articleId, candidate.binding.articleId];
    const before = await historicalSnapshot(ids);
    if (stableJson(before.map((row) => row.binding)) !== stableJson([request.query, candidate.binding]))
      throw new HistoricalBackgroundSuperseded("历史背景候选版本已变化");
    const check = async (db: Db = sql) => {
      if (stableJson(await historicalSnapshot(ids, db)) !== stableJson(before)) throw new HistoricalBackgroundSuperseded("历史背景输入或人工归属已变化");
    };
    // The bindings checked above pin the material revisions the batch read, so its answer is this pair's answer.
    const reviewed = batched?.get(candidate.binding.articleId) ?? (await reviewPair(request, before, () => check(), control));
    const { model, answer } = reviewed;
    result.examined++;
    const evidence = answer.data.evidence;
    const queryAnchor = evidence && request.anchors.find((a) => evidence.queryQuote.includes(a.text) && before[0]!.original.original_text.includes(a.quote));
    const candidateAnchor =
      evidence &&
      candidate.anchors.find(
        (a) => a.kind === queryAnchor?.kind && evidence.candidateQuote.includes(a.text) && before[1]!.original.original_text.includes(a.quote),
      );
    const anchorKey = (text: string) => text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
    const valid =
      evidence &&
      queryAnchor &&
      candidateAnchor &&
      anchorKey(queryAnchor.text) === anchorKey(candidateAnchor.text) &&
      [queryAnchor.text, candidateAnchor.text].includes(evidence.anchor) &&
      before[0]!.original.original_text.includes(evidence.queryQuote) &&
      before[1]!.original.original_text.includes(evidence.candidateQuote) &&
      evidence.queryQuote.includes(evidence.queryAction) &&
      evidence.candidateQuote.includes(evidence.candidateAction) &&
      (answer.data.relation !== "SAME_STORY" || !!evidence.change.trim()) &&
      (answer.data.relation !== "SAME_OCCURRENCE" ||
        evidence.queryStage === "other" ||
        evidence.candidateStage === "other" ||
        evidence.queryStage === evidence.candidateStage);
    if (!firmlyTied(answer.data.relation, answer.data.confidence) || !valid) {
      if (["UNRELATED", "ROUNDUP"].includes(answer.data.relation)) result.unrelated++;
      else result.incomplete++;
      await sql.begin((tx) => completeReceipt(tx, answer.receiptId));
      continue;
    }
    const proof = HistoricalBackgroundConfirmation.parse({
      lane: "news",
      query: request.query,
      candidate: candidate.binding,
      relation: answer.data.relation,
      queryAnchor: { ...queryAnchor, quote: evidence.queryQuote },
      candidateAnchor: { ...candidateAnchor, quote: evidence.candidateQuote },
      receiptId: answer.receiptId,
      inputHash: sha256(stableJson({ model, system: reviewed.system, user: reviewed.user, query: request.query, candidate: candidate.binding })),
    });
    const id = sha256(stableJson([storyPublicId, proof.inputHash, proof.receiptId]));
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
      await lockNewsProcessingPermissions(ids, tx);
      await lockNewsModelMaterials(ids, tx);
      await lockReportPublications(ids, tx);
      await check(tx);
      await assertRuntimeControl(tx, control);
      await tx`UPDATE events.story_background_proofs SET active=false WHERE active AND story_public_id=${storyPublicId} AND query_id=${ids[0]} AND candidate_id=${ids[1]} AND id<>${id}`;
      await tx`INSERT INTO events.story_background_proofs(id,story_public_id,query_id,candidate_id,proof) VALUES(${id},${storyPublicId},${ids[0]},${ids[1]},${tx.json(proof)})
        ON CONFLICT(id) DO UPDATE SET active=true`;
      await projectHistoricalBackgrounds(storyPublicId, tx);
      await completeReceipt(tx, answer.receiptId);
    });
    result.linked++;
  }
  return result;
}
