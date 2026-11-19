// analyzeArticle: one article's judgement from start to commit. It runs the prompt steps of analyze.ts in order
// (prefilter, then the scores beside the structure, then the writing), shapes the result with normalizeAnalysis and
// writes it to `analyses`. This file is the orchestration that the pipeline rewrite replaces (DEC-79;
// scripts/verify/legacy-zones.json); the steps, their prompts, versions and input builders stay in analyze.ts.
import { meetsThreshold, scoreMean, scoreSettled } from "@amp/industry/selection";
import { evaluateSourcePolicy, readCurrentSourcePolicy } from "../admin/sources.ts";
import { beginMaterialGrouping } from "../content/grouping.ts";
import { commitProcessingResult } from "../content/materials.ts";
import { sql } from "../db.ts";
import { groupingAnalysisHash, readGroupingAnalysis } from "../enrichment/records.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import { originalPostCopy } from "../lib/text.ts";
import { assertRuntimeControl, runtimeControlSnapshot } from "../operations/lane-controls.ts";
import { ModelPostReceiptGuardError } from "../providers/llm.ts";
import { lockNewsProcessingPermissions, prepareNewsFallback } from "../providers/news-fallback.ts";
import { completeReceipt } from "../providers/receipts.ts";
import { promptVersionsFor } from "./analysis-layout.ts";
import {
  type AnalysisRun,
  type AnalyzeInputArticle,
  analysisVersionOf,
  awaitsMaterial,
  checkAnalysisRunning,
  layoutOf,
  mendWording,
  normalizeAnalysis,
  runSelectionPrefilter,
  runSelectionScores,
  runStructure,
  runSummarize,
  runUnderstand,
  SCORE_CALLS,
  type StepOpts,
  UNDERSTAND_FLOOR,
  waitsForPage,
} from "./analyze.ts";
import { analysisInputIdentity, loadAnalyzeInput } from "./input.ts";
import { currentPrefilter } from "./prompts.ts";

/**
 * Runs the steps on the material as it is (or reuses their receipts) without writing business results.
 * `stages: "selection"` stops after the scores (SelectBench).
 */
export async function runAnalysis(a: AnalyzeInputArticle, opts: StepOpts & { stages?: "selection" | "all" } = {}): Promise<AnalysisRun> {
  checkAnalysisRunning();
  opts = { ...opts, layout: layoutOf(opts) };
  if (awaitsMaterial(a)) return { prefilter: null, scores: null, writing: null, structure: null };
  const prefilter = await runSelectionPrefilter(a, opts);
  return finishAnalysis(a, prefilter, opts);
}

async function finishAnalysis(
  a: AnalyzeInputArticle,
  prefilter: NonNullable<AnalysisRun["prefilter"]>,
  opts: StepOpts & { stages?: "selection" | "all" },
): Promise<AnalysisRun> {
  // UNKNOWN goes on like PASS; BLOCK stops here.
  if (prefilter.label === "BLOCK") return { prefilter, scores: null, writing: null, structure: null };
  // A title cannot support a paid score, fact extraction or invented summary. A later material revision resumes.
  if (awaitsMaterial(a)) return { prefilter, scores: null, writing: null, structure: null };
  if (opts.stages === "selection") {
    const scores = await runSelectionScores(a, opts);
    return { prefilter, scores, writing: null, structure: null };
  }
  // The structure step needs nothing from the scores: it runs beside them.
  const structure = runStructure(a, opts).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  try {
    const scores = await runSelectionScores(a, opts);
    const mean = scores && !scores.refused && scoreSettled(scores.values, scores.threshold, SCORE_CALLS) ? scoreMean(scores.values) : null;
    const near = mean !== null && (meetsThreshold(scores!.values, scores!.threshold) || mean > UNDERSTAND_FLOOR);
    const s = await structure;
    if ("error" in s) throw s.error;
    const original = originalPostCopy(a.xPost, a.url);
    const writing: NonNullable<AnalysisRun["writing"]> = original
      ? { kind: "verbatim", model: null, titleZh: original.title, summaryZh: original.summary ?? "", reasonZh: null, tags: null, receiptIds: [], reused: true }
      : await mendWording(a, (near ? await runUnderstand(a, opts) : null) ?? (await runSummarize(a, opts)), opts);
    return { prefilter, scores, writing, structure: s.value };
  } finally {
    // A score/writing error or deploy must not let the job finish while a paid structure request
    // still owns a response. It settles and stores its receipt before shutdown can close the DB.
    await structure;
  }
}

export interface AnalyzeResult {
  analysisId: number | null;
  stale: boolean;
  /** The article page is to be fetched first; nothing was committed. */
  needsBody?: boolean;
  /** An article (not a post) committed as waiting for material: under 20 characters, nothing paid. */
  awaitingBody?: boolean;
  output: ReturnType<typeof normalizeAnalysis> | null;
  receiptIds: number[];
  reused: boolean;
  /** A model wrote the copy but left the Chinese title or summary empty; the job asks for a rewrite (TASK-0594). */
  copyIncomplete?: boolean;
  /** How many earlier copies of this revision came back incomplete (the rewrite's number). */
  copyAttempt?: number;
}

/** Copy the model writers (not a verbatim post, not the no-material case) return without a usable title or summary. */
const incompleteModelCopy = (writer: unknown, titleZh: string | null, summaryZh: string | null) =>
  (writer === "understand" || writer === "summarize") && (!titleZh?.trim() || !summaryZh?.trim());

/**
 * Earlier judgements of this revision whose model copy came back incomplete. Each rewrite asks under the next number,
 * and a complete copy leaves the count where it was, so judging the revision again reuses the copy that worked.
 */
async function incompleteCopies(articleId: string, revision: number): Promise<number> {
  const rows = await sql<{ writer: string | null; title_zh: string | null; summary_zh: string | null }[]>`
    SELECT output->>'writer' AS writer, title_zh, summary_zh FROM analyses WHERE article_id=${articleId} AND input_revision=${revision}`;
  return rows.filter((r) => incompleteModelCopy(r.writer, r.title_zh, r.summary_zh)).length;
}

/** A judgement that went past the prefilter (it carries the scores, even when there were none to give). */
const isCompleteJudgement = (output: unknown) => !!output && typeof output === "object" && "scores" in output;

/**
 * Analyses the current revision and commits the judgement. A result computed for an older revision
 * is kept for traceability but never overwrites a newer input (stale = true).
 */
export async function analyzeArticle(articleId: string, opts: StepOpts = {}, afterScope?: () => Promise<unknown>): Promise<AnalyzeResult | null> {
  const runtimeControl = await runtimeControlSnapshot("news", ["processing"]);
  // One layout for every step of this run, and for the versions it records.
  const layout = layoutOf(opts),
    versions = promptVersionsFor(layout);
  opts = { ...opts, runtimeControl, layout };
  const input = await loadAnalyzeInput(articleId);
  if (!input) return null;
  const analysisVersion = analysisVersionOf(input, layout);
  if (opts.expectedRevision !== undefined && input.revision !== opts.expectedRevision)
    return { analysisId: null, stale: true, output: null, receiptIds: [], reused: true };
  // Its page first; extraction queues the analysis again (normally the queue already routed it there).
  if (waitsForPage(input)) return { analysisId: null, stale: false, needsBody: true, output: null, receiptIds: [], reused: true };
  checkAnalysisRunning();
  const copyAttempt = await incompleteCopies(articleId, input.revision);
  opts = {
    ...opts,
    copyAttempt,
    fallbackInput:
      awaitsMaterial(input) || (input.translationZh && !input.bodyText && !input.xPost)
        ? undefined
        : await prepareNewsFallback({
            root: shutdownSignal.signal,
            expected: analysisInputIdentity(input),
            current: async () => {
              const current = await loadAnalyzeInput(articleId);
              return current ? analysisInputIdentity(current) : null;
            },
            articles: [input],
          }),
  };
  try {
    const prefilter = awaitsMaterial(input) ? null : await runSelectionPrefilter(input, opts);
    if (prefilter) {
      // Commit scope separately: a later score/writing failure cannot erase confirmed admission.
      // Repeated attempts retain a complete current judgement instead of replacing it with an empty one: while this
      // revision is judged again, its last complete judgement keeps its copy, score and selection (BR-PUB-08), so only
      // a first judgement, a new revision or a change into or out of BLOCK is committed ahead of the rest.
      await sql.begin(async (tx) => {
        await lockNewsProcessingPermissions([articleId], tx);
        await assertRuntimeControl(tx, runtimeControl);
        const [latest] = await tx<
          { input_revision: number; prompt_version: string | null; output: unknown; receipt_ids: number[]; relevance: string | null }[]
        >`
      SELECT input_revision, prompt_version, output, receipt_ids, relevance FROM analyses WHERE article_id = ${articleId}
      ORDER BY input_revision DESC, id DESC LIMIT 1`;
        const settled =
          latest?.input_revision === input.revision && isCompleteJudgement(latest.output) && latest.relevance !== "block" && prefilter.label !== "BLOCK";
        if (
          !settled &&
          (currentPrefilter(latest, input.revision, versions.prefilter) !== prefilter.label || !latest?.receipt_ids.includes(prefilter.receiptId))
        ) {
          await tx`INSERT INTO analyses (article_id, input_revision, origin, model, prompt_version, receipt_ids, relevance, selected, output)
        VALUES (${articleId}, ${input.revision}, 'model', ${prefilter.model}, ${versions.prefilter}, ${[prefilter.receiptId]},
          ${prefilter.label.toLowerCase()}, false, ${tx.json({ prefilter: { label: prefilter.label, reason: prefilter.reason } })})`;
        }
        await completeReceipt(tx, prefilter.receiptId);
      });
      // The caller may publish now on the committed scope (a Chinese original need not wait for the writing).
      await afterScope?.();
    }
    const run = prefilter ? await finishAnalysis(input, prefilter, opts) : await runAnalysis(input, opts);
    const out = normalizeAnalysis(run);
    const receiptIds = [
      ...(run.prefilter ? [run.prefilter.receiptId] : []),
      ...(run.scores?.receiptIds ?? []),
      ...(run.writing?.receiptIds ?? []),
      ...(run.structure ? [run.structure.receiptId] : []),
    ];
    const w = run.writing;
    const detail = {
      prefilter: run.prefilter && { label: run.prefilter.label, reason: run.prefilter.reason },
      scores: out.scores,
      scoreModel: out.scoreModel,
      scoreModels: run.scores?.models ?? [],
      threshold: out.threshold,
      ...(out.scoreRefused ? { scoreRefused: true } : {}),
      ...(w ? { writer: w.kind, writerModel: w.model, itemType: w.itemType ?? null, authorRole: w.authorRole ?? null } : {}),
      ...(input.xPost && out.summaryZh && (w?.kind === "summarize" || w?.kind === "understand") ? { postSummaryKind: "summary" } : {}),
      ...(w?.postTranslation ? { postTranslation: { ...w.postTranslation, inputRevision: input.revision, receiptId: w.receiptIds[0] } } : {}),
      ...(w?.identityGuard?.outcome === "fallback" ? { identityGuard: w.identityGuard } : {}),
      ...(copyAttempt ? { copyAttempt } : {}),
      scope: out.scope,
      fact: out.fact,
      geography: out.geography,
      company_context: out.company_context,
    };
    const committed = await commitProcessingResult(
      articleId,
      input.revision,
      out.relevance === "block" ? "blocked" : "analyzed",
      async (tx) => {
        await assertRuntimeControl(tx, runtimeControl);
        const previousGroupingInput = await readGroupingAnalysis(articleId, input.revision, tx);
        // Enrichment owns the statement; content owns the locked transaction executing it.
        const insert = sql`
      INSERT INTO analyses (article_id, input_revision, origin, model, prompt_version, receipt_ids, relevance, category, tags,
        subjects, title_zh, summary_zh, reason_zh, score, selected, output)
      VALUES (${articleId}, ${input.revision}, 'model', ${w?.model ?? run.prefilter?.model ?? null}, ${analysisVersion}, ${receiptIds},
        ${out.relevance}, ${out.category}, ${out.tags}, ${out.subjects}, ${out.titleZh}, ${out.summaryZh}, ${out.reasonZh},
        ${out.score}, ${out.selected}, ${sql.json(detail as never)})
      RETURNING id`;
        const [row] = await tx<{ id: number }[]>`${insert}`;
        if (
          groupingAnalysisHash(previousGroupingInput) !==
          groupingAnalysisHash({ selected: out.selected, relevance: out.relevance, title_zh: out.titleZh, summary_zh: out.summaryZh, output: detail })
        )
          await beginMaterialGrouping(articleId, input.revision, true, tx);
        for (const id of receiptIds) await completeReceipt(tx, id);
        return row!.id;
      },
      async (tx) => {
        await lockNewsProcessingPermissions([articleId], tx);
        if (!detail.postTranslation) return;
        const policy = input.sourceId ? await readCurrentSourcePolicy(input.sourceId, tx) : null;
        if (!policy) {
          delete detail.postTranslation;
          return;
        }
        for (const url of new Set([input.url, ...(input.xPost?.quoted ? [input.xPost.quoted.url] : [])])) {
          const permission = await evaluateSourcePolicy(
            {
              source_id: policy.source_id,
              lane: "news",
              capability: "store_fulltext",
              expected_permission_version: policy.permission_version,
              resource: { url, attachment: false, document_type: null },
            },
            undefined,
            tx,
          );
          if (permission.decision !== "allow") {
            delete detail.postTranslation;
            break;
          }
        }
      },
    );
    const reused = (run.prefilter?.reused ?? true) && (run.scores?.reused ?? true) && (w?.reused ?? true) && (run.structure?.reused ?? true);
    const awaitingBody = !input.xPost && !run.prefilter && awaitsMaterial(input);
    const copyIncomplete = out.relevance !== "block" && incompleteModelCopy(w?.kind, out.titleZh, out.summaryZh);
    return {
      analysisId: committed.value,
      stale: committed.stale,
      output: out,
      receiptIds,
      reused,
      copyIncomplete,
      copyAttempt,
      ...(awaitingBody ? { awaitingBody } : {}),
    };
  } catch (error) {
    if (!(error instanceof ModelPostReceiptGuardError)) throw error;
    const current = await loadAnalyzeInput(articleId);
    if (!current || current.revision === input.revision) throw error;
    // Keep only a stale diagnostic and its real billing receipt; never recover the rejected model payload.
    const saved = await commitProcessingResult(
      articleId,
      input.revision,
      "analyzed",
      async (tx) => {
        const [row] = await tx<{ id: number }[]>`INSERT INTO analyses(article_id,input_revision,origin,prompt_version,receipt_ids,output)
        VALUES(${articleId},${input.revision},'model',${analysisVersion},${[error.receiptId]},${tx.json({ stale_after_response: true, output_applied: false })}) RETURNING id`;
        await completeReceipt(tx, error.receiptId);
        return row!.id;
      },
      (tx) => lockNewsProcessingPermissions([articleId], tx),
    );
    return { analysisId: saved.value, stale: true, output: null, receiptIds: [error.receiptId], reused: true };
  }
}
