// Daily comparison of the selection rules on real results (TASK-0670, Owner 2026-11-13: ship the new rules first, then
// verify and compare on real data). Read-only: it reads judgements, publications and receipts inside one read-only
// transaction, calls no model and writes no row. Run it once a day after go-live and paste the Markdown on the board:
//   node scripts/rules-live-compare.ts [--live-date 2026-11-15] [--days 21] [--titles 100] [--out .data/rules-live-compare]
// Per Beijing day and per rules version it reports the articles analysed, the prefilter pass rate, the items in “全部”,
// the items in 精选 and what the prefilter and score steps cost that day, beside the mean of the seven days before
// go-live; then the titles and sources selected under the new rules. What each number counts is in COUNTED below and
// at the end of the report. A cost the receipts do not carry is reported as missing, never added as 0.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { config } from "@amp/backend/config";
import { closeDb, initializeDb, sql } from "@amp/backend/db";
import { SELECTION, SELECTION_RULESETS, type SelectionRuleset } from "@amp/industry/selection";

/** One Beijing day's latest judgements under one stored analyses.prompt_version (the SQL groups, the code regroups). */
export interface JudgementRow {
  day: string;
  promptVersion: string | null;
  /** Articles whose latest judgement was made that day. */
  analysed: number;
  /** Of them, those the prefilter answered (PASS, BLOCK or UNKNOWN); the rest waited for material. */
  judged: number;
  /** Of the judged, those that went on (PASS or UNKNOWN). */
  passed: number;
  /** Listed in “全部” now. */
  inAll: number;
  /** Of those, shown without a search (at or above the browse floor, unscored, or a pick). */
  inAllShown: number;
  /** The mean score reached the tier threshold (the judgement's own verdict, before grouping confirms the pick). */
  scoreSelected: number;
  /** Carrying the 精选 mark in public now. */
  selected: number;
}
/** One Beijing day's attempts of one step under one step prompt version (receipts.request.promptVersion). */
export interface CostRow {
  day: string;
  step: "prefilter" | "score";
  version: string | null;
  attempts: number;
  /** Attempts with no usable CNY cost: no cost recorded, or another currency. */
  unpriced: number;
  /** The priced attempts' sum; null when none was priced. */
  cny: number | null;
}
export interface PickRow {
  day: string;
  promptVersion: string | null;
  title: string;
  source: string;
  tier: string;
  score: number | null;
  /** In 精选 in public now; false while the pick waits for grouping or its release time, or was not confirmed. */
  inSelected: boolean;
}

export interface Cost {
  cny: number | null;
  attempts: number;
  unpriced: number;
}
export type Counts = Omit<JudgementRow, "day" | "promptVersion">;
export interface Cell extends Counts {
  cost: Cost;
}
export interface RulesVersion {
  key: string;
  prefilter: string | null;
  score: string | null;
  /** The rule set both step versions are named after; null when unknown, mixed or older than the rule sets' names. */
  ruleset: SelectionRuleset | null;
}

const COUNT_KEYS = ["analysed", "judged", "passed", "inAll", "inAllShown", "scoreSelected", "selected"] as const;
const noCost = (): Cost => ({ cny: null, attempts: 0, unpriced: 0 });
const emptyCell = (): Cell => ({ analysed: 0, judged: 0, passed: 0, inAll: 0, inAllShown: 0, scoreSelected: 0, selected: 0, cost: noCost() });

/** Adds a cost without turning a missing one into 0: the sum stays null until some attempt was priced. */
export function addCost(into: Cost, add: Cost): Cost {
  into.cny = add.cny === null ? into.cny : (into.cny ?? 0) + add.cny;
  into.attempts += add.attempts;
  into.unpriced += add.unpriced;
  return into;
}

/** The prefilter and score step versions inside a stored analyses.prompt_version (step versions joined by "+"). */
export function stepVersions(promptVersion: string | null): { prefilter: string | null; score: string | null } {
  const tokens = (promptVersion ?? "").split("+");
  const at = tokens.findIndex((t) => t.startsWith("selection-score"));
  const score = at < 0 ? null : tokens[at + 1]?.startsWith("weights@") ? `${tokens[at]}+${tokens[at + 1]}` : tokens[at]!;
  return { prefilter: tokens.find((t) => t.startsWith("prefilter")) ?? null, score };
}

/** The rule set a step version is named after: its file name, with the shared layout's suffix and the hash removed. */
function rulesetOfStep(version: string | null, step: "prefilter" | "score"): SelectionRuleset | null {
  if (!version) return null;
  const name = version.split("@")[0]!.replace(/-shared$/, "");
  return (Object.keys(SELECTION_RULESETS) as SelectionRuleset[]).find((r) => SELECTION_RULESETS[r][step] === name) ?? null;
}

export function rulesVersion(promptVersion: string | null): RulesVersion {
  const { prefilter, score } = stepVersions(promptVersion);
  const byPrefilter = rulesetOfStep(prefilter, "prefilter"),
    byScore = rulesetOfStep(score, "score");
  // A judgement stopped after the prefilter stores only that step's version.
  const ruleset = score === null ? byPrefilter : byPrefilter === byScore ? byScore : null;
  return { key: `${prefilter ?? "?"} | ${score ?? "?"}`, prefilter, score, ruleset };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A calendar day `n` days from `day` (YYYY-MM-DD). */
export function addDays(day: string, n: number): string {
  if (!DAY.test(day)) throw new Error(`not a day: ${day}`);
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
/** The Beijing calendar day of an instant. */
export function beijingDay(instant: Date): string {
  return new Date(instant.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

export interface Baseline {
  /** The seven days before go-live, first and last. */
  from: string;
  to: string;
  /** Days of those seven with any judgement. */
  days: number;
  /** Per-day means over those days. */
  mean: Counts | null;
  /** Mean of the days' costs, over the days that have a priced cost. */
  costMean: number | null;
  costDays: number;
  unpriced: number;
}
export interface Summary {
  versions: RulesVersion[];
  /** Day → rules version key → numbers; days ascending. */
  days: Array<{ day: string; cells: Array<{ version: RulesVersion; cell: Cell }>; total: Cell; unassigned: Cost }>;
  liveDate: string | null;
  liveDateFrom: "argument" | "first global judgement" | null;
  baseline: Baseline | null;
  /** Days from go-live whose two-step cost is more than double the baseline mean (the card's line for a rollback call). */
  costAlerts: Array<{ day: string; cny: number; ratio: number }>;
}

/**
 * Regroups the SQL rows by day and rules version, attaches each step's cost to the version that names it, and takes
 * the seven days before go-live as the baseline. `liveDate` is the Beijing day the new rules went live; without it,
 * the first day with a judgement under the global rule set.
 */
export function summarize(rows: readonly JudgementRow[], costs: readonly CostRow[], liveDate?: string): Summary {
  if (liveDate !== undefined && !DAY.test(liveDate)) throw new Error(`--live-date must be YYYY-MM-DD (got "${liveDate}")`);
  const full = new Map<string, RulesVersion>();
  for (const row of rows) {
    const v = rulesVersion(row.promptVersion);
    if (v.score !== null) full.set(v.key, v);
  }
  // A judgement that stopped after the prefilter belongs with the full judgements of the same prefilter version, when
  // exactly one rules version has it; otherwise it stays on its own line.
  const resolve = (promptVersion: string | null): RulesVersion => {
    const v = rulesVersion(promptVersion);
    if (v.score !== null || v.prefilter === null) return v;
    const same = [...full.values()].filter((f) => f.prefilter === v.prefilter);
    return same.length === 1 ? same[0]! : v;
  };
  const versions = new Map<string, RulesVersion>();
  const firstDay = new Map<string, string>();
  const days = new Map<string, { cells: Map<string, Cell>; unassigned: Cost }>();
  const dayOf = (day: string) => {
    if (!days.has(day)) days.set(day, { cells: new Map(), unassigned: noCost() });
    return days.get(day)!;
  };
  const cellOf = (day: string, v: RulesVersion) => {
    versions.set(v.key, v);
    if (!firstDay.has(v.key) || day < firstDay.get(v.key)!) firstDay.set(v.key, day);
    const cells = dayOf(day).cells;
    if (!cells.has(v.key)) cells.set(v.key, emptyCell());
    return cells.get(v.key)!;
  };
  for (const row of rows) {
    const cell = cellOf(row.day, resolve(row.promptVersion));
    for (const key of COUNT_KEYS) cell[key] += row[key];
  }
  for (const row of costs) {
    const cost: Cost = { cny: row.cny, attempts: row.attempts, unpriced: row.unpriced };
    const owners = row.version === null ? [] : [...versions.values()].filter((v) => v[row.step] === row.version);
    // A step version no judgement names, or one several rules versions share, cannot be split: it is shown apart.
    addCost(owners.length === 1 ? cellOf(row.day, owners[0]!).cost : dayOf(row.day).unassigned, cost);
  }
  // Versions in the order they first appear, so the earlier rules come first.
  const order = [...versions.values()].sort((a, b) => firstDay.get(a.key)!.localeCompare(firstDay.get(b.key)!) || a.key.localeCompare(b.key));
  const out: Summary["days"] = [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, d]) => {
      const total = emptyCell();
      for (const cell of d.cells.values()) {
        for (const key of COUNT_KEYS) total[key] += cell[key];
        addCost(total.cost, cell.cost);
      }
      addCost(total.cost, d.unassigned);
      return {
        day,
        cells: order.filter((v) => d.cells.has(v.key)).map((version) => ({ version, cell: d.cells.get(version.key)! })),
        total,
        unassigned: d.unassigned,
      };
    });
  const firstGlobal = out.find((d) => d.cells.some((c) => c.version.ruleset === "global" && c.cell.analysed > 0))?.day ?? null;
  const live = liveDate ?? firstGlobal;
  let baseline: Baseline | null = null;
  const costAlerts: Summary["costAlerts"] = [];
  if (live) {
    const from = addDays(live, -7),
      to = addDays(live, -1);
    const before = out.filter((d) => d.day >= from && d.day <= to && d.total.analysed > 0);
    const priced = before.filter((d) => d.total.cost.cny !== null);
    const mean = (pick: (cell: Cell) => number) => before.reduce((sum, d) => sum + pick(d.total), 0) / before.length;
    baseline = {
      from,
      to,
      days: before.length,
      mean: before.length ? (Object.fromEntries(COUNT_KEYS.map((key) => [key, mean((cell) => cell[key])])) as unknown as Counts) : null,
      costMean: priced.length ? priced.reduce((sum, d) => sum + d.total.cost.cny!, 0) / priced.length : null,
      costDays: priced.length,
      unpriced: before.reduce((sum, d) => sum + d.total.cost.unpriced, 0),
    };
    if (baseline.costMean !== null && baseline.costMean > 0)
      for (const d of out)
        if (d.day >= live && d.total.cost.cny !== null && d.total.cost.cny > 2 * baseline.costMean)
          costAlerts.push({ day: d.day, cny: d.total.cost.cny, ratio: d.total.cost.cny / baseline.costMean });
  }
  return {
    versions: order,
    days: out,
    liveDate: live,
    liveDateFrom: liveDate ? "argument" : firstGlobal ? "first global judgement" : null,
    baseline,
    costAlerts,
  };
}

/** The picks made under the global rule set, newest day first. */
export function globalPicks(picks: readonly PickRow[]): PickRow[] {
  return picks.filter((p) => rulesVersion(p.promptVersion).ruleset === "global").sort((a, b) => b.day.localeCompare(a.day));
}

const RULESET_NAMES: Record<SelectionRuleset, string> = { global: "新规则", classic: "原规则" };
const round = (v: number, digits: number) => String(Math.round(v * 10 ** digits) / 10 ** digits);
const rate = (part: number, whole: number) => (whole ? `${round((part / whole) * 100, 1)}%` : "—");
const cellText = (s: string) => s.replaceAll("|", "／").replaceAll("\n", " ").slice(0, 80);
/** A cost as a person reads it: the priced sum, and how many attempts it leaves out; "—" when nothing was priced. */
export function costText(cost: Cost): string {
  const missing = cost.unpriced ? `${cost.unpriced} 次调用没有费用记录，未计入` : "";
  if (cost.cny === null) return cost.attempts ? `—（${missing}）` : "—";
  return `${round(cost.cny, 2)}${missing ? `（另有 ${missing}）` : ""}`;
}

export const COUNTED = [
  "日期按北京时间。每篇稿件按它最近一次分析的那一天、那一版规则计一次；只算资讯线。",
  "预筛放行率 = 放行（PASS 或 UNKNOWN）÷ 已给出判断的篇数；等正文、还没判断的不算在分母里。",
  `进“全部” = 现在公开、在“全部”列表里的条数；“默认显示”是其中不用搜索就能看到的（未打分、不低于 ${SELECTION.browseFloor} 分，或已是精选）。`,
  "评分达线 = 平均分达到所属信源分级的门槛；进精选 = 现在公开页面上带精选标记的条数（要等同一事件归组确认和放出时间，会比“评分达线”晚、也可能少）。",
  "两步费用 = 当天预筛和评分两步实际发出的每一次调用（含重试，不含评测和回放）的回执金额之和，单位元；没有费用记录或不是人民币的调用单独计数，不当作 0。",
  "上线前七天均值 = 上线日之前七个自然日里有数据的各天合计的平均；费用只按有费用记录的那些天平均。",
];

/** The report as Chinese Markdown, conclusions first. */
export function renderReport(summary: Summary, picks: readonly PickRow[], opts: { generatedAt: string; titles: number }): string {
  const lines: string[] = ["# 新旧评分规则每日对比（真实数据）", ""];
  const { baseline } = summary;
  lines.push(
    `生成时间：${opts.generatedAt}（UTC）。${
      summary.liveDate
        ? `上线日：${summary.liveDate}（${summary.liveDateFrom === "argument" ? "按参数" : "按第一条新规则判断推定"}）。`
        : "数据里还没有新规则下的判断，也没有指定上线日，下面只有各天的数字，没有上线前均值。"
    }`,
    "",
  );
  if (baseline) {
    lines.push(
      baseline.mean
        ? `上线前七天（${baseline.from} 至 ${baseline.to}，有数据 ${baseline.days} 天）日均：进入分析 ${round(baseline.mean.analysed, 1)} 篇，预筛放行率 ${rate(baseline.mean.passed, baseline.mean.judged)}，进“全部” ${round(baseline.mean.inAll, 1)} 条，进精选 ${round(baseline.mean.selected, 1)} 条，两步费用 ${
            baseline.costMean === null ? "没有费用记录" : `${round(baseline.costMean, 2)} 元（按有费用记录的 ${baseline.costDays} 天）`
          }${baseline.unpriced ? `；这七天另有 ${baseline.unpriced} 次调用没有费用记录，未计入` : ""}。`
        : `上线前七天（${baseline.from} 至 ${baseline.to}）没有查到分析记录，暂时没有均值可比；如果是查询范围不够，把 --days 调大后重跑。`,
      "",
    );
    if (summary.costAlerts.length)
      lines.push(
        `**费用提醒**：${summary.costAlerts.map((a) => `${a.day} 两步费用 ${round(a.cny, 2)} 元，是上线前日均的 ${round(a.ratio, 1)} 倍`).join("；")}。已超过“高出一倍”这条线，请先贴数，由 Claude 定是否回撤。`,
        "",
      );
    else if (baseline.costMean !== null) lines.push("上线以来各天的两步费用都没有超过上线前日均的两倍。", "");
  }
  lines.push("## 一、按天、按规则版本", "");
  lines.push(
    "| 日期 | 规则 | 进入分析 | 预筛放行率（放行/已判） | 进“全部” | 其中默认显示 | 评分达线 | 进精选 | 两步费用（元） |",
    "|---|---|---|---|---|---|---|---|---|",
  );
  const label = new Map(summary.versions.map((v, i) => [v.key, `${v.ruleset ? RULESET_NAMES[v.ruleset] : "其他"}·版本${i + 1}`]));
  const row = (day: string, name: string, c: Cell) =>
    `| ${day} | ${name} | ${c.analysed} | ${rate(c.passed, c.judged)}（${c.passed}/${c.judged}） | ${c.inAll} | ${c.inAllShown} | ${c.scoreSelected} | ${c.selected} | ${costText(c.cost)} |`;
  for (const d of summary.days) {
    for (const { version, cell } of d.cells) lines.push(row(d.day, label.get(version.key)!, cell));
    if (d.unassigned.attempts) lines.push(`| ${d.day} | 对不上规则版本的调用 | — | — | — | — | — | — | ${costText(d.unassigned)} |`);
    if (d.cells.length + (d.unassigned.attempts ? 1 : 0) > 1) lines.push(row(d.day, "**当天合计**", d.total));
  }
  if (!summary.days.length) lines.push("| — | 查询范围内没有分析记录 | — | — | — | — | — | — | — |");
  if (summary.versions.length) lines.push("", "版本对照：", "");
  for (const v of summary.versions) lines.push(`- ${label.get(v.key)}：预筛 \`${v.prefilter ?? "未记录"}\`，评分 \`${v.score ?? "未记录"}\``);
  const chosen = globalPicks(picks);
  lines.push("", `## 二、新规则下评分达线的稿件（${chosen.length} 条${chosen.length > opts.titles ? `，列出最近 ${opts.titles} 条` : ""}）`, "");
  if (chosen.length) {
    lines.push("| 日期 | 标题 | 来源 | 分数 | 已进精选 |", "|---|---|---|---|---|");
    for (const p of chosen.slice(0, opts.titles))
      lines.push(
        `| ${p.day} | ${cellText(p.title)} | ${cellText(p.source)}（${p.tier}） | ${p.score === null ? "—" : round(p.score, 1)} | ${p.inSelected ? "是" : "还没有"} |`,
      );
  } else lines.push("还没有。");
  lines.push("", "## 三、这些数字怎么算的", "", ...COUNTED.map((line) => `- ${line}`));
  return `${lines.join("\n")}\n`;
}

/** The three read-only queries, from the Beijing day `fromDay` on. The conditions mirror the reader lists (publication/items.ts). */
export async function collect(fromDay: string): Promise<{ rows: JudgementRow[]; costs: CostRow[]; picks: PickRow[] }> {
  const from = new Date(`${addDays(fromDay, 0)}T00:00:00+08:00`);
  return sql.begin(async (tx) => {
    await tx`SET TRANSACTION READ ONLY`;
    await tx`SET LOCAL statement_timeout = '120s'`;
    // Fragments are built anew for every query that embeds them.
    // Each article's latest judgement, when it was made in the window.
    const latest = () => tx`
      SELECT DISTINCT ON (an.article_id) an.article_id, an.prompt_version, an.created_at, an.score, coalesce(an.selected, false) AS score_selected,
             upper(an.output->'prefilter'->>'label') AS label
      FROM analyses an WHERE an.created_at >= ${from}
      ORDER BY an.article_id, an.input_revision DESC, an.id DESC`;
    const listed = () => tx`p.visibility = 'public' AND p.eligible AND (NOT p.selected OR p.visible_after <= now())
      AND (${config.originalPostAdmissionEnabled} OR NOT p.is_original_post OR p.original_post_admission_required IS FALSE)`;
    const picked = () => tx`p.selected AND p.selection_candidate`;
    const day = () => tx`to_char(l.created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')`;
    const rows = await tx<JudgementRow[]>`
      WITH latest AS (${latest()})
      SELECT ${day()} AS day, l.prompt_version AS "promptVersion",
             count(*)::int AS analysed,
             count(*) FILTER (WHERE l.label IN ('PASS', 'BLOCK', 'UNKNOWN'))::int AS judged,
             count(*) FILTER (WHERE l.label IN ('PASS', 'UNKNOWN'))::int AS passed,
             count(*) FILTER (WHERE ${listed()})::int AS "inAll",
             count(*) FILTER (WHERE ${listed()} AND (p.score IS NULL OR p.score >= ${SELECTION.browseFloor} OR ${picked()}))::int AS "inAllShown",
             count(*) FILTER (WHERE l.score_selected)::int AS "scoreSelected",
             count(*) FILTER (WHERE ${listed()} AND ${picked()})::int AS selected
      FROM latest l JOIN articles a ON a.id = l.article_id JOIN sources s ON s.id = a.source_id
      LEFT JOIN publications p ON p.article_id = l.article_id
      WHERE s.lane = 'news'
      GROUP BY 1, 2 ORDER BY 1, 2`;
    const costs = await tx<CostRow[]>`
      SELECT to_char(a.started_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS day,
             CASE r.purpose WHEN 'prefilter_article' THEN 'prefilter' ELSE 'score' END AS step,
             r.request->>'promptVersion' AS version,
             count(*)::int AS attempts,
             count(*) FILTER (WHERE a.cost IS NULL OR coalesce(nullif(trim(a.currency), ''), 'CNY') <> 'CNY')::int AS unpriced,
             (sum(a.cost) FILTER (WHERE coalesce(nullif(trim(a.currency), ''), 'CNY') = 'CNY'))::float AS cny
      FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id
      WHERE a.started_at >= ${from} AND a.origin = 'live' AND r.purpose IN ('prefilter_article', 'score_article')
        AND coalesce(r.request->>'usage_purpose', 'production') = 'production'
      GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`;
    const picks = await tx<PickRow[]>`
      WITH latest AS (${latest()})
      SELECT ${day()} AS day, l.prompt_version AS "promptVersion", coalesce(nullif(trim(p.title), ''), a.title) AS title,
             s.name AS source, s.tier, l.score::float AS score, coalesce(${listed()} AND ${picked()}, false) AS "inSelected"
      FROM latest l JOIN articles a ON a.id = l.article_id JOIN sources s ON s.id = a.source_id
      LEFT JOIN publications p ON p.article_id = l.article_id
      WHERE s.lane = 'news' AND l.score_selected
      ORDER BY l.created_at DESC LIMIT 1000`;
    return { rows: [...rows], costs: [...costs], picks: [...picks] };
  }) as Promise<{ rows: JudgementRow[]; costs: CostRow[]; picks: PickRow[] }>;
}

async function main() {
  const { values } = parseArgs({
    options: { "live-date": { type: "string" }, days: { type: "string", default: "21" }, titles: { type: "string", default: "100" }, out: { type: "string" } },
  });
  const days = Number(values.days),
    titles = Number(values.titles),
    liveDate = values["live-date"];
  if (!Number.isInteger(days) || days < 1 || days > 90 || !Number.isInteger(titles) || titles < 1 || (liveDate !== undefined && !DAY.test(liveDate)))
    throw new Error("Usage: rules-live-compare.ts [--live-date YYYY-MM-DD] [--days 1-90] [--titles N] [--out dir]");
  const now = new Date();
  const earliest = addDays(beijingDay(now), -(days - 1));
  // With a go-live day, the window always reaches its seven days before.
  const fromDay = liveDate && addDays(liveDate, -7) < earliest ? addDays(liveDate, -7) : earliest;
  await initializeDb("worker");
  try {
    const data = await collect(fromDay);
    const summary = summarize(data.rows, data.costs, liveDate);
    const report = renderReport(summary, data.picks, { generatedAt: now.toISOString(), titles });
    if (values.out) {
      const dir = path.resolve(values.out, now.toISOString().replace(/[:.]/g, "-"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "report.md"), report);
      writeFileSync(
        path.join(dir, "report.json"),
        `${JSON.stringify({ generatedAt: now.toISOString(), fromDay, summary, picks: globalPicks(data.picks) }, null, 2)}\n`,
      );
    }
    process.stdout.write(report);
  } finally {
    await closeDb();
  }
}

if (import.meta.main) await main();
