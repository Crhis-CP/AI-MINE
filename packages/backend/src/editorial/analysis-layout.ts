// The two prompt layouts of the per-article analysis (ANALYSIS_PROMPT_LAYOUT, config.ts; design in
// docs/design/model-routing-202611/README.md §三.2):
//   separate: every step has its own system prompt and its own rendering of the article — the earlier layout.
//   shared (default): every analysis request of one article revision starts with the same bytes — one constant system
//     prompt holding every step's rules under its own heading (industry/prompts/analysis-shared.md includes the step
//     prompts unchanged), this revision's material rendered once, and a constant acknowledgement — and only the last
//     message, a short step instruction (industry/prompts/analysis-step-*.md), differs. After the first step (the
//     prefilter) a provider's prefix cache bills the body at the cache-hit price.
// The shared material carries no publisher identity (source name, kind, tier, first-party flag, tags, author, link),
// so the score stays blind to it; the steps that read the publisher get it in their step instruction. The material
// numbers the evidence segments structure's geography is validated against (geographyMaterial) and reads one body
// budget for every step (UNDERSTAND_BODY_CHARS).
// The X-post title/summary prompts (short and long posts, short-post translation) keep the separate layout in both
// modes: they carry the post inline and the stored post translation is bound to their recipe.
import { createHash } from "node:crypto";
import { CATEGORIES } from "@amp/industry/taxonomy";
import { MAJOR_COMPANIES, SELECTION } from "@amp/industry/selection";
import type { AnalysisPromptLayout } from "../config.ts";
import type { ChatPrefix } from "../providers/llm.ts";
import { postEvidenceText, usableSourceText } from "../lib/text.ts";
import { stableJson } from "../lib/ids.ts";
import { GEOGRAPHY_DICTIONARY, geographyMaterial } from "./geography.ts";
import type { AnalyzeInputArticle } from "./input.ts";
import { configuredPromptVersion, promptText, promptVersion } from "./prompts.ts";
import { modelSourceDateLabel } from "./source-time.ts";
import { CATEGORY_GUIDE, CATEGORY_TAGS, ENTITIES, ENTITY_TAGS, TOPIC_TAGS } from "./vocabulary.ts";
import { bodyWithin, materialQuality, mediaLine, UNDERSTAND_BODY_CHARS, UNDERSTAND_CONFIG } from "./writing.ts";

const ZH_COUNT = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];

/** The structure step's prompt values (it writes nothing a reader sees), from the pack's vocabulary. */
export const STRUCTURE_CONFIG = {
  categoryCount: ZH_COUNT[CATEGORIES.length] ?? String(CATEGORIES.length),
  categoryGuide: CATEGORY_GUIDE,
  categoryTags: CATEGORY_TAGS.join("、"),
  topicTags: TOPIC_TAGS.join("、"),
  entityTags: ENTITY_TAGS.join("、"),
  jurisdictions: GEOGRAPHY_DICTIONARY,
  entities: Object.entries(ENTITIES)
    .map(([id, e]) => `${id}（${e.aliases.slice(0, 3).join("/")}）`)
    .join("，"),
};
/** The score prompt's values: the industry's major companies. */
export const SCORE_CONFIG = { majorCompanies: MAJOR_COMPANIES.join("、") };
/** The wording mend's values. */
export const MEND_CONFIG = { reasonLabel: "推荐理由" };

export type AnalysisStep = "prefilter" | "score" | "understand" | "summarize" | "wording" | "structure";

// ── The shared layout ──────────────────────────────────────────────────────────────────────

function sharedValues(): Record<string, string> {
  const values: Record<string, string> = { ...STRUCTURE_CONFIG };
  // One rendering serves both rule sets, so a value they share must agree.
  for (const [key, value] of Object.entries({ ...UNDERSTAND_CONFIG, ...SCORE_CONFIG, ...MEND_CONFIG })) {
    if (key in values && values[key] !== value) throw new Error(`shared analysis prompt: conflicting values for {{${key}}}`);
    values[key] = value;
  }
  // The title/summary rules end with the article's own context; in the shared rules those lines point at the
  // material and the step instruction, which carry the values.
  const pointer = promptText("analysis-shared-pointer").trim();
  for (const key of ["publishedDate", "sourceName", "identity", "title", "body"]) values[key] = pointer;
  return values;
}

/** The one system prompt of every shared-layout analysis request: a preamble and every step's rules. */
export const SHARED_ANALYSIS_SYSTEM = promptText("analysis-shared", sharedValues());
/** The constant assistant turn between the material and the step instruction. */
export const MATERIAL_ACKNOWLEDGEMENT = promptText("analysis-material-ack").trim();

/** Bumped when the material rendering below or the message layout changes; neither lives in a prompt file. */
const SHARED_RECIPE = "analysis-shared-v1/geography-22000/body-20000/prefix-v1";

export interface SharedMaterial {
  /** The material message, byte-identical for every step of one article revision. */
  text: string;
  /** The evidence segments the material numbers; structure's geography is validated against these. */
  geography: ReturnType<typeof geographyMaterial>;
}

/**
 * The article as every shared-layout step reads it: the original time, media, material quality and the evidence
 * segments (title, body_head, body_tail at the geography budget) with the body between head and tail as 〔正文续〕, up
 * to UNDERSTAND_BODY_CHARS in all; a cut is stated. No source name, tier, first-party flag, author or link.
 */
export function sharedMaterial(a: AnalyzeInputArticle): SharedMaterial {
  const geography = geographyMaterial(a);
  const segment = (id: string) => geography.segments.find((s) => s.id === id)?.text ?? "";
  // The same evidence text geographyMaterial cut its segments from.
  const evidence = a.xPost ? postEvidenceText(a.xPost) : (a.bodyText ?? a.excerpt ?? "");
  const head = segment("body_head"),
    tail = segment("body_tail"),
    chars = Array.from(evidence),
    headLength = Array.from(head).length,
    tailLength = Array.from(tail).length;
  const between = chars.slice(headLength, chars.length - tailLength);
  const kept = between.slice(0, Math.max(0, UNDERSTAND_BODY_CHARS - headLength - tailLength));
  const lines = [`【原文时间】${modelSourceDateLabel(a)}`];
  const media = mediaLine(a);
  if (media) lines.push(media);
  lines.push(`【材料质量】${materialQuality(a)}`, "", "〔title〕", segment("title"), "", "〔body_head〕", head);
  if (kept.length) lines.push("", "〔正文续〕", kept.join(""));
  if (kept.length < between.length) lines.push(`……（正文共 ${chars.length} 字，此处省略中间 ${between.length - kept.length} 字）`);
  if (tail) lines.push("", "〔body_tail〕", tail);
  // A usable feed summary beside a page body without text: the steps still read it, though it is no evidence segment.
  const usable = a.xPost ? "" : usableSourceText(a.bodyText, a.excerpt);
  if (usable && !usableSourceText(evidence)) lines.push("", "〔正文（不是可引用的段）〕", bodyWithin(usable, UNDERSTAND_BODY_CHARS));
  return { text: lines.join("\n"), geography };
}

/**
 * The shared system prompt with other score rules in place of the production ones (rules experiments only): the
 * same preamble and other sections, so only the score rules differ from production.
 */
export function sharedSystemWithScoreRules(rules: string): string {
  const parts = SHARED_ANALYSIS_SYSTEM.split(promptText("selection-score", SCORE_CONFIG));
  if (parts.length !== 2) throw new Error("shared analysis prompt: the score rules are not included exactly once");
  return parts.join(rules);
}

/** A shared-layout request: the shared system prompt, the material and the step's instruction. */
export function sharedRequest(material: SharedMaterial, step: AnalysisStep, values: Record<string, string> = {}) {
  return {
    system: SHARED_ANALYSIS_SYSTEM,
    prefix: { material: material.text, acknowledgement: MATERIAL_ACKNOWLEDGEMENT } satisfies ChatPrefix,
    user: promptText(`analysis-step-${step}`, values),
  };
}

// ── Versions ───────────────────────────────────────────────────────────────────────────────

/** The score recipe is the prompt plus the weights and caps that turn its axes into the score. */
const WEIGHTS = createHash("sha256")
  .update(JSON.stringify([SELECTION.weights, SELECTION.unusableMaterialCap, SELECTION.noiseCaps, MAJOR_COMPANIES]))
  .digest("hex")
  .slice(0, 10);
const STEP_NAMES: Record<AnalysisStep, string> = {
  prefilter: "prefilter",
  score: "selection-score",
  understand: "understand",
  summarize: "summarize-article",
  wording: "mend-wording",
  structure: "structure",
};
/** Prompt files a step instruction may add to the rendered text besides its own file. */
const STEP_FILES: Partial<Record<AnalysisStep, string[]>> = { summarize: ["summarize-article-empty", "identity-context"] };

/** `<step>-shared@hash` over the rendered shared system, the acknowledgement, the step instruction and the recipe. */
function sharedStepVersion(step: AnalysisStep): string {
  const hash = createHash("sha256")
    .update(stableJson([SHARED_RECIPE, SHARED_ANALYSIS_SYSTEM, MATERIAL_ACKNOWLEDGEMENT, promptVersion(`analysis-step-${step}`, ...(STEP_FILES[step] ?? []))]))
    .digest("hex")
    .slice(0, 10);
  return `${STEP_NAMES[step]}-shared@${hash}`;
}

/** The score standard without its weights (SelectBench's standard version): the score prompt, as the layout sends it. */
export function scoreStandardVersion(layout: AnalysisPromptLayout): string {
  return layout === "shared" ? sharedStepVersion("score") : promptVersion("selection-score");
}

const versions = new Map<AnalysisPromptLayout, Readonly<Record<AnalysisStep, string>>>();
/** Every step's prompt version in a layout, as receipts and judgements record it. */
export function promptVersionsFor(layout: AnalysisPromptLayout): Readonly<Record<AnalysisStep, string>> {
  let found = versions.get(layout);
  if (!found) {
    found = Object.freeze(
      layout === "shared"
        ? {
            prefilter: sharedStepVersion("prefilter"),
            score: `${scoreStandardVersion(layout)}+weights@${WEIGHTS}`,
            understand: sharedStepVersion("understand"),
            summarize: sharedStepVersion("summarize"),
            wording: sharedStepVersion("wording"),
            structure: sharedStepVersion("structure"),
          }
        : {
            prefilter: promptVersion("prefilter"),
            score: `${scoreStandardVersion(layout)}+weights@${WEIGHTS}`,
            understand: configuredPromptVersion("understand", UNDERSTAND_CONFIG),
            summarize: promptVersion("summarize-article", "summarize-article-empty", "identity-context"),
            wording: promptVersion("mend-wording"),
            structure: configuredPromptVersion("structure", STRUCTURE_CONFIG),
          },
    );
    versions.set(layout, found);
  }
  return found;
}
