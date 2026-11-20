// Pure parts of scripts/eval-replay.ts (TASK-0367, plan 1.10 part 2): the tallies of the read-only eval replay. No
// database, network, clock or model. Three label sources, each scored per named rule set and never mixed:
//  - the Owner's 116 decisive gold cases (industry/selection-gold) against (a) the snapshot frozen when they were
//    labelled, (b) each rules version the stored analyses carry, and (c) stored SelectBench runs;
//  - swipe answers against the system's decision at deal time, per card kind and per rules version (the deck is drawn
//    near the line, so these are rates of that sample, never site-wide rates);
//  - people's grouping corrections (counts) and the event shadow's agreement report.
// The report carries counts and gold case numbers only: no title, summary, article id, actor or reason.
import { tallySwipe, type SwipeTallyAnswer, type SwipeTallyCard } from "../packages/backend/src/admin/swipe.ts";
import type { ShadowAgreement } from "../packages/backend/src/pipeline/events/agreement.ts";
import { rulesVersion } from "./rules-live-compare.ts";

/**
 * Every table the replay reads, inside one read-only transaction as the private_ops role. tests/eval-replay.test.ts
 * runs the replay as a role that may read only these and checks the role catalogue grants private_ops SELECT on each.
 */
export const REPLAY_TABLES = [
  "analyses",
  "selectbench_runs",
  "selectbench_results",
  "receipts",
  "ai.swipe_cards",
  "ai.swipe_answers",
  "audit_log",
  "grouping_overrides",
  "settings",
  "events.shadow_decisions",
  "fact_articles",
  "facts",
  "stories",
  "pgboss.job",
] as const;

export type GoldDecision = "select" | "reject" | "either";
export interface GoldLabels {
  select: number[];
  reject: number[];
  either?: number[];
}
export interface GoldCandidate {
  n: number;
  id: string;
  selected?: boolean;
}
export interface GoldCase {
  n: number;
  articleId: string;
  /** The id eval-selection.ts and SelectBench give the case (scripts/gold-from-labels.ts). */
  caseId: string;
  gold: GoldDecision;
}

/** The labelled candidates, in case order; an unlabelled candidate is left out, a label without a candidate is an error. */
export function goldCases(labels: GoldLabels, candidates: readonly GoldCandidate[]): GoldCase[] {
  const decision = new Map<number, GoldDecision>();
  for (const [gold, ns] of [
    ["select", labels.select],
    ["reject", labels.reject],
    ["either", labels.either ?? []],
  ] as const)
    for (const n of ns) {
      if (decision.has(n)) throw new Error(`gold case ${n} has two labels`);
      decision.set(n, gold);
    }
  const known = new Set(candidates.map((c) => c.n));
  for (const n of decision.keys()) if (!known.has(n)) throw new Error(`gold case ${n} has no candidate`);
  return candidates
    .filter((c) => decision.has(c.n))
    .map((c) => ({ n: c.n, articleId: c.id, caseId: `owner-20261105-${String(c.n).padStart(3, "0")}`, gold: decision.get(c.n)! }))
    .sort((a, b) => a.n - b.n);
}

export interface GoldScore {
  /** Decisive cases (select or reject) in the label set. */
  decisive: number;
  /** Of them, those this source decided; the rest have no stored decision. */
  scored: number;
  missing: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  /** Rounded to 0.1 percent; null when there is nothing to divide by. */
  agreement: number | null;
  precision: number | null;
  recall: number | null;
  /** Red list, gold case numbers: the Owner said select, the system did not. */
  missed: number[];
  /** Red list, gold case numbers: the system selected, the Owner said reject. */
  wronglySelected: number[];
}

const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : null);

/** One source's decisions (selected or not, per case number) against the Owner's; "either" cases do not count. */
export function scoreGold(cases: readonly GoldCase[], selected: ReadonlyMap<number, boolean>): GoldScore {
  const out: GoldScore = {
    decisive: 0,
    scored: 0,
    missing: 0,
    tp: 0,
    fp: 0,
    fn: 0,
    tn: 0,
    agreement: null,
    precision: null,
    recall: null,
    missed: [],
    wronglySelected: [],
  };
  for (const c of cases) {
    if (c.gold === "either") continue;
    out.decisive++;
    const system = selected.get(c.n);
    if (system === undefined) {
      out.missing++;
      continue;
    }
    out.scored++;
    if (c.gold === "select" && system) out.tp++;
    else if (c.gold === "select") {
      out.fn++;
      out.missed.push(c.n);
    } else if (system) {
      out.fp++;
      out.wronglySelected.push(c.n);
    } else out.tn++;
  }
  out.agreement = percent(out.tp + out.tn, out.scored);
  out.precision = percent(out.tp, out.tp + out.fp);
  out.recall = percent(out.tp, out.tp + out.fn);
  return out;
}

/** (a) The site's 精选 flag frozen in the candidates file when the Owner labelled them (2026-11-05). */
export function snapshotBaseline(cases: readonly GoldCase[], candidates: readonly GoldCandidate[]): GoldScore {
  const byN = new Map(candidates.filter((c) => typeof c.selected === "boolean").map((c) => [c.n, c.selected!]));
  return scoreGold(cases, byN);
}

/** One stored judgement of a gold case: the latest per article and analyses.prompt_version (SQL), regrouped here. */
export interface StoredJudgement {
  articleId: string;
  promptVersion: string | null;
  /** analyses.selected: the judgement's own verdict (mean score reached the tier threshold); null counts as not selected. */
  selected: boolean | null;
  /** For picking the newest judgement when two prompt versions belong to one rules version. */
  id: number;
}
export interface RulesetScore extends GoldScore {
  /** The rules version (prefilter | score step versions), as scripts/rules-live-compare.ts names it. */
  key: string;
  /** The named rule set both steps belong to; null when unknown, mixed or older than the rule sets' names. */
  ruleset: string | null;
}

/** (b) The stored analyses of the gold cases, one baseline per rules version; each case counts once per version (newest). */
export function storedBaselines(cases: readonly GoldCase[], rows: readonly StoredJudgement[]): RulesetScore[] {
  const nOf = new Map(cases.map((c) => [c.articleId, c.n]));
  const groups = new Map<string, { ruleset: string | null; newest: Map<number, StoredJudgement> }>();
  for (const row of rows) {
    const n = nOf.get(row.articleId);
    if (n === undefined) continue;
    const v = rulesVersion(row.promptVersion);
    const group = groups.get(v.key) ?? { ruleset: v.ruleset, newest: new Map() };
    groups.set(v.key, group);
    const before = group.newest.get(n);
    if (!before || row.id > before.id) group.newest.set(n, row);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      ruleset: g.ruleset,
      ...scoreGold(cases, new Map([...g.newest].map(([n, row]) => [n, row.selected === true]))),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** One stored SelectBench result of a gold case (selectbench_results joined to its run; no title, no reason). */
export interface BenchRow {
  runId: string;
  createdAt: string;
  promptVersion: string | null;
  model: string;
  caseId: string;
  /** "select", "reject", or null when the case failed. */
  decision: string | null;
}
export interface BenchScore extends GoldScore {
  runId: string;
  createdAt: string;
  model: string;
  key: string;
  ruleset: string | null;
  /** Results on gold cases without a decision (errors). */
  failed: number;
}

/** (c) Stored SelectBench runs on the gold cases, per run and model, scored against today's labels (not the run's copy). */
export function benchBaselines(cases: readonly GoldCase[], rows: readonly BenchRow[]): BenchScore[] {
  const nOf = new Map(cases.map((c) => [c.caseId, c.n]));
  const groups = new Map<string, { row: BenchRow; decided: Map<number, boolean>; failed: number }>();
  for (const row of rows) {
    const n = nOf.get(row.caseId);
    if (n === undefined) continue;
    const id = `${row.runId}\u0000${row.model}`;
    const group = groups.get(id) ?? { row, decided: new Map(), failed: 0 };
    groups.set(id, group);
    if (row.decision === "select" || row.decision === "reject") group.decided.set(n, row.decision === "select");
    else group.failed++;
  }
  return [...groups.values()]
    .map(({ row, decided, failed }) => {
      const v = rulesVersion(row.promptVersion);
      return { runId: row.runId, createdAt: row.createdAt, model: row.model, key: v.key, ruleset: v.ruleset, failed, ...scoreGold(cases, decided) };
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.runId.localeCompare(b.runId) || a.model.localeCompare(b.model));
}

export type GlobalBaseline =
  | { status: "available"; from: Array<"analyses" | "selectbench">; scored: number }
  | { status: "not available, needs budget"; scored: 0 };

/**
 * Whether stored data already scores the live global rule set on the gold cases. The replay never calls a model: when
 * neither the stored analyses nor a stored SelectBench run carries the global rule set, the answer is "needs budget".
 */
export function globalBaseline(stored: readonly RulesetScore[], bench: readonly BenchScore[]): GlobalBaseline {
  const fromStored = stored.filter((s) => s.ruleset === "global" && s.scored > 0);
  const fromBench = bench.filter((b) => b.ruleset === "global" && b.scored > 0);
  const scored = Math.max(0, ...fromStored.map((s) => s.scored), ...fromBench.map((b) => b.scored));
  if (!scored) return { status: "not available, needs budget", scored: 0 };
  return { status: "available", from: [...(fromStored.length ? ["analyses" as const] : []), ...(fromBench.length ? ["selectbench" as const] : [])], scored };
}

/** One dealt card with the rules version of the analysis it was dealt from (null when that analysis is gone). */
export interface SwipeCardRow extends SwipeTallyCard {
  kind: string;
  promptVersion: string | null;
}
export type SwipeCounts = ReturnType<typeof tallySwipe> & { cards: number; unanswered: number };
export interface SwipeReport {
  cards: number;
  decks: number;
  total: SwipeCounts;
  byKind: Array<{ kind: string } & SwipeCounts>;
  byRuleset: Array<{ key: string; ruleset: string | null } & SwipeCounts>;
}

/** The desk's own tally (admin/swipe.ts) over every dealt deck, per card kind and per rules version. */
export function swipeReport(cards: readonly SwipeCardRow[], answers: readonly SwipeTallyAnswer[]): SwipeReport {
  const cardKey = (row: { day: string; article_id: string }) => `${row.day}:${row.article_id}`;
  const counted = (subset: readonly SwipeCardRow[]): SwipeCounts => {
    // Only the answers of these cards: an answer whose card is outside the subset must not count as "not selected".
    const keys = new Set(subset.map(cardKey));
    const mine = answers.filter((a) => keys.has(cardKey(a)));
    const answered = new Set(mine.filter((a) => a.answer === "no" || a.answer === "yes" || a.answer === "star").map(cardKey));
    return { cards: subset.length, unanswered: subset.length - answered.size, ...tallySwipe(subset, mine) };
  };
  const by = <K extends string>(key: (row: SwipeCardRow) => K) => {
    const groups = new Map<K, SwipeCardRow[]>();
    for (const row of cards) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  };
  return {
    cards: cards.length,
    decks: new Set(cards.map((c) => c.day)).size,
    total: counted(cards),
    byKind: by((row) => row.kind).map(([kind, rows]) => ({ kind, ...counted(rows) })),
    byRuleset: by((row) => rulesVersion(row.promptVersion).key).map(([key, rows]) => ({
      key,
      ruleset: rulesVersion(rows[0]!.promptVersion).ruleset,
      ...counted(rows),
    })),
  };
}

/** People's grouping corrections by action (audit_log), all time and in the window; the merges the engine made itself are not corrections. */
export interface CorrectionRow {
  action: string;
  total: number;
  inWindow: number;
}
export interface GroupingReport {
  windowDays: number;
  corrections: CorrectionRow[];
  /** grouping_overrides rows by mode: the current state only (a row is deleted on an explicit regroup). */
  overrides: Array<{ mode: string; rows: number }>;
  /** The settings value of events.shadow; the shadow is off unless it is "on". */
  shadowSwitch: string | null;
  /** events.shadow_decisions rows per rule set, all time. */
  shadowRows: Array<{ ruleset: string; rows: number }>;
  /** The shadow agreement report of the window (pipeline/events/agreement.ts), counts only. */
  agreement: ShadowAgreement;
}

export interface ReplayReport {
  generatedAt: string;
  /** SHOW transaction_read_only inside the replay's transaction. */
  readOnly: boolean;
  gold: {
    labels: { decisive: number; select: number; reject: number; either: number };
    snapshot: GoldScore;
    stored: RulesetScore[];
    selectbench: BenchScore[];
    global: GlobalBaseline;
    /** Evaluation receipts since the gold was labelled, per purpose and step version (an identical re-run reuses them). */
    evaluationReceipts: Array<{ purpose: string; version: string | null; receipts: number }>;
  };
  swipe: SwipeReport;
  grouping: GroupingReport;
}

const pct = (value: number | null) => (value === null ? "—" : `${value}%`);
const share = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 1000) / 10}%` : "—");
const name = (ruleset: string | null, key: string) => `${ruleset ?? "未命名规则"}（${key}）`;
const scoreLine = (s: GoldScore) =>
  `判定 ${s.scored}/${s.decisive}，一致 ${pct(s.agreement)}，准确 ${pct(s.precision)}（${s.tp}/${s.tp + s.fp}），召回 ${pct(s.recall)}（${s.tp}/${s.tp + s.fn}），漏选 ${s.fn}，错选 ${s.fp}`;
const swipeLine = (c: SwipeCounts) =>
  `卡 ${c.cards}，已答 ${c.answered}（不值 ${c.no}、值得 ${c.yes}、星标 ${c.star}），未答 ${c.unanswered}；星标未进精选 ${c.missed}（${share(c.missed, c.star)}），进了精选但没星标 ${c.extra}，预筛拦下但答值得或星标 ${c.widened}`;

/** The lines printed to stdout: counts only, no case numbers. */
export function summaryLines(r: ReplayReport): string[] {
  const g = r.grouping;
  return [
    `评测回放（只读事务：${r.readOnly ? "是" : "否"}，生成于 ${r.generatedAt}）`,
    `金标：可判 ${r.gold.labels.decisive} 篇（该选 ${r.gold.labels.select}、不该选 ${r.gold.labels.reject}），两可 ${r.gold.labels.either} 篇不计`,
    `  (a) 11-05 冻结快照：${scoreLine(r.gold.snapshot)}`,
    ...(r.gold.stored.length
      ? r.gold.stored.map((s) => `  (b) 库存分析 ${name(s.ruleset, s.key)}：${scoreLine(s)}`)
      : ["  (b) 库存分析：金标稿件没有分析记录"]),
    ...(r.gold.selectbench.length
      ? r.gold.selectbench.map((b) => `  (c) SelectBench ${b.runId} ${b.model} ${name(b.ruleset, b.key)}：${scoreLine(b)}，失败 ${b.failed}`)
      : ["  (c) SelectBench：没有金标稿件的评测记录"]),
    r.gold.global.status === "available"
      ? `  现行 global 规则：已有库存数据（${r.gold.global.from.join("、")}，最多 ${r.gold.global.scored} 篇）`
      : "  现行 global 规则：not available, needs budget（库里没有，本脚本不调用模型）",
    `  评测回执（金标标注日之后）：${r.gold.evaluationReceipts.reduce((n, e) => n + e.receipts, 0)} 条`,
    `刷卡：${r.swipe.decks} 天，${swipeLine(r.swipe.total)}`,
    ...r.swipe.byKind.map((k) => `  按卡类 ${k.kind}：${swipeLine(k)}`),
    ...r.swipe.byRuleset.map((k) => `  按规则 ${name(k.ruleset, k.key)}：${swipeLine(k)}`),
    `归组人工纠正（全部 / 近 ${g.windowDays} 天）：${g.corrections.length ? g.corrections.map((c) => `${c.action} ${c.total}/${c.inWindow}`).join("，") : "没有"}`,
    `  保持独立等现存覆盖：${g.overrides.length ? g.overrides.map((o) => `${o.mode} ${o.rows}`).join("，") : "没有"}`,
    `  影子开关：${g.shadowSwitch ?? "未设置（关）"}；影子判定：${g.shadowRows.length ? g.shadowRows.map((s) => `${s.ruleset} ${s.rows}`).join("，") : "没有"}`,
    `  近 ${g.windowDays} 天影子对照：规则试判 ${g.agreement.judged}，人工纠正标注 ${g.agreement.human.pairs} 对；规则对 ${g.agreement.human.shadowRight}、错 ${g.agreement.human.shadowWrong}，现网对 ${g.agreement.human.liveRight}、错 ${g.agreement.human.liveWrong}${g.agreement.human.truncated ? "（纠正记录超过读取上限）" : ""}`,
  ];
}

/** The Markdown report: the summary plus the gold red lists (case numbers from the public candidates file). */
export function renderReport(r: ReplayReport): string {
  const red = (label: string, s: GoldScore) => [
    `- ${label}：漏选 ${s.missed.length ? s.missed.join(", ") : "无"}；错选 ${s.wronglySelected.length ? s.wronglySelected.join(", ") : "无"}`,
  ];
  return `${[
    "# 评测回放（只读）",
    "",
    "```",
    ...summaryLines(r),
    "```",
    "",
    "## 金标红单（金标编号 n，见 industry/selection-gold/owner-20261105-candidates.json）",
    "",
    ...red("(a) 11-05 冻结快照", r.gold.snapshot),
    ...r.gold.stored.flatMap((s) => red(`(b) 库存分析 ${name(s.ruleset, s.key)}`, s)),
    ...r.gold.selectbench.flatMap((b) => red(`(c) SelectBench ${b.runId} ${b.model}`, b)),
    "",
    "## 口径",
    "",
    "- 各规则版本分开算，不混合；“两可”不计；没有判定的金标稿件算缺失，不算错。",
    "- 刷卡的牌按“靠近门槛、两次打分分歧、预筛拦下、复查”抽取，比率只代表这批牌，不代表全站。",
    "- 归组纠正只数人做的拆分、合并与重归组；归组步骤自己的合并不算。现存覆盖在重新归组时会被删除，历史以审计记录为准。",
    "- 本报告只有计数和金标编号，没有标题、正文、稿件编号或操作人。",
  ].join("\n")}\n`;
}
