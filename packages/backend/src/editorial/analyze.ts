import { readGroupingAnalysis, groupingAnalysisHash } from "../enrichment/records.ts";
import { modelSourceDate, modelSourceDateLabel } from "./source-time.ts";
import { beginMaterialGrouping } from "../content/grouping.ts";
export { latestPrefilterAuditJudgments, prefilterAuditAnalysisCopies } from "../enrichment/records.ts";
import { ModelContentFiltered } from "../providers/model-fallback.ts";
import { evaluateSourcePolicy, readCurrentSourcePolicy } from "../admin/sources.ts";
import { prepareNewsFallback, lockNewsProcessingPermissions, type NewsFallbackInput } from "../providers/news-fallback.ts";
import { runtimeControlSnapshot, assertRuntimeControl, type RuntimeControlSnapshot } from "../operations/lane-controls.ts";
// analyzeArticle: the judging and writing steps, each with its own rules from the industry pack
// (industry/prompts/), laid out per ANALYSIS_PROMPT_LAYOUT (analysis-layout.ts: one shared system prompt and material
// for every step by default, or each step's own prompt):
// Missing material waits before any model request.
//   1. prefilter: does the material belong to this industry at all (wide recall). Only BLOCK stops an
//      item; UNKNOWN goes on like PASS;
//   2. score: two independent scores against the source tier's threshold (industry/selection.ts) decide 精选;
//   3. writing: the Chinese title, summary and reason by the content understanding for selected and
//      near-selected items, by the cheaper title/summary prompts for the rest;
//   4. structure (no reader-facing text): category, tags, subject companies and the fact frame the
//      topics and the event grouping need; it runs beside the scoring.
// Material with only a title or a feed summary has its article page fetched before it is judged.
import { z } from "zod";
import { CATEGORY_KEYS, toPublicApiCategory, type CategoryKey } from "@amp/contracts/taxonomy";
/** For scripts that run in the production image, which installs @amp/backend but not @amp/contracts (scripts/eval-model-steps.ts). */
export { toPublicApiCategory };
import { CATEGORY_LABELS } from "@amp/industry/taxonomy";
import { wordingProblems } from "./wording.ts";
import { attentionScore, meetsThreshold, NOISE_TYPES, SELECTION, scoreMean, scoreSettled, type ScoreAxes } from "@amp/industry/selection";
import { analysisPromptLayout, config, isProduction, type AnalysisPromptLayout } from "../config.ts";
import { sql } from "../db.ts";
import { chatJson, chatUserText, modelSpecFor, ModelOutputError, ModelPostReceiptGuardError, type ChatPrefix, type ContentPart } from "../providers/llm.ts";
import { completeReceipt, ProviderRejectedError, ReceiptUnknownError } from "../providers/receipts.ts";
import { collapseWhitespace, normalizedUppercase, usableSourceText, originalPostCopy } from "../lib/text.ts";
import { modelFor } from "./models.ts";
import {
  buildMaterial,
  firstImagePart,
  firstInputImage,
  postEvidenceText,
  analysisInputIdentity,
  loadAnalyzeInput,
  type AnalyzeInputArticle,
} from "./input.ts";
import { pageFetchable } from "../content/extract.ts";
import { commitProcessingResult } from "../content/materials.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import {
  articlePromptContext,
  buildArticlePrompt,
  buildShortTweetPrompt,
  buildLongTweetPrompt,
  isShortTweetInput,
  needsShortTweetTranslation,
  finalizeCopy,
  looksZh,
  bodyWithin,
  SCORE_BODY_CHARS,
  missingEvidence,
  parseTranslateOutput,
  parseShortPostOutput,
  PREFILTER_SYSTEM,
  prefilterUser,
  publisherLines,
  translateInputOf,
  UNDERSTAND_SYSTEM,
  understandUser,
  type IdentityGuard,
} from "./writing.ts";
import { CATEGORY_TAGS, ENTITIES, ITEM_TYPES, normalizeTags } from "./vocabulary.ts";
import { currentPrefilter, promptText, promptVersion } from "./prompts.ts";
import { geographyMaterial, validateGeography, type NewsGeography } from "./geography.ts";
import {
  MEND_CONFIG,
  promptVersionsFor,
  SCORE_CONFIG,
  scoreStandardVersion,
  SHARED_ANALYSIS_SYSTEM,
  sharedMaterial,
  sharedRequest,
  sharedSystemWithScoreRules,
  STRUCTURE_CONFIG,
  type AnalysisStep,
} from "./analysis-layout.ts";
import { stableJson } from "../lib/ids.ts";
import { LEGACY_SUMMARY_MIN_CHARS, originalPostInputBlocked, verbatimAdmissionRequired } from "../lib/original-post-admission.ts";

export { buildMaterial, loadAnalyzeInput, type AnalyzeInputArticle };

const STRUCTURE_SYSTEM = promptText("structure", STRUCTURE_CONFIG);

/**
 * Every step's prompt version in the configured layout (ANALYSIS_PROMPT_LAYOUT, read on each access); the layouts'
 * versions differ, so receipts and judgements say which layout produced them. promptVersionsFor names one layout.
 */
export const PROMPT_VERSIONS: Readonly<Record<AnalysisStep, string>> = {
  get prefilter() {
    return promptVersionsFor(analysisPromptLayout()).prefilter;
  },
  get score() {
    return promptVersionsFor(analysisPromptLayout()).score;
  },
  get understand() {
    return promptVersionsFor(analysisPromptLayout()).understand;
  },
  get summarize() {
    return promptVersionsFor(analysisPromptLayout()).summarize;
  },
  get wording() {
    return promptVersionsFor(analysisPromptLayout()).wording;
  },
  get structure() {
    return promptVersionsFor(analysisPromptLayout()).structure;
  },
};
export { promptVersionsFor, scoreStandardVersion };
/** The selection steps' prompts (prefilter and score), as stored on each judgement. */
export const selectionPromptVersion = (layout: AnalysisPromptLayout = analysisPromptLayout()) =>
  [promptVersionsFor(layout).prefilter, promptVersionsFor(layout).score].join("+");
/** Every step's prompt, as stored on each judgement. */
export const analyzePromptVersion = (layout: AnalysisPromptLayout = analysisPromptLayout()) => Object.values(promptVersionsFor(layout)).join("+");
const POST_SUMMARIZE_PROMPT_VERSION = () =>
  promptVersion("summarize-short-post", "summarize-short-post-quoted", "summarize-long-post", "summarize-long-post-quoted", "identity-context");
export const analysisVersionOf = (a: Pick<AnalyzeInputArticle, "xPost">, layout: AnalysisPromptLayout = analysisPromptLayout()) =>
  a.xPost ? `${analyzePromptVersion(layout)}+${POST_SUMMARIZE_PROMPT_VERSION()}` : analyzePromptVersion(layout);

// ── Scoring ───────────────────────────────────────────────────────────────────────────────

/**
 * At most this many independent score calls per article; their mean decides and is shown to one decimal.
 * A first score far from the threshold (SELECTION.secondScoreMargin) settles alone (Owner 2026-11-05, cost).
 */
export const SCORE_CALLS = 2;

/**
 * The thresholds on the mean score, per source tier (industry/selection.ts): selected when
 * score1 + score2 >= 2 × threshold. Tiers without a threshold are not scored for 精选.
 */
export function tierThreshold(tier: string): number | null {
  if (!scoringConfirmed()) return null;
  return draftTierThreshold(tier);
}

/** The same threshold without the release-version gate: evaluations always run the scoring prompt as it is. */
export function draftTierThreshold(tier: string): number | null {
  return SELECTION.thresholds[tier] ?? null;
}

/**
 * Release-version gate: production scores only the exact validated prompt bound by
 * SELECTION_CONFIRMED_VERSION. Rule changes require Owner confirmation under Issue #293.
 * Development, tests and evaluations (draftTierThreshold) run the draft.
 */
export function scoringConfirmed(production = isProduction, confirmed = config.selectionConfirmedVersion): boolean {
  return !production || confirmed === PROMPT_VERSIONS.score;
}

/** Unselected items above this mean are written like selected ones. */
export const UNDERSTAND_FLOOR = SELECTION.understandFloor;

/**
 * Call parameters per score model. The GLM scorer runs at temperature 1 with high reasoning (the model
 * registry adds top_p and thinking) and up to 180 s per call.
 */
const SCORE_CALL: Record<string, { temperature: number; maxTokens: number; timeoutMs: number }> = {
  "glm-5.3-flash-selection": { temperature: 1, maxTokens: 65_536, timeoutMs: 180_000 },
};
const scoreCall = (model: string) => SCORE_CALL[model] ?? { temperature: 0.2, maxTokens: 1024, timeoutMs: 120_000 };

/** The score prompt: the industry's taste (industry/prompts/selection-score.md). */
export const SCORE_SYSTEM = promptText("selection-score", SCORE_CONFIG);

const axis = z.coerce.number().min(0).max(10);
/** The model judges the type and five axes (0–10, one decimal); code weighs them into the 0–100 score (industry/selection.ts). */
export const ScoreSchema = z.object({
  type: z.enum(CATEGORY_KEYS),
  sig: axis,
  nov: axis,
  cred: axis,
  reson: axis,
  act: axis,
  materialUnusable: z.boolean().catch(false).default(false),
  noise: z.enum(NOISE_TYPES).catch("none").default("none"),
});
const tenth = (value: number) => Math.round(value * 10) / 10;

const SCORE_TIME = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** The score input's time: Beijing time, ISO 8601 with +08:00 (the form the prompt was tuned on). */
export function scoreInputTime(at: Date): string {
  const ms = at.getTime() % 1000;
  return `${SCORE_TIME.format(at).replace(" ", "T")}${ms ? `.${String(ms).padStart(3, "0")}` : ""}+08:00`;
}

/** One analysis request in a layout: the system prompt, the shared material (shared layout only) and the step message. */
type StepRequest = { system: string; prefix?: ChatPrefix; user: string };
const layoutOf = (opts: { layout?: AnalysisPromptLayout }) => opts.layout ?? analysisPromptLayout();
/** The source and link lines the prefilter and the content understanding read in the shared layout's step message. */
const publisherContext = (a: AnalyzeInputArticle) => [...publisherLines(a), `【原文链接】${a.url}`].join("\n");

/**
 * The score input: no publisher hints, the confirmed original date with its actual precision, the
 * original title (items are scored before any Chinese copy exists) and the whole body. The shared layout's material
 * carries no publisher either, and its score instruction adds none.
 */
function scoreRequest(a: AnalyzeInputArticle, layout: AnalysisPromptLayout): StepRequest {
  if (layout === "shared") return sharedRequest(sharedMaterial(a), "score");
  let body = a.xPost ? postEvidenceText(a.xPost) : usableSourceText(a.bodyText, a.excerpt).trim();
  if (!body) body = a.title;
  return {
    system: SCORE_SYSTEM,
    user: [
      "请按系统规则评估以下单篇材料所代表的事件。只输出内容类型、五轴分和噪声类型。",
      `【原文时间】\n${modelSourceDateLabel(a)}`,
      `【标题】\n${a.title.trim()}`,
      `【完整正文】\n${bodyWithin(body, SCORE_BODY_CHARS)}`,
    ].join("\n\n"),
  };
}
/** Everything the scorer reads besides the system prompt, as one text (its request's userHash; SelectBench's sample input). */
export const buildScoreInput = (a: AnalyzeInputArticle, layout: AnalysisPromptLayout = analysisPromptLayout()) => chatUserText(scoreRequest(a, layout));

function prefilterRequest(a: AnalyzeInputArticle, layout: AnalysisPromptLayout): StepRequest {
  return layout === "shared"
    ? sharedRequest(sharedMaterial(a), "prefilter", { context: publisherContext(a) })
    : { system: PREFILTER_SYSTEM, user: prefilterUser(a) };
}
/** The system prompt a selection step sends in a layout. */
export const selectionSystem = (step: "prefilter" | "score", layout: AnalysisPromptLayout = analysisPromptLayout()) =>
  layout === "shared" ? SHARED_ANALYSIS_SYSTEM : step === "prefilter" ? PREFILTER_SYSTEM : SCORE_SYSTEM;

/**
 * A selection step's request as production sends it, for evaluations that send it themselves; `scoreRules` replaces
 * the score rules (a rules experiment), leaving the rest of the layout as it is.
 */
export function selectionStepRequest(
  step: "prefilter" | "score",
  a: AnalyzeInputArticle,
  layout: AnalysisPromptLayout = analysisPromptLayout(),
  scoreRules?: string,
): StepRequest {
  if (step === "prefilter") return prefilterRequest(a, layout);
  const request = scoreRequest(a, layout);
  if (scoreRules === undefined) return request;
  return { ...request, system: layout === "shared" ? sharedSystemWithScoreRules(scoreRules) : scoreRules };
}

/** Everything the prefilter reads besides the system prompt, as one text (its request's userHash). */
export const prefilterInput = (a: AnalyzeInputArticle, layout: AnalysisPromptLayout = analysisPromptLayout()) => chatUserText(prefilterRequest(a, layout));

// ── Step outputs ──────────────────────────────────────────────────────────────────────────

const PrefilterSchema = z.object({
  label: z.preprocess(normalizedUppercase, z.enum(["PASS", "BLOCK", "UNKNOWN"])),
  reason: z.string().max(200).catch(""),
});

const FactSchema = z
  .object({
    title: z.string().max(80),
    subject: z.string().max(80).nullable().optional(),
    action: z.string().max(80).nullable().optional(),
    object: z.string().max(160).nullable().optional(),
    occurredAt: z.string().nullable().optional(),
  })
  .nullable()
  .catch(null);

export const StructureSchema = z.object({
  scope: z.enum(["single", "composite", "unknown"]).catch("unknown"),
  category: z.enum(CATEGORY_KEYS).nullable().catch(null),
  tags: z.array(z.string()).max(12).catch([]),
  subjects: z.array(z.string()).max(6).catch([]),
  fact: FactSchema,
  geography: z.unknown().optional(),
  company_context: z
    .array(
      z.object({
        entityId: z.string(),
        name: z.string().max(160),
        originalName: z.string().max(160),
        description: z.string().max(1200),
        quote: z.string().max(1600),
        sources: z.array(z.object({ name: z.string().max(160), url: z.url() })).max(5),
      }),
    )
    .max(6)
    .catch([]),
});

const UnderstandSchema = z.object({
  itemType: z.enum(ITEM_TYPES),
  authorRole: z.enum(["principal", "observer", "relayer"]).catch("relayer"),
  tags: z.array(z.string()).max(12).catch([]),
  editorialJudgment: z.string().max(400).catch(""),
  titleZh: z.string().trim().min(1).max(200),
  summaryZh: z.string().trim().min(1).max(4000),
});

const SummarizeSchema = z.object({ titleZh: z.string(), summaryZh: z.string(), bodyZh: z.string() });

export interface AnalysisRun {
  /** Null means no prefilter request was made; it is not an UNKNOWN model answer. */
  prefilter: { label: "PASS" | "BLOCK" | "UNKNOWN"; reason: string; model: string; receiptId: number; reused: boolean } | null;
  /**
   * The independent score calls and the tier threshold they are held against; absent when the material
   * is not scored. `refused`: the model's content filter declined it, so it is not selected.
   */
  scores: {
    model: string;
    models?: string[];
    threshold: number;
    values: number[];
    axes?: ScoreAxes[];
    receiptIds: number[];
    reused: boolean;
    refused?: boolean;
  } | null;
  /** The reader-facing copy; `verbatim` reserves original-post copy without a writer call. */
  writing: {
    kind: "understand" | "summarize" | "verbatim" | "none";
    model: string | null;
    titleZh: string;
    summaryZh: string;
    reasonZh: string | null;
    tags: string[] | null;
    itemType?: string;
    authorRole?: string;
    identityGuard?: IdentityGuard;
    /** Private writer output; never a summary or a complete translate-body manifest. */
    postTranslation?: { textZh: string; recipe: string };
    receiptIds: number[];
    reused: boolean;
  } | null;
  structure: {
    scope?: "single" | "composite" | "unknown";
    model: string;
    category: string | null;
    tags: string[];
    subjects: string[];
    fact: z.infer<typeof FactSchema>;
    geography: NewsGeography;
    company_context: z.infer<typeof StructureSchema>["company_context"];
    receiptId: number;
    reused: boolean;
  } | null;
}

const isContentFilter = (error: unknown) =>
  error instanceof ModelContentFiltered || (error instanceof ProviderRejectedError && !error.retryable && /contentFilter|"1301"/.test(error.message));

/** Only a title or a feed summary, and a page to fetch: the article is judged on the page. */
export function waitsForPage(a: AnalyzeInputArticle): boolean {
  return !a.xPost && a.bodyStatus === "pending" && !a.bodyText && pageFetchable(a.url, a.source.kind);
}

export const awaitsMaterial = (a: AnalyzeInputArticle) => originalPostInputBlocked(a.xPost) || (missingEvidence(a) && !originalPostCopy(a.xPost, a.url));

type StepOpts = {
  expectedRevision?: number;
  usagePurpose?: "production" | "evaluation";
  attemptTag?: string;
  scoreModel?: string;
  /** Evaluation only (scripts/eval-model-steps.ts): another model for this one step; production keeps its route. */
  prefilterModel?: string;
  structureModel?: string;
  runtimeControl?: RuntimeControlSnapshot;
  fallbackInput?: NewsFallbackInput;
  /** The prompt layout of every step; defaults to the configured one (ANALYSIS_PROMPT_LAYOUT). */
  layout?: AnalysisPromptLayout;
};
type ReceiptObserver = (receiptId: number) => void;
export class AnalysisInterruptedError extends Error {}

const observableReceiptId = (error: unknown): number | null =>
  error instanceof ModelOutputError || error instanceof ReceiptUnknownError || error instanceof ModelContentFiltered ? error.receiptId : null;

function checkAnalysisRunning() {
  if (shutdownSignal.signal.aborted) throw new AnalysisInterruptedError("worker shutting down between analysis stages");
}

const subjectOf = (a: AnalyzeInputArticle) => `article:${a.id}@${a.revision}`;
const tagged = (attemptTag: string | undefined, step: string) => [attemptTag, step].filter(Boolean).join(":") || undefined;
const stepModel = (override: string | undefined, opts: StepOpts, step: "prefilter" | "structure") => {
  if (override === undefined) return modelFor(step);
  if (opts.usagePurpose !== "evaluation") throw new Error("A per-step model override is for evaluation only");
  return override;
};

async function runPrefilter(a: AnalyzeInputArticle, opts: StepOpts): Promise<NonNullable<AnalysisRun["prefilter"]>> {
  const model = await stepModel(opts.prefilterModel, opts, "prefilter");
  checkAnalysisRunning();
  const layout = layoutOf(opts),
    request = prefilterRequest(a, layout);
  const res = await chatJson({
    model,
    purpose: "prefilter_article",
    subject: subjectOf(a),
    sourceIds: a.sourceId ? [a.sourceId] : [],
    promptVersion: promptVersionsFor(layout).prefilter,
    ...request,
    usagePurpose: opts.usagePurpose,
    fallbackPermit: opts.fallbackInput?.(request),
    schema: PrefilterSchema,
    temperature: 0,
    maxTokens: 512,
    attemptTag: opts.attemptTag,
    runtimeControl: opts.runtimeControl,
  });
  // A BLOCK without material to back it counts as UNKNOWN (which goes on).
  const label = res.data.label === "BLOCK" && missingEvidence(a) ? "UNKNOWN" : res.data.label;
  return { label, reason: res.data.reason, model: res.model, receiptId: res.receiptId, reused: res.reused };
}

/** The production prefilter step, exposed separately so SelectBench can preserve partial receipt evidence. */
export async function runSelectionPrefilter(
  a: AnalyzeInputArticle,
  opts: StepOpts = {},
  onReceipt?: ReceiptObserver,
): Promise<NonNullable<AnalysisRun["prefilter"]>> {
  if (originalPostInputBlocked(a.xPost)) throw new Error("原帖新增准入尚未开启，等待可用正文");
  try {
    const result = await runPrefilter(a, opts);
    onReceipt?.(result.receiptId);
    return result;
  } catch (error) {
    const receiptId = observableReceiptId(error);
    if (receiptId !== null) onReceipt?.(receiptId);
    throw error;
  }
}

async function runScores(a: AnalyzeInputArticle, threshold: number, opts: StepOpts, onReceipt?: ReceiptObserver): Promise<NonNullable<AnalysisRun["scores"]>> {
  const model = opts.scoreModel ?? (await modelFor("score"));
  const call = scoreCall(model);
  const layout = layoutOf(opts),
    request = scoreRequest(a, layout);
  const values: number[] = [];
  const axes: ScoreAxes[] = [];
  const receiptIds: number[] = [];
  const models: string[] = [];
  let reused = true;
  // Sequential independent scores share identical input; provider prefix reuse remains best-effort.
  for (let i = 0; i < SCORE_CALLS; i++) {
    checkAnalysisRunning();
    try {
      const res = await chatJson({
        model,
        purpose: "score_article",
        subject: subjectOf(a),
        sourceIds: a.sourceId ? [a.sourceId] : [],
        promptVersion: promptVersionsFor(layout).score,
        ...request,
        usagePurpose: opts.usagePurpose,
        fallbackPermit: opts.fallbackInput?.(request),
        schema: ScoreSchema,
        temperature: call.temperature,
        maxTokens: call.maxTokens,
        timeoutMs: call.timeoutMs,
        // Each call is its own paid request; an explicit re-evaluation gets new ones.
        attemptTag: tagged(opts.attemptTag, `score-${i + 1}`),
        runtimeControl: opts.runtimeControl,
      });
      onReceipt?.(res.receiptId);
      const judged: ScoreAxes = {
        ...res.data,
        sig: tenth(res.data.sig),
        nov: tenth(res.data.nov),
        cred: tenth(res.data.cred),
        reson: tenth(res.data.reson),
        act: tenth(res.data.act),
      };
      axes.push(judged);
      values.push(attentionScore(judged));
      models.push(res.model);
      receiptIds.push(res.receiptId);
      reused &&= res.reused;
      if (scoreSettled(values, threshold, SCORE_CALLS)) break;
    } catch (error) {
      const receiptId = observableReceiptId(error);
      if (receiptId !== null) onReceipt?.(receiptId);
      // The model's content filter declines the material (Zhipu 1301): not scored, so not selected.
      if (isContentFilter(error)) {
        if (receiptId !== null) receiptIds.push(receiptId);
        return { model: [...new Set(models)].join("+") || model, models, threshold, values, axes, receiptIds, reused: false, refused: true };
      }
      throw error;
    }
  }
  return { model: [...new Set(models)].join("+"), models, threshold, values, axes, receiptIds, reused };
}

/**
 * The production score step; its threshold stays case-specific even when an evaluator shares model output.
 * Evaluations pass the draft's threshold (draftTierThreshold); production keeps the release-version gate.
 */
export async function runSelectionScores(
  a: AnalyzeInputArticle,
  opts: StepOpts = {},
  onReceipt?: ReceiptObserver,
  threshold: number | null = tierThreshold(a.source.tier),
): Promise<AnalysisRun["scores"]> {
  if (originalPostInputBlocked(a.xPost)) throw new Error("原帖新增准入尚未开启，等待可用正文");
  return threshold === null ? null : runScores(a, threshold, opts, onReceipt);
}

async function runStructure(a: AnalyzeInputArticle, opts: StepOpts): Promise<NonNullable<AnalysisRun["structure"]>> {
  const model = await stepModel(opts.structureModel, opts, "structure");
  checkAnalysisRunning();
  const layout = layoutOf(opts);
  const source = { name: a.source.name, kind: a.source.kind, firstParty: a.source.firstParty };
  let request: StepRequest, material: ReturnType<typeof geographyMaterial>;
  if (layout === "shared") {
    // The evidence segments are numbered in the shared material at the full geography budget; the step message holds
    // the metadata that is no geography evidence.
    const shared = sharedMaterial(a);
    material = shared.geography;
    request = sharedRequest(shared, "structure", { context: stableJson({ source, url: a.url, complete_material: material.complete }) });
  } else {
    const inputFor = (m: ReturnType<typeof geographyMaterial>) =>
      stableJson({ source, url: a.url, sourceTime: modelSourceDate(a), segments: m.segments, complete_material: m.complete });
    material = geographyMaterial(a);
    let user = inputFor(material),
      overflow = Buffer.byteLength(STRUCTURE_SYSTEM + user) - 32000;
    if (overflow > 0) {
      const bodyBudget = 22000 - overflow - 128;
      if (bodyBudget < 1024) throw new ModelOutputError("Bounded structure metadata exceeds capacity");
      material = geographyMaterial(a, bodyBudget);
      user = inputFor(material);
    }
    if (Buffer.byteLength(STRUCTURE_SYSTEM + user) > 32000) throw new ModelOutputError("Bounded structure input exceeds capacity");
    request = { system: STRUCTURE_SYSTEM, user };
  }
  const res = await chatJson({
    model,
    purpose: "structure_article",
    subject: subjectOf(a),
    sourceIds: a.sourceId ? [a.sourceId] : [],
    promptVersion: promptVersionsFor(layout).structure,
    ...request,
    usagePurpose: opts.usagePurpose,
    fallbackPermit: opts.fallbackInput?.(request),
    schema: StructureSchema,
    temperature: 0.2,
    maxTokens: 1500,
    attemptTag: tagged(opts.attemptTag, "structure"),
    runtimeControl: opts.runtimeControl,
  });
  const subjects = [...new Set(res.data.subjects.map((s) => s.trim().toLowerCase()).filter((s) => s in ENTITIES))];
  return {
    model: res.model,
    category: res.data.category,
    tags: normalizeTags(res.data.tags),
    subjects,
    scope: res.data.scope,
    fact: res.data.scope === "composite" ? null : res.data.fact,
    geography: validateGeography(res.data.geography, a, material.bodyBudget),
    company_context: res.data.company_context,
    receiptId: res.receiptId,
    reused: res.reused,
  };
}

/** The structure step with its full result, exposed like runSelectionPrefilter for step evaluations. */
export async function runSelectionStructure(
  a: AnalyzeInputArticle,
  opts: StepOpts = {},
  onReceipt?: ReceiptObserver,
): Promise<NonNullable<AnalysisRun["structure"]>> {
  if (originalPostInputBlocked(a.xPost)) throw new Error("原帖新增准入尚未开启，等待可用正文");
  try {
    const result = await runStructure(a, opts);
    onReceipt?.(result.receiptId);
    return result;
  } catch (error) {
    const receiptId = observableReceiptId(error);
    if (receiptId !== null) onReceipt?.(receiptId);
    throw error;
  }
}

/**
 * The structure step alone, for reclassifying an existing judgement (ADR-0031): the same prompt, model route,
 * receipt and runtime controls as analysis, so a later analysis of the same revision reuses the receipt.
 */
export async function runCategoryStructure(
  a: AnalyzeInputArticle,
  opts: Pick<StepOpts, "runtimeControl" | "usagePurpose"> = {},
): Promise<{ category: CategoryKey | null; model: string; receiptId: number; reused: boolean }> {
  checkAnalysisRunning();
  if (awaitsMaterial(a) || (a.translationZh && !a.bodyText && !a.xPost)) throw new Error("material is not ready for a structure request");
  // The same current-material permit as analyzeArticle: a changed revision or permission stops the request.
  const fallbackInput = await prepareNewsFallback({
    root: shutdownSignal.signal,
    expected: analysisInputIdentity(a),
    current: async () => {
      const current = await loadAnalyzeInput(a.id);
      return current ? analysisInputIdentity(current) : null;
    },
    articles: [a],
  });
  const s = await runStructure(a, { ...opts, fallbackInput });
  return { category: toPublicApiCategory(s.category), model: s.model, receiptId: s.receiptId, reused: s.reused };
}

/** The content understanding; null when the model's content filter declines the material. */
async function runUnderstand(a: AnalyzeInputArticle, opts: StepOpts): Promise<AnalysisRun["writing"]> {
  const model = await modelFor("understand");
  const layout = layoutOf(opts);
  const quoted = a.xPost?.quoted?.text
    ? `\n【引用说明】资料正文中“[引用 ${a.xPost.quoted.handle ? `@${a.xPost.quoted.handle}` : "原帖"}]：”之后是作者转发/引用的他人内容，不是作者本人的产出。`
    : "";
  const { user: text, ...lead }: StepRequest =
    layout === "shared"
      ? sharedRequest(sharedMaterial(a), "understand", { context: publisherContext(a) + quoted })
      : { system: UNDERSTAND_SYSTEM, user: understandUser(a) };
  const call = (image: ContentPart | null) => {
    checkAnalysisRunning();
    // The image goes with the step message, after the shared leading messages.
    const request = { ...lead, user: image ? [{ type: "text" as const, text }, image] : text };
    return chatJson({
      model,
      purpose: "understand_article",
      subject: subjectOf(a),
      sourceIds: a.sourceId ? [a.sourceId] : [],
      promptVersion: promptVersionsFor(layout).understand,
      ...request,
      usagePurpose: opts.usagePurpose,
      fallbackPermit: opts.fallbackInput?.(request),
      beforeRequest: image
        ? async () => {
            const url = firstInputImage(a)?.url;
            if (!a.sourceId || !url) throw new Error("图片原材料身份缺失");
            const policy = await readCurrentSourcePolicy(a.sourceId);
            if (!policy) throw new Error("图片原材料许可缺失");
            const permit = await evaluateSourcePolicy({
              source_id: a.sourceId,
              lane: "news",
              capability: "external_model",
              expected_permission_version: policy.permission_version,
              resource: { url: String(url), attachment: true, document_type: null },
            });
            if (permit.decision !== "allow") throw new Error("图片外部模型许可已变化");
          }
        : undefined,
      schema: UnderstandSchema,
      temperature: 0.2,
      maxTokens: 16_384,
      timeoutMs: 180_000,
      attemptTag: tagged(opts.attemptTag, "understand"),
      runtimeControl: opts.runtimeControl,
    });
  };
  // A model that is known not to read images gets the text only.
  const image = (await modelSpecFor(model))?.vision === false ? null : await firstImagePart(a);
  let res: Awaited<ReturnType<typeof call>>;
  try {
    res = await call(image);
  } catch (error) {
    if (isContentFilter(error)) return null;
    // The model refused the image (download, format): the text is written without it.
    if (!image || !(error instanceof ProviderRejectedError) || error.retryable) throw error;
    try {
      res = await call(null);
    } catch (retryError) {
      if (isContentFilter(retryError)) return null;
      throw retryError;
    }
  }
  const d = res.data;
  const copy = finalizeCopy(translateInputOf(a), { titleZh: d.titleZh, summaryZh: d.summaryZh });
  return {
    kind: "understand",
    model: res.model,
    titleZh: copy.titleZh,
    summaryZh: copy.summaryZh,
    reasonZh: d.editorialJudgment.trim() || null,
    tags: normalizeTags(d.tags),
    itemType: d.itemType,
    authorRole: d.authorRole,
    identityGuard: copy.identityGuard,
    receiptIds: [res.receiptId],
    reused: res.reused,
  };
}

export const MEND_SYSTEM = promptText("mend-wording", MEND_CONFIG);
const MendSchema = z.object({ titleZh: z.string().trim().min(1), summaryZh: z.string().trim().min(1), reasonZh: z.string().trim().nullable().catch(null) });

/**
 * Written copy that uses a word the site keeps from its readers (industry/wording.ts) goes back once, those words
 * named, to change only them: a site's writing prompts can ask the same, but a model keeps drifting back to the
 * words it uses most. The mended copy keeps the
 * identity guard and is used only when it leaves fewer such words and the same numbers.
 */
async function mendWording(a: AnalyzeInputArticle, w: NonNullable<AnalysisRun["writing"]>, opts: StepOpts): Promise<NonNullable<AnalysisRun["writing"]>> {
  // A copy missing its title or summary waits for a whole one (normalizeAnalysis): nothing to mend, and no text to
  // let a model without the material fill in.
  if ((w.kind !== "understand" && w.kind !== "summarize") || !w.titleZh || !w.summaryZh) return w;
  const problems = wordingProblems(w);
  if (!problems.length) return w;
  const t = translateInputOf(a);
  const user = [
    `来源：${t.sourceName ?? "（未注明）"}`,
    `原题：${t.title}`,
    `中文稿：\n${JSON.stringify({ titleZh: w.titleZh, summaryZh: w.summaryZh, reasonZh: w.reasonZh })}`,
    `问题：\n${problems.map((p) => `- ${p}`).join("\n")}`,
  ].join("\n\n");
  const layout = layoutOf(opts);
  const request: StepRequest = layout === "shared" ? sharedRequest(sharedMaterial(a), "wording", { draft: user }) : { system: MEND_SYSTEM, user };
  checkAnalysisRunning();
  let res: Awaited<ReturnType<typeof chatJson<typeof MendSchema>>>;
  try {
    res = await chatJson({
      sourceIds: a.sourceId ? [a.sourceId] : [],
      usagePurpose: opts.usagePurpose,
      runtimeControl: opts.runtimeControl,
      model: await modelFor("wording"),
      purpose: "mend_wording",
      subject: subjectOf(a),
      promptVersion: promptVersionsFor(layout).wording,
      ...request,
      fallbackPermit: opts.fallbackInput?.(request),
      schema: MendSchema,
      temperature: 0.1,
      maxTokens: 2048,
      attemptTag: tagged(opts.attemptTag, "wording"),
    });
  } catch (error) {
    // An answer that is not the copy asked for, or a refusal the same request would meet again (each provider words
    // its own), leaves the first copy: a mend that cannot be had must not hold the item back. Its receipt stays failed
    // (seen on the runs page, and asked again the next time the item is analysed); a busy provider is tried again later.
    if (isContentFilter(error) || error instanceof ModelOutputError || (error instanceof ProviderRejectedError && !error.retryable)) return w;
    throw error;
  }
  const copy = finalizeCopy(t, { titleZh: res.data.titleZh, summaryZh: res.data.summaryZh });
  const mended = { titleZh: copy.titleZh, summaryZh: copy.summaryZh, reasonZh: w.reasonZh === null ? null : res.data.reasonZh || w.reasonZh };
  const paid = { receiptIds: [...w.receiptIds, res.receiptId], reused: w.reused && res.reused };
  // A guard that emptied the title or summary (a company the input does not name), a number changed or dropped, or
  // no fewer such words: the first copy stands.
  const numbers = (c: { titleZh: string; summaryZh: string; reasonZh: string | null }) =>
    (`${c.titleZh} ${c.summaryZh} ${c.reasonZh ?? ""}`.match(/\d+(?:[.,]\d+)*/g) ?? []).sort().join(" ");
  if (!mended.titleZh || !mended.summaryZh || numbers(mended) !== numbers(w) || wordingProblems(mended).length >= problems.length) return { ...w, ...paid };
  return { ...w, ...mended, identityGuard: copy.identityGuard ?? w.identityGuard, ...paid };
}

/** The gateway retains responses, so a full translated copy must be allowed before it is requested. */
async function mayStorePostTranslation(a: AnalyzeInputArticle) {
  if (!a.sourceId || !a.xPost) return false;
  const policy = await readCurrentSourcePolicy(a.sourceId);
  if (!policy) return false;
  for (const url of new Set([a.url, ...(a.xPost.quoted ? [a.xPost.quoted.url] : [])])) {
    const permission = await evaluateSourcePolicy({
      source_id: a.sourceId,
      lane: "news",
      capability: "store_fulltext",
      expected_permission_version: policy.permission_version,
      resource: { url, attachment: false, document_type: null },
    });
    if (permission.decision !== "allow") return false;
  }
  return true;
}

/** The title/summary prompt for the items the content understanding does not write. */
async function runSummarize(a: AnalyzeInputArticle, opts: StepOpts): Promise<NonNullable<AnalysisRun["writing"]>> {
  const t = translateInputOf(a);
  const plain = { reasonZh: null, tags: null, receiptIds: [] as number[], reused: true };
  const short = isShortTweetInput(t),
    main = collapseWhitespace(t.mainText || t.title);
  const chineseShort = short && !needsShortTweetTranslation(main);
  if (chineseShort && (config.originalPostAdmissionEnabled || !verbatimAdmissionRequired(main)))
    return { kind: "verbatim", model: null, titleZh: main, summaryZh: main, ...plain };
  // Too little text is not written up from a title.
  if ((!short || (chineseShort && !config.originalPostAdmissionEnabled)) && t.text.trim().length < LEGACY_SUMMARY_MIN_CHARS)
    return { kind: "none", model: null, titleZh: looksZh(t.title) ? t.title : "", summaryZh: "", ...plain };
  const shortTranslation = short && (await mayStorePostTranslation(a));
  const model = await modelFor("summarize");
  const layout = layoutOf(opts);
  // Posts keep their own prompts in both layouts (the post inline; the short-post translation is bound to them).
  const request: StepRequest = a.xPost
    ? { system: "", user: shortTranslation ? buildShortTweetPrompt(t) : buildLongTweetPrompt(t) }
    : layout === "shared"
      ? sharedRequest(sharedMaterial(a), "summarize", {
          ...articlePromptContext(t),
          emptyBody: t.text ? "" : `\n${promptText("summarize-article-empty")}`,
        })
      : { system: "", user: buildArticlePrompt(t) };
  checkAnalysisRunning();
  const res = await chatJson({
    model,
    purpose: "summarize_article",
    subject: subjectOf(a),
    sourceIds: a.sourceId ? [a.sourceId] : [],
    promptVersion: a.xPost ? POST_SUMMARIZE_PROMPT_VERSION() : promptVersionsFor(layout).summarize,
    ...request,
    usagePurpose: opts.usagePurpose,
    fallbackPermit: opts.fallbackInput?.(request),
    ...(shortTranslation
      ? {
          beforeRequest: async () => {
            if (!(await mayStorePostTranslation(a))) throw new Error("原帖译文保存许可已收紧");
          },
        }
      : {}),
    schema: SummarizeSchema,
    json: false,
    parse: shortTranslation ? parseShortPostOutput : parseTranslateOutput,
    temperature: 0.2,
    maxTokens: 2048,
    attemptTag: tagged(opts.attemptTag, "summarize"),
    runtimeControl: opts.runtimeControl,
  });
  const p = res.data;
  const draft = short
    ? { titleZh: p.titleZh || (looksZh(main) ? main : ""), summaryZh: p.summaryZh }
    : a.xPost
      ? { titleZh: p.titleZh, summaryZh: p.summaryZh }
      : { titleZh: p.titleZh || (looksZh(t.title) ? t.title : ""), summaryZh: p.summaryZh };
  const copy = finalizeCopy(t, draft);
  return {
    kind: "summarize",
    model: res.model,
    titleZh: copy.titleZh,
    summaryZh: copy.summaryZh,
    reasonZh: null,
    tags: null,
    identityGuard: copy.identityGuard,
    ...(shortTranslation && p.bodyZh ? { postTranslation: { textZh: p.bodyZh, recipe: POST_SUMMARIZE_PROMPT_VERSION() } } : {}),
    receiptIds: [res.receiptId],
    reused: res.reused,
  };
}

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

/** One judgement from the steps: the selection rule, the reader-facing copy and the structure. */
export function normalizeAnalysis(run: AnalysisRun) {
  const label = run.prefilter?.label;
  const titleZh = collapseWhitespace(run.writing?.titleZh ?? "");
  const summaryZh = (run.writing?.summaryZh ?? "").trim();
  const unapprovedCopy = !config.originalPostAdmissionEnabled && run.writing?.kind === "verbatim" && verbatimAdmissionRequired(summaryZh);
  // Past the prefilter (PASS or UNKNOWN) an item is relevant. Writing that gives no usable Chinese title and
  // summary leaves it without copy of its own ("unknown", waiting for material); a Chinese original from a
  // full-text source still shows its source excerpt, since publication only keeps a BLOCK out.
  const relevance =
    label === "BLOCK"
      ? "block"
      : unapprovedCopy || (run.writing ? !titleZh || (!summaryZh && run.writing.kind !== "verbatim") : !run.scores)
        ? "unknown"
        : "pass";
  // Selected when the mean of the scores taken reaches the tier threshold; that mean, to one decimal, is the
  // score shown. One score stands alone only when it is far from the threshold (scoreSettled).
  const threshold = run.scores?.threshold ?? null;
  const values = run.scores && !run.scores.refused && threshold !== null && scoreSettled(run.scores.values, threshold, SCORE_CALLS) ? run.scores.values : null;
  const score = scoreMean(values);
  const selected = relevance === "pass" && meetsThreshold(values, threshold);
  const subjects = run.structure?.subjects ?? [];
  const category = toPublicApiCategory(run.structure?.category ?? null);
  const tags = normalizeTags(run.writing?.tags ?? run.structure?.tags ?? []).filter((t) => !(CATEGORY_TAGS as readonly string[]).includes(t));
  if (category) tags.unshift(CATEGORY_LABELS[category]);
  for (const s of subjects) {
    const display = ENTITIES[s]?.displayTag;
    if (display && !tags.includes(display)) tags.push(display);
  }
  return {
    relevance,
    selected,
    score,
    scores: values,
    scoreModel: run.scores?.model ?? null,
    scoreRefused: run.scores?.refused ?? false,
    threshold,
    category,
    tags,
    subjects,
    titleZh,
    summaryZh,
    reasonZh: run.writing?.reasonZh ?? null,
    scope: run.structure?.scope ?? "unknown",
    fact: run.structure?.scope === "composite" ? null : (run.structure?.fact ?? null),
    geography: run.structure?.geography ?? null,
    company_context: run.structure?.company_context ?? [],
  };
}

export interface AnalyzeResult {
  analysisId: number | null;
  stale: boolean;
  /** The article page is to be fetched first; nothing was committed. */
  needsBody?: boolean;
  output: ReturnType<typeof normalizeAnalysis> | null;
  receiptIds: number[];
  reused: boolean;
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
  opts = {
    ...opts,
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
    return { analysisId: committed.value, stale: committed.stale, output: out, receiptIds, reused };
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

/** Provenance only: consumers must also match the publication and current content revision. */
export async function analysisMaterialRevisions(ids: number[]) {
  if (!ids.length) return [];
  return sql<
    { id: number; article_id: string; input_revision: number }[]
  >`SELECT id,article_id,input_revision FROM analyses WHERE id=ANY(${ids}::bigint[]) ORDER BY id`;
}

export { prepareEvaluationInput, evaluationInputFingerprint } from "./evaluation-input.ts";

export { currentEvaluationDerivedInput } from "./input.ts";
