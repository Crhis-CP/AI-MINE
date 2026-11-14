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
// Both layouts take the score rules and the prefilter rules from the selection rule set (SELECTION_RULESET, config.ts;
// the files of each set are named in industry/selection.ts). The shared template names the classic files in its two
// includes and the other set is read in their place, so the classic prompts are rendered exactly as they were before
// the switch existed; each set has its own prompt versions.
import { createHash } from "node:crypto";
import { CATEGORIES } from "@amp/industry/taxonomy";
import { MAJOR_COMPANIES, SELECTION, SELECTION_RULESETS } from "@amp/industry/selection";
import { selectionRuleset, type AnalysisPromptLayout, type SelectionRuleset } from "../config.ts";
import type { ChatPrefix } from "../providers/llm.ts";
import { postEvidenceText, usableSourceText } from "../lib/text.ts";
import { stableJson } from "../lib/ids.ts";
import { GEOGRAPHY_DICTIONARY, geographyMaterial } from "./geography.ts";
import type { AnalyzeInputArticle } from "./input.ts";
import { configuredPromptVersion, promptText, promptVersion } from "./prompts.ts";
import { modelSourceDateLabel } from "./source-time.ts";
import { CATEGORY_GUIDE, CATEGORY_TAGS, ENTITIES, ENTITY_TAGS, TOPIC_TAGS } from "./vocabulary.ts";
import { bodyWithin, materialQuality, mediaLine, prefilterSystem, UNDERSTAND_BODY_CHARS, UNDERSTAND_CONFIG } from "./writing.ts";

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

/** One value per rule set, made on first use; without an argument, the configured set's (read on every call). */
function perRuleset<T>(make: (ruleset: SelectionRuleset) => T): (ruleset?: SelectionRuleset) => T {
  const made = new Map<SelectionRuleset, T>();
  return (ruleset = selectionRuleset()) => {
    if (!made.has(ruleset)) made.set(ruleset, make(ruleset));
    return made.get(ruleset)!;
  };
}

/** The score rules of a selection rule set: the industry's taste, as the separate layout's score step sends it. */
export const scoreSystem = perRuleset((ruleset) => promptText(SELECTION_RULESETS[ruleset].score, SCORE_CONFIG));

/**
 * The one system prompt of every shared-layout analysis request in a rule set: a preamble and every step's rules. The
 * template (analysis-shared.md) includes the classic prefilter and score files; another set's files are read in their
 * place. A set whose rules are not in the result exactly once is an error: no rule set may silently send another's.
 */
export const sharedAnalysisSystem = perRuleset((ruleset) => {
  const rules = SELECTION_RULESETS[ruleset],
    template = SELECTION_RULESETS.classic;
  const system = promptText("analysis-shared", sharedValues(), { [template.prefilter]: rules.prefilter, [template.score]: rules.score });
  for (const [step, text] of [
    ["prefilter", prefilterSystem(ruleset)],
    ["score", scoreSystem(ruleset)],
  ] as const)
    if (system.split(text).length !== 2) throw new Error(`shared analysis prompt: the ${ruleset} ${step} rules are not included exactly once`);
  return system;
});
/** The shared system prompt of the rule set configured when this module loaded; requests are built from sharedAnalysisSystem(). */
export const SHARED_ANALYSIS_SYSTEM = sharedAnalysisSystem();
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
 * The shared system prompt with other score rules in place of a rule set's (rules experiments only): the same
 * preamble and other sections, so only the score rules differ from that set's production prompt.
 */
export function sharedSystemWithScoreRules(rules: string, ruleset: SelectionRuleset = selectionRuleset()): string {
  const parts = sharedAnalysisSystem(ruleset).split(scoreSystem(ruleset));
  if (parts.length !== 2) throw new Error("shared analysis prompt: the score rules are not included exactly once");
  return parts.join(rules);
}

/** A shared-layout request: the shared system prompt, the material and the step's instruction. */
export function sharedRequest(
  material: SharedMaterial,
  step: AnalysisStep,
  values: Record<string, string> = {},
  ruleset: SelectionRuleset = selectionRuleset(),
) {
  return {
    system: sharedAnalysisSystem(ruleset),
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
/** A step's name in its version: the selection steps are named after their rule set's files. */
const stepNames = (ruleset: SelectionRuleset): Record<AnalysisStep, string> => ({
  prefilter: SELECTION_RULESETS[ruleset].prefilter,
  score: SELECTION_RULESETS[ruleset].score,
  understand: "understand",
  summarize: "summarize-article",
  wording: "mend-wording",
  structure: "structure",
});
/** Prompt files a step instruction may add to the rendered text besides its own file. */
const STEP_FILES: Partial<Record<AnalysisStep, string[]>> = { summarize: ["summarize-article-empty", "identity-context"] };

/**
 * `<step>-shared@hash` over the rendered shared system, the acknowledgement, the step instruction and the recipe. The
 * shared system holds the rule set's rules, so every step's shared version differs between rule sets.
 */
function sharedStepVersion(step: AnalysisStep, ruleset: SelectionRuleset): string {
  const hash = createHash("sha256")
    .update(
      stableJson([SHARED_RECIPE, sharedAnalysisSystem(ruleset), MATERIAL_ACKNOWLEDGEMENT, promptVersion(`analysis-step-${step}`, ...(STEP_FILES[step] ?? []))]),
    )
    .digest("hex")
    .slice(0, 10);
  return `${stepNames(ruleset)[step]}-shared@${hash}`;
}

/** The score standard without its weights (SelectBench's standard version): the score prompt, as the layout sends it. */
export function scoreStandardVersion(layout: AnalysisPromptLayout, ruleset: SelectionRuleset = selectionRuleset()): string {
  return layout === "shared" ? sharedStepVersion("score", ruleset) : promptVersion(SELECTION_RULESETS[ruleset].score);
}

const versions = new Map<string, Readonly<Record<AnalysisStep, string>>>();
/** Every step's prompt version in a layout and rule set (the configured set unless named), as receipts and judgements record it. */
export function promptVersionsFor(layout: AnalysisPromptLayout, ruleset: SelectionRuleset = selectionRuleset()): Readonly<Record<AnalysisStep, string>> {
  const key = `${layout}/${ruleset}`;
  let found = versions.get(key);
  if (!found) {
    found = Object.freeze(
      layout === "shared"
        ? {
            prefilter: sharedStepVersion("prefilter", ruleset),
            score: `${scoreStandardVersion(layout, ruleset)}+weights@${WEIGHTS}`,
            understand: sharedStepVersion("understand", ruleset),
            summarize: sharedStepVersion("summarize", ruleset),
            wording: sharedStepVersion("wording", ruleset),
            structure: sharedStepVersion("structure", ruleset),
          }
        : {
            prefilter: promptVersion(SELECTION_RULESETS[ruleset].prefilter),
            score: `${scoreStandardVersion(layout, ruleset)}+weights@${WEIGHTS}`,
            understand: configuredPromptVersion("understand", UNDERSTAND_CONFIG),
            summarize: promptVersion("summarize-article", "summarize-article-empty", "identity-context"),
            wording: promptVersion("mend-wording"),
            structure: configuredPromptVersion("structure", STRUCTURE_CONFIG),
          },
    );
    versions.set(key, found);
  }
  return found;
}
