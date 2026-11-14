// The selection configuration check (TASK-0710), without any model call: what the per-article analysis prompts are
// made of, part by part, each part marked as defining the score standard (what SELECTION_CONFIRMED_VERSION confirms,
// analysis-layout.ts scoreConfirmationVersion) or as only sent alongside it. scripts/eval-selection.ts --config-check
// prints the current snapshot, compares it with an earlier one (--baseline, written by --write on an earlier commit)
// and with a confirmed value, so the release note can say which non-score sections changed and whether the confirmed
// value still holds.
import { createHash } from "node:crypto";
import { SELECTION_RULESETS } from "@amp/industry/selection";
import type { AnalysisPromptLayout, SelectionRuleset } from "../config.ts";
import {
  promptVersionsFor,
  scoreConfirmationVersion,
  scoreSystem,
  sharedMaterialRecipe,
  sharedSectionRules,
  sharedSections,
  STRUCTURE_CONFIG,
  weightsVersion,
  type AnalysisStep,
} from "./analysis-layout.ts";
import { GEOGRAPHY_DICTIONARY } from "./geography.ts";
import { promptFileHash, promptText, promptVersion } from "./prompts.ts";
import { prefilterSystem } from "./writing.ts";

const RULESETS = Object.keys(SELECTION_RULESETS) as SelectionRuleset[];
const LAYOUTS: AnalysisPromptLayout[] = ["shared", "separate"];
const hash = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex")
    .slice(0, 10);

export interface ConfigPart {
  label: string;
  /** Part of the score standard: a change here changes the confirmed value. */
  score: boolean;
  hash: string;
}
export interface SelectionConfigSnapshot {
  kind: "selection-config-v1";
  /** Per `<rule set>/<layout>`: the score standard to confirm, and every step's full version as receipts record it. */
  versions: Record<string, { confirmation: string; steps: Record<AnalysisStep, string> }>;
  parts: Record<string, ConfigPart>;
}

/** The current configuration, part by part. Reads prompt files and the industry pack only. */
export function selectionConfigSnapshot(): SelectionConfigSnapshot {
  const versions: SelectionConfigSnapshot["versions"] = {};
  for (const ruleset of RULESETS)
    for (const layout of LAYOUTS)
      versions[`${ruleset}/${layout}`] = { confirmation: scoreConfirmationVersion(layout, ruleset), steps: { ...promptVersionsFor(layout, ruleset) } };
  const parts: Record<string, ConfigPart> = {};
  const add = (key: string, label: string, score: boolean, value: unknown) => (parts[key] = { label, score, hash: hash(value) });
  // The score standard. The preamble and headings come from the one shared template, the same for every rule set.
  const sections = sharedSections(RULESETS[0]);
  for (const ruleset of RULESETS) add(`score-rules/${ruleset}`, `评分规则（${ruleset}）`, true, scoreSystem(ruleset));
  add("preamble", "共享规则开头的前言（对话结构、只执行点名的一节）", true, sections.preamble);
  add("score-heading", "评分一节的标题", true, sections.headings.score);
  add("score-instruction", "评分本步指令", true, promptText("analysis-step-score"));
  add("material-recipe", "材料配方（正文排布与消息结构）", true, sharedMaterialRecipe());
  add("weights", "权重、封顶与大型矿企名单", true, weightsVersion());
  // Sent alongside, not the score standard.
  for (const ruleset of RULESETS) add(`prefilter-rules/${ruleset}`, `预筛规则（${ruleset}）`, false, prefilterSystem(ruleset));
  const rules = sharedSectionRules(RULESETS[0]);
  add("structure-rules", "结构抽取规则（含下面三项）", false, rules.structure);
  add("dictionary", "法域词典", false, GEOGRAPHY_DICTIONARY);
  add("entities", "公司别名", false, STRUCTURE_CONFIG.entities);
  add("vocabulary", "分类与标签词表", false, [
    STRUCTURE_CONFIG.categoryGuide,
    STRUCTURE_CONFIG.categoryTags,
    STRUCTURE_CONFIG.topicTags,
    STRUCTURE_CONFIG.entityTags,
  ]);
  add("understand-rules", "内容理解规则", false, rules.understand);
  add("summarize-rules", "标题摘要规则（含写作规则与名称表）", false, rules.summarize);
  add(
    "writing-rules",
    "写作规则",
    false,
    ["rules-answer-first-summary", "rules-self-contained-title", "rules-domain", "rules-anti-hallucination"].map(promptFileHash),
  );
  add("names", "名称表", false, ["rules-domain-names", "rules-domain-names-extra"].map(promptFileHash));
  add("wording-rules", "用词修订规则", false, rules.wording);
  add(
    "step-instructions",
    "其他步骤的本步指令",
    false,
    (["prefilter", "structure", "understand", "summarize", "wording"] as const).map((step) => promptVersion(`analysis-step-${step}`)),
  );
  return { kind: "selection-config-v1", versions, parts };
}

export interface SelectionConfigComparison {
  /** `<rule set>/<layout>` whose score standard the confirmed value names. */
  confirmedMatches: string[];
  /** Score-standard parts that changed since the baseline. */
  scoreChanged: string[];
  /** Other parts that changed since the baseline: for the release note; they do not touch the confirmed value. */
  otherChanged: string[];
  /** `<rule set>/<layout>` whose confirmed value changed since the baseline. */
  confirmationsChanged: string[];
}

export function compareSelectionConfig(
  current: SelectionConfigSnapshot,
  opts: { baseline?: SelectionConfigSnapshot | null; confirmed?: string | null } = {},
): SelectionConfigComparison {
  const { baseline, confirmed } = opts;
  if (baseline && baseline.kind !== current.kind) throw new Error(`baseline is not a ${current.kind} snapshot`);
  const changed = (score: boolean) =>
    baseline ? Object.keys(current.parts).filter((key) => current.parts[key]!.score === score && baseline.parts[key]?.hash !== current.parts[key]!.hash) : [];
  return {
    confirmedMatches: confirmed ? Object.keys(current.versions).filter((key) => current.versions[key]!.confirmation === confirmed) : [],
    scoreChanged: changed(true),
    otherChanged: changed(false),
    confirmationsChanged: baseline
      ? Object.keys(current.versions).filter((key) => baseline.versions[key]?.confirmation !== current.versions[key]!.confirmation)
      : [],
  };
}

/** The check as Chinese Markdown for the release note. */
export function selectionConfigReport(
  current: SelectionConfigSnapshot,
  opts: { baseline?: SelectionConfigSnapshot | null; confirmed?: string | null; configured?: string } = {},
): string {
  const result = compareSelectionConfig(current, opts);
  const label = (key: string) => current.parts[key]!.label;
  const lines = ["# 精选配置核对（不调用模型）", "", "## 评分确认值（SELECTION_CONFIRMED_VERSION 只和它比）", ""];
  lines.push("| 规则组/排布 | 评分确认值 | 评分步骤完整版本（回执与判断记录里） |", "| --- | --- | --- |");
  for (const [key, v] of Object.entries(current.versions))
    lines.push(`| ${key}${key === opts.configured ? "（当前配置）" : ""} | \`${v.confirmation}\` | \`${v.steps.score}\` |`);
  lines.push("");
  if (opts.confirmed) {
    if (result.confirmedMatches.length)
      lines.push(
        `给定的确认值 \`${opts.confirmed}\` 等于 ${result.confirmedMatches.join("、")} 当前的评分标准。` +
          (opts.configured && !result.confirmedMatches.includes(opts.configured)
            ? `但当前配置是 ${opts.configured}，这样上线不打分。`
            : "按这个配置上线照常打分。"),
      );
    else lines.push(`给定的确认值 \`${opts.confirmed}\` 不等于任何当前评分标准：正式站不打分、没有精选，须 Owner 确认新的评分标准后改填。`);
  } else lines.push("没有给定确认值（--confirmed 或 SELECTION_CONFIRMED_VERSION），未核对。");
  lines.push("");
  if (opts.baseline) {
    lines.push("## 与基线相比", "");
    lines.push(
      result.scoreChanged.length
        ? `评分标准有变化：${result.scoreChanged.map(label).join("、")}。确认值变化的有 ${result.confirmationsChanged.join("、") || "（无）"}，须 Owner 确认后改填。`
        : "评分标准没有变化，确认值不用改。",
    );
    lines.push(
      result.otherChanged.length ? `非评分部分有变化（写进发布说明，不影响确认值）：${result.otherChanged.map(label).join("、")}。` : "非评分部分没有变化。",
    );
  } else lines.push("没有给定基线（--baseline），只列出当前值。基线可在上一次发布的准确提交上用 --write 生成。");
  return lines.join("\n");
}
