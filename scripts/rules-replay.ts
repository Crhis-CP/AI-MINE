// Rules replay (TASK-0643, Owner 2026-11-13): the 3.1 candidate rules (industry/prompts/selection-score-global.md and
// prefilter-four-layers.md) against the Owner's labels and recent production items, side by side with the current
// rules. Read-only for business tables: it sends model requests (evaluation receipts) and writes a report; it changes
// no article, analysis or publication. Run it in a one-off container of the released image, not beside a release:
//   node scripts/rules-replay.ts --out .data/rules-replay [--gold .data/gold-owner-20261105.jsonl] [--days 7]
//     [--max-yuan 30] [--per-minute 8] [--band 45-80] [--recent 400] [--noise 50] [--blocked 400]
// The gold file comes from scripts/gold-from-labels.ts (read-only). Phases run in order — gold set, recent scores,
// model noise, blocked items — and stop once the spent cost reaches --max-yuan; the report says where it stopped.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { analysisPromptLayout } from "@amp/backend/config";
import { closeDb, initializeDb, sql } from "@amp/backend/db";
import {
  draftTierThreshold,
  evaluationInputFingerprint,
  loadAnalyzeInput,
  prepareEvaluationInput,
  promptVersionsFor,
  ScoreSchema,
  selectionStepRequest,
  selectionSystem,
  type AnalyzeInputArticle,
} from "@amp/backend/editorial/analyze";
import { modelFor } from "@amp/backend/editorial/models";
import { promptText } from "@amp/backend/editorial/prompts";
import { missingEvidence } from "@amp/backend/editorial/writing";
import { sha256 } from "@amp/backend/lib/ids";
import { normalizedUppercase } from "@amp/backend/lib/text";
import { chatJson } from "@amp/backend/providers/llm";
import { attentionScore, MAJOR_COMPANIES, meetsThreshold, scoreMean, scoreSettled, type ScoreAxes } from "@amp/industry/selection";

export type Rules = "current" | "candidate";
export interface ScoreRun {
  values: number[];
  mean: number | null;
  selected: boolean;
  reson: number[];
}
export interface GoldCase {
  caseId: string;
  title: string;
  tier: string;
  decision: "select" | "reject" | "either";
  current: ScoreRun | null;
  candidate: ScoreRun | null;
}
export interface RecentCase {
  id: string;
  title: string;
  source: string;
  tier: string;
  day: string;
  oldScore: number;
  oldSelected: boolean;
  candidate: ScoreRun | null;
  /** The current rules run again (the noise sample only). */
  rerun: ScoreRun | null;
}
export interface BlockedCase {
  id: string;
  title: string;
  source: string;
  day: string;
  label: string | null;
  reason: string;
  candidate: ScoreRun | null;
}

/** Replaces the one occurrence of `find`; anything else means the prompt layout changed and the replay must stop. */
export function replaceOnce(text: string, find: string, replacement: string, label: string): string {
  const parts = text.split(find);
  if (parts.length !== 2) throw new Error(`${label}: expected the current rules exactly once in the system prompt, found ${parts.length - 1}`);
  return parts.join(replacement);
}

/** Rules texts as the system prompts embed them (the score rules read the major companies; the prefilter none). */
export function rulesTexts(scoreRules = "selection-score-global", prefilterRules = "prefilter-four-layers") {
  const values = { majorCompanies: MAJOR_COMPANIES.join("、") };
  return {
    current: { score: promptText("selection-score", values), prefilter: promptText("prefilter") },
    candidate: { score: promptText(scoreRules, values), prefilter: promptText(prefilterRules) },
  };
}

/**
 * The candidate's system prompt for a step. In the shared layout both steps send one system prompt that holds both
 * rules, so both are swapped; in the separate layout each step's own prompt is its rules.
 */
export function candidateSystem(step: "prefilter" | "score", layout: "shared" | "separate", texts = rulesTexts()): string {
  const base = selectionSystem(step, layout);
  if (layout === "shared")
    return replaceOnce(
      replaceOnce(base, texts.current.score, texts.candidate.score, "score rules"),
      texts.current.prefilter,
      texts.candidate.prefilter,
      "prefilter rules",
    );
  return step === "score"
    ? replaceOnce(base, texts.current.score, texts.candidate.score, "score rules")
    : replaceOnce(base, texts.current.prefilter, texts.candidate.prefilter, "prefilter rules");
}

/** Precision, recall, F1 and agreement of one rules' decisions against the Owner's labels ("either" not counted). */
export function goldMetrics(cases: readonly GoldCase[], rules: Rules, threshold?: (c: GoldCase) => number | null) {
  let tp = 0,
    fp = 0,
    fn = 0,
    tn = 0;
  for (const c of cases) {
    // Only pairs both rules finished: the two sets of metrics then describe the same articles.
    const run = c[rules];
    if (!run || !c.current || !c.candidate || c.decision === "either") continue;
    const limit = threshold ? threshold(c) : null;
    const picked = limit === null ? run.selected : run.mean !== null && run.mean >= limit;
    if (picked && c.decision === "select") tp++;
    else if (picked) fp++;
    else if (c.decision === "select") fn++;
    else tn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall ? (2 * precision * recall) / (precision + recall) : null;
  const total = tp + fp + fn + tn;
  return { tp, fp, fn, tn, total, precision, recall, f1, agreement: total ? (tp + tn) / total : null };
}

/** Labelled cases one of the two rules did not finish (budget stop or error): left out of every comparison. */
export function goldIncomplete(cases: readonly GoldCase[]): number {
  return cases.filter((c) => c.decision !== "either" && (!c.current || !c.candidate)).length;
}

/** A score is a judgement only once it is settled as production settles it (scoreSettled); otherwise null. */
export function settledRun(scores: number[], resons: number[], threshold: number): ScoreRun | null {
  if (!scores.length || !scoreSettled(scores, threshold, 2)) return null;
  return { values: scores, mean: scoreMean(scores), selected: meetsThreshold(scores, threshold), reson: resons };
}

/**
 * Spent cost from the receipts' attempts: priced CNY attempts at their cost; an attempt without a price (unknown
 * outcome, unpriced, another currency) counts as one bounded call (`reserve`), so it can never hide spending.
 */
export function costOf(rows: readonly { cost: number | null; currency: string | null }[], reserve: number) {
  let priced = 0,
    unpriced = 0,
    maxCost = 0;
  for (const row of rows) {
    if (row.cost === null || (row.currency ?? "CNY") !== "CNY") unpriced++;
    else {
      priced += Number(row.cost);
      maxCost = Math.max(maxCost, Number(row.cost));
    }
  }
  return { spent: priced + unpriced * reserve, unpriced, maxCost };
}

/** One flat threshold from 50 to 80 for the candidate: where its decisions would agree best with the Owner. */
export function thresholdSweep(cases: readonly GoldCase[], rules: Rules) {
  const rows = [];
  for (let t = 50; t <= 80; t += 2) rows.push({ threshold: t, ...goldMetrics(cases, rules, () => t) });
  return rows;
}

/** Recent items in four groups: kept in, dropped, added, kept out. */
export function recentShifts(cases: readonly RecentCase[]) {
  const scored = cases.filter((c) => c.candidate);
  return {
    scored: scored.length,
    keptIn: scored.filter((c) => c.oldSelected && c.candidate!.selected),
    dropped: scored.filter((c) => c.oldSelected && !c.candidate!.selected),
    added: scored.filter((c) => !c.oldSelected && c.candidate!.selected),
    keptOut: scored.filter((c) => !c.oldSelected && !c.candidate!.selected).length,
  };
}

/** The same current rules scored twice: how often the decision flips and how far the mean moves. */
export function noiseOf(cases: readonly RecentCase[]) {
  const pairs = cases.filter((c) => c.rerun?.mean !== null && c.rerun !== null);
  const flips = pairs.filter((c) => c.rerun!.selected !== c.oldSelected).length;
  const shift = pairs.length ? pairs.reduce((sum, c) => sum + Math.abs(c.rerun!.mean! - c.oldScore), 0) / pairs.length : null;
  return { pairs: pairs.length, flips, flipRate: pairs.length ? flips / pairs.length : null, meanShift: shift };
}

/** Spent cost and call pacing: one call every 60/perMinute seconds; stop once the spent cost reaches the cap. */
export class Meter {
  calls = 0;
  spent = 0;
  stopped: string | null = null;
  readonly maxYuan: number;
  readonly perMinute: number;
  /** The most one call can cost (yuan): a call starts only if it still fits under the cap. */
  reserve = 0.1;
  #next = 0;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  constructor(
    maxYuan: number,
    perMinute: number,
    now: () => number = Date.now,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ) {
    this.maxYuan = maxYuan;
    this.perMinute = perMinute;
    this.#now = now;
    this.#sleep = sleep;
  }
  /** Before each paid call: wait for its turn; false once one more bounded call would pass the cap (the replay then stops). */
  async turn(phase: string): Promise<boolean> {
    if (this.stopped) return false;
    if (this.spent + this.reserve > this.maxYuan) {
      this.stopped = phase;
      return false;
    }
    const wait = this.#next - this.#now();
    if (wait > 0) await this.#sleep(wait);
    this.#next = Math.max(this.#now(), this.#next) + 60_000 / this.perMinute;
    this.calls++;
    return true;
  }
}

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 1000) / 10}%`);
const num = (v: number | null | undefined) => (v === null || v === undefined ? "—" : String(Math.round(v * 10) / 10));
const cell = (s: string) => s.replaceAll("|", "／").replaceAll("\n", " ").slice(0, 80);

/** The report a person reads first: Chinese Markdown, conclusions on top. */
export function renderReport(r: {
  startedAt: string;
  finishedAt: string;
  model: string;
  layout: string;
  versions: Record<string, string>;
  meter: { calls: number; spent: number; maxYuan: number; stopped: string | null };
  days: number;
  band: [number, number];
  gold: GoldCase[];
  recent: RecentCase[];
  blocked: { sampled: BlockedCase[]; total: number };
  errors?: number;
}): string {
  const lines: string[] = [];
  const errors = r.errors ?? 0;
  const cur = goldMetrics(r.gold, "current"),
    cand = goldMetrics(r.gold, "candidate");
  const shifts = recentShifts(r.recent),
    noise = noiseOf(r.recent);
  const judged = r.blocked.sampled.filter((b) => b.label);
  const passed = judged.filter((b) => b.label !== "BLOCK");
  const passRate = judged.length ? passed.length / judged.length : null;
  const perDay = passRate === null ? null : (passRate * r.blocked.total) / r.days;
  // Selection is estimated only over passed items whose candidate score finished; the rest are pending, not "not selected".
  const scoredPassed = passed.filter((b) => b.candidate);
  const selectedOfPassed = scoredPassed.filter((b) => b.candidate!.selected).length;
  const goldMissing = goldIncomplete(r.gold);
  const recentMissing = r.recent.filter((c) => !c.candidate).length;
  const unfinished = goldMissing + recentMissing + (passed.length - scoredPassed.length) + r.blocked.sampled.filter((b) => !b.label).length;
  lines.push("# 3.1 新规则回放报告", "");
  lines.push(
    `运行：${r.startedAt} 至 ${r.finishedAt}（UTC）。模型 ${r.model}，提示词排法 ${r.layout}。费用 ${num(r.meter.spent)} 元（上限 ${r.meter.maxYuan} 元），模型调用 ${r.meter.calls} 次${r.meter.stopped ? `；**到上限停在“${r.meter.stopped}”这一步，后面的没跑**` : ""}${unfinished || errors ? `；未完成 ${unfinished} 篇、出错 ${errors} 次，这些不计入任何对照` : r.meter.stopped ? "" : "，全部跑完"}。`,
    "",
  );
  lines.push(`## 一、和 Owner 11-05 的标注比（两版都打完分的 ${cur.total} 篇${goldMissing ? `，另有 ${goldMissing} 篇没打完，不计` : ""}）`, "");
  lines.push("| 规则 | 判对 | 查准 | 查全 | F1 | 选了几篇 |", "|---|---|---|---|---|---|");
  for (const [name, m] of [
    ["现行", cur],
    ["候选（全球影响力）", cand],
  ] as const)
    lines.push(`| ${name} | ${m.tp + m.tn}/${m.total}（${pct(m.agreement)}） | ${pct(m.precision)} | ${pct(m.recall)} | ${pct(m.f1)} | ${m.tp + m.fp} |`);
  const best = thresholdSweep(r.gold, "candidate").reduce<ReturnType<typeof thresholdSweep>[number] | null>(
    (a, b) => (b.f1 !== null && (!a || a.f1 === null || b.f1 > a.f1) ? b : a),
    null,
  );
  if (best) lines.push("", `候选规则若用一条统一门槛，${best.threshold} 分时和标注最一致（F1 ${pct(best.f1)}）；现行三条线是官方 62、准官方 64、媒体 66。`);
  const differ = r.gold.filter((c) => c.current && c.candidate && c.current.selected !== c.candidate.selected);
  lines.push("", `两版判断不同的 ${differ.length} 篇：`, "", "| 编号 | 标题 | Owner | 现行 | 候选 |", "|---|---|---|---|---|");
  const said = { select: "该选", reject: "不选", either: "两可" } as const;
  for (const c of differ)
    lines.push(
      `| ${c.caseId.slice(-3)} | ${cell(c.title)} | ${said[c.decision]} | ${c.current!.selected ? "选" : "不选"} ${num(c.current!.mean)} | ${c.candidate!.selected ? "选" : "不选"} ${num(c.candidate!.mean)} |`,
    );
  lines.push("", `## 二、最近 ${r.days} 天线上打过分的稿件（均分 ${r.band[0]}–${r.band[1]}，重评 ${shifts.scored} 篇）`, "");
  lines.push(
    `- 原来入选、换规则后不选：**${shifts.dropped.length}** 篇；原来不选、换规则后入选：**${shifts.added.length}** 篇；不变：入选 ${shifts.keptIn.length} 篇、不选 ${shifts.keptOut} 篇。`,
    `- 模型自身的波动：同一现行规则再打一次 ${noise.pairs} 篇，判断翻转 ${noise.flips} 篇（${pct(noise.flipRate)}），均分平均相差 ${num(noise.meanShift)} 分。上面两张清单里，超过这个比例的部分才是规则带来的变化。`,
    "",
  );
  for (const [title, list] of [
    ["换规则后不再入选", shifts.dropped],
    ["换规则后新入选", shifts.added],
  ] as const) {
    lines.push(`### ${title}（${list.length}）`, "", "| 日期 | 标题 | 来源 | 原分 | 新分 |", "|---|---|---|---|---|");
    for (const c of list) lines.push(`| ${c.day} | ${cell(c.title)} | ${cell(c.source)}（${c.tier}） | ${num(c.oldScore)} | ${num(c.candidate!.mean)} |`);
    lines.push("");
  }
  lines.push(`## 三、“全部”放宽到四层（最近 ${r.days} 天被预筛挡掉 ${r.blocked.total} 篇，抽样重判 ${judged.length} 篇）`, "");
  lines.push(
    `- 候选预筛放行 ${passed.length} 篇（${pct(passRate)}），推算每天多收约 **${num(perDay)}** 条；放行的里面已打完分 ${scoredPassed.length} 篇，其中会入选 ${selectedOfPassed} 篇，推算每天约 ${num(!scoredPassed.length || perDay === null ? null : (selectedOfPassed / scoredPassed.length) * perDay)} 条进精选${passed.length > scoredPassed.length ? `（另有 ${passed.length - scoredPassed.length} 篇放行后没打完分，不计）` : ""}。`,
    "",
    "| 日期 | 标题 | 来源 | 结果 | 理由 |",
    "|---|---|---|---|---|",
  );
  for (const b of passed.slice(0, 60))
    lines.push(`| ${b.day} | ${cell(b.title)} | ${cell(b.source)} | ${b.label}${b.candidate?.selected ? "，入选" : ""} | ${cell(b.reason)} |`);
  lines.push("", "## 四、怎么读", "");
  lines.push(
    "- 第一节最要紧：同一批稿件、同一个模型，只换规则，看哪一版更接近 Owner 的取舍。",
    "- 第二节的两张清单是上线后读者会看到的变化，请逐条看是否合理。",
    "- 第三节的每天新增条数决定“全部”放宽后的阅读量和费用（每条约 0.016 元）。",
    `- 版本：${Object.entries(r.versions)
      .map(([k, v]) => `${k} ${v}`)
      .join("；")}。`,
  );
  return `${lines.join("\n")}\n`;
}

/** The receipt a failed paid call carries (ModelOutputError, post-receipt guards), if any. */
export function receiptOf(error: unknown): number | null {
  const id = (error as { receiptId?: unknown } | null)?.receiptId;
  return typeof id === "number" && Number.isInteger(id) ? id : null;
}

const Prefilter = z.object({ label: z.preprocess(normalizedUppercase, z.enum(["PASS", "BLOCK", "UNKNOWN"])), reason: z.string().max(200).catch("") });
const restored = (input: AnalyzeInputArticle): AnalyzeInputArticle => ({
  ...input,
  publishedAt: input.publishedAt ? new Date(input.publishedAt) : null,
  discoveredAt: input.discoveredAt ? new Date(input.discoveredAt) : null,
});

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      gold: { type: "string" },
      days: { type: "string", default: "7" },
      "max-yuan": { type: "string", default: "30" },
      "per-minute": { type: "string", default: "8" },
      band: { type: "string", default: "45-80" },
      recent: { type: "string", default: "400" },
      noise: { type: "string", default: "50" },
      blocked: { type: "string", default: "400" },
      "score-rules": { type: "string", default: "selection-score-global" },
      "prefilter-rules": { type: "string", default: "prefilter-four-layers" },
    },
  });
  if (!values.out) throw new Error("Usage: rules-replay.ts --out <dir> [--gold file.jsonl] [--days 7] [--max-yuan 30] [--per-minute 8]");
  const days = Number(values.days),
    maxYuan = Number(values["max-yuan"]),
    perMinute = Number(values["per-minute"]);
  const [lo, hi] = values.band!.split("-").map(Number) as [number, number];
  if (![days, maxYuan, perMinute, lo, hi].every((v) => Number.isFinite(v) && v > 0) || maxYuan > 30 || lo >= hi)
    throw new Error("Invalid --days, --max-yuan (≤ 30, Owner 2026-11-13), --per-minute or --band");
  const outDir = path.resolve(values.out, new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(outDir, { recursive: true });
  await initializeDb("worker");
  const startedAt = new Date().toISOString();
  const layout = analysisPromptLayout();
  const texts = rulesTexts(values["score-rules"], values["prefilter-rules"]);
  const systems = {
    current: { score: selectionSystem("score", layout), prefilter: selectionSystem("prefilter", layout) },
    candidate: { score: candidateSystem("score", layout, texts), prefilter: candidateSystem("prefilter", layout, texts) },
  };
  const versions = {
    currentScore: promptVersionsFor(layout).score,
    currentPrefilter: promptVersionsFor(layout).prefilter,
    candidateScore: `${values["score-rules"]}@${sha256(systems.candidate.score).slice(0, 10)}`,
    candidatePrefilter: `${values["prefilter-rules"]}@${sha256(systems.candidate.prefilter).slice(0, 10)}`,
  };
  const model = await modelFor("score"),
    prefilterModel = await modelFor("prefilter");
  const meter = new Meter(maxYuan, perMinute);
  const receipts = new Set<number>();
  /** Re-reads every attempt of every receipt this run produced: called after each paid call, failed ones included. */
  const settle = async () => {
    if (!receipts.size) return;
    const rows = await sql<{ cost: number | null; currency: string | null }[]>`SELECT cost::float AS cost, currency FROM receipt_attempts
      WHERE receipt_id = ANY(${[...receipts]}::bigint[])`;
    const cost = costOf(rows, meter.reserve);
    meter.spent = cost.spent;
    // A call can cost up to the dearest one seen so far, with a margin; never less than the default bound.
    meter.reserve = Math.max(meter.reserve, cost.maxCost * 1.5);
  };
  const account = async (receiptId: number | null) => {
    if (receiptId !== null) receipts.add(receiptId);
    await settle();
  };
  /** A paid call: its receipt counts even when the call throws after the provider charged (invalid output, guards). */
  const paid = async <T extends { receiptId: number }>(call: () => Promise<T>): Promise<T> => {
    try {
      const res = await call();
      await account(res.receiptId);
      return res;
    } catch (error) {
      await account(receiptOf(error));
      throw error;
    }
  };
  const prepared = async (input: AnalyzeInputArticle) => prepareEvaluationInput(input, evaluationInputFingerprint(input));

  async function score(input: AnalyzeInputArticle, rules: Rules, tag: string, phase: string): Promise<ScoreRun | null> {
    const threshold = draftTierThreshold(input.source.tier);
    if (threshold === null) return null;
    const { input: current, fallbackInput } = await prepared(input);
    const axes: ScoreAxes[] = [],
      scores: number[] = [];
    for (let i = 1; i <= 2; i++) {
      // Stopped before the score settled: no judgement (production would not accept it either).
      if (!(await meter.turn(phase))) return null;
      const request = { ...selectionStepRequest("score", current, layout), system: systems[rules].score };
      const special = model === "glm-5.3-flash-selection";
      const res = await paid(() =>
        chatJson({
          model,
          purpose: "score_article",
          lane: "news",
          usagePurpose: "evaluation",
          subject: `article:${current.id}@${current.revision}`,
          sourceIds: [current.sourceId!],
          ...request,
          promptVersion: rules === "current" ? versions.currentScore : versions.candidateScore,
          schema: ScoreSchema,
          temperature: special ? 1 : 0.2,
          maxTokens: special ? 65536 : 1024,
          timeoutMs: special ? 180000 : 120000,
          maxPhysicalAttempts: 1,
          attemptTag: `rules-replay-${tag}-score-${i}`,
          fallbackPermit: fallbackInput(request),
        }),
      );
      axes.push(res.data as ScoreAxes);
      scores.push(attentionScore(res.data as ScoreAxes));
      if (scoreSettled(scores, threshold, 2)) break;
    }
    return settledRun(
      scores,
      axes.map((a) => a.reson),
      threshold,
    );
  }

  async function prefilter(input: AnalyzeInputArticle, phase: string) {
    if (!(await meter.turn(phase))) return null;
    const { input: current, fallbackInput } = await prepared(input);
    const request = { ...selectionStepRequest("prefilter", current, layout), system: systems.candidate.prefilter };
    const res = await paid(() =>
      chatJson({
        model: prefilterModel,
        purpose: "prefilter_article",
        lane: "news",
        usagePurpose: "evaluation",
        subject: `article:${current.id}@${current.revision}`,
        sourceIds: [current.sourceId!],
        ...request,
        promptVersion: versions.candidatePrefilter,
        schema: Prefilter,
        temperature: 0,
        maxTokens: 512,
        maxPhysicalAttempts: 1,
        attemptTag: "rules-replay-prefilter",
        fallbackPermit: fallbackInput(request),
      }),
    );
    return { label: res.data.label === "BLOCK" && missingEvidence(current) ? "UNKNOWN" : res.data.label, reason: res.data.reason };
  }

  const gold: GoldCase[] = [];
  const recent: RecentCase[] = [];
  const blocked: { sampled: BlockedCase[]; total: number } = { sampled: [], total: 0 };
  const errors: string[] = [];
  const write = (finishedAt = new Date().toISOString()) => {
    const report = {
      startedAt,
      finishedAt,
      model,
      layout,
      versions,
      meter: { calls: meter.calls, spent: meter.spent, maxYuan, stopped: meter.stopped },
      days,
      band: [lo, hi] as [number, number],
      gold,
      recent,
      blocked,
      errors: errors.length,
    };
    writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify({ ...report, errorDetails: errors }, null, 2)}\n`);
    writeFileSync(path.join(outDir, "report.md"), renderReport(report));
  };
  const guarded = async (what: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      errors.push(`${what}: ${String(error).slice(0, 300)}`);
    }
  };
  try {
    // 1. Gold set: both rules on the same items.
    if (values.gold) {
      const rows = readFileSync(values.gold, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { caseId: string; analysisInput: AnalyzeInputArticle; gold: { decision: GoldCase["decision"] } });
      for (const row of rows) {
        if (meter.stopped) break;
        if (row.gold.decision === "either") continue;
        const input = restored(row.analysisInput);
        const c: GoldCase = { caseId: row.caseId, title: input.title, tier: input.source.tier, decision: row.gold.decision, current: null, candidate: null };
        gold.push(c);
        await guarded(row.caseId, async () => {
          // Alternate the order so neither rules is always scored second.
          const order: Rules[] = Number.parseInt(sha256(row.caseId).slice(0, 2), 16) % 2 ? ["candidate", "current"] : ["current", "candidate"];
          for (const rules of order) c[rules] = await score(input, rules, `gold-${rules}`, "金标集");
        });
      }
      write();
    }
    // 2. Recent scored items near the line: candidate rules; 3. a noise sample: the current rules again.
    const rows = await sql<{ id: string; title: string; source: string; tier: string; day: string; score: number; selected: boolean }[]>`
      WITH latest AS (
        SELECT DISTINCT ON (an.article_id) an.article_id, an.relevance, an.score::float AS score, coalesce(an.selected, false) AS selected
        FROM analyses an JOIN articles a ON a.id = an.article_id
        WHERE a.discovered_at >= now() - make_interval(days => ${days})
        ORDER BY an.article_id, an.id DESC)
      SELECT l.article_id AS id, a.title, s.name AS source, s.tier, to_char(a.discovered_at AT TIME ZONE 'Asia/Shanghai', 'MM-DD') AS day,
             l.score, l.selected
      FROM latest l JOIN articles a ON a.id = l.article_id JOIN sources s ON s.id = a.source_id
      WHERE s.lane = 'news' AND l.relevance IN ('pass', 'unknown') AND l.score BETWEEN ${lo} AND ${hi}
      ORDER BY a.discovered_at DESC LIMIT ${Number(values.recent)}`;
    for (const [i, row] of rows.entries()) {
      if (meter.stopped) break;
      const c: RecentCase = { ...row, oldScore: row.score, oldSelected: row.selected, candidate: null, rerun: null };
      recent.push(c);
      await guarded(row.id, async () => {
        const input = await loadAnalyzeInput(row.id);
        if (!input) return;
        c.candidate = await score(input, "candidate", "recent", "最近稿件");
        if (i < Number(values.noise)) c.rerun = await score(input, "current", "noise", "模型波动");
      });
      if (i % 25 === 24) write();
    }
    write();
    // 4. Recent blocked items, sampled: the candidate prefilter, then the candidate score for what it lets through.
    const [count] = await sql<{ n: number }[]>`
      WITH latest AS (
        SELECT DISTINCT ON (an.article_id) an.article_id, an.relevance
        FROM analyses an JOIN articles a ON a.id = an.article_id
        WHERE a.discovered_at >= now() - make_interval(days => ${days})
        ORDER BY an.article_id, an.id DESC)
      SELECT count(*)::int AS n FROM latest l JOIN articles a ON a.id = l.article_id JOIN sources s ON s.id = a.source_id
      WHERE s.lane = 'news' AND l.relevance = 'block'`;
    blocked.total = count?.n ?? 0;
    const sample = await sql<{ id: string; title: string; source: string; day: string }[]>`
      WITH latest AS (
        SELECT DISTINCT ON (an.article_id) an.article_id, an.relevance
        FROM analyses an JOIN articles a ON a.id = an.article_id
        WHERE a.discovered_at >= now() - make_interval(days => ${days})
        ORDER BY an.article_id, an.id DESC)
      SELECT l.article_id AS id, a.title, s.name AS source, to_char(a.discovered_at AT TIME ZONE 'Asia/Shanghai', 'MM-DD') AS day
      FROM latest l JOIN articles a ON a.id = l.article_id JOIN sources s ON s.id = a.source_id
      WHERE s.lane = 'news' AND l.relevance = 'block'
      ORDER BY md5(l.article_id || 'rules-replay-20261113') LIMIT ${Number(values.blocked)}`;
    for (const row of sample) {
      if (meter.stopped) break;
      const b: BlockedCase = { ...row, label: null, reason: "", candidate: null };
      blocked.sampled.push(b);
      await guarded(row.id, async () => {
        const input = await loadAnalyzeInput(row.id);
        if (!input) return;
        const judged = await prefilter(input, "被挡稿件");
        if (!judged) return;
        b.label = judged.label;
        b.reason = judged.reason;
        if (judged.label !== "BLOCK") b.candidate = await score(input, "candidate", "blocked", "被挡稿件");
      });
    }
  } finally {
    await settle().catch((error) => errors.push(`final cost check: ${String(error).slice(0, 200)}`));
    write();
    await closeDb();
  }
  console.log(JSON.stringify({ out: outDir, calls: meter.calls, spentYuan: meter.spent, stopped: meter.stopped, errors: errors.length }));
}

if (import.meta.main) await main();
