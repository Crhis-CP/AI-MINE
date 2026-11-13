// The rules replay (TASK-0643): swapping in the 3.1 candidate rules, the comparisons it reports, the cost cap and
// pacing. No database and no model: the parts that decide what the Owner reads are pure.
import assert from "node:assert/strict";
import { test } from "node:test";
import { selectionSystem } from "../packages/backend/src/editorial/analyze.ts";
import {
  candidateSystem,
  costOf,
  goldIncomplete,
  receiptOf,
  settledRun,
  type GoldCase,
  goldMetrics,
  Meter,
  noiseOf,
  type RecentCase,
  recentShifts,
  renderReport,
  replaceOnce,
  rulesTexts,
  thresholdSweep,
} from "../scripts/rules-replay.ts";

test("the current rules are replaced exactly once, or the replay refuses to run", () => {
  assert.equal(replaceOnce("a-X-b", "X", "Y", "t"), "a-Y-b");
  assert.throws(() => replaceOnce("a-b", "X", "Y", "t"), /exactly once.*found 0/);
  assert.throws(() => replaceOnce("X-X", "X", "Y", "t"), /exactly once.*found 2/);
});

test("both layouts swap in the candidate rules and keep everything else", () => {
  const texts = rulesTexts();
  assert.notEqual(texts.candidate.score, texts.current.score);
  assert.notEqual(texts.candidate.prefilter, texts.current.prefilter);
  assert.match(texts.candidate.score, /影响面/);
  assert.doesNotMatch(texts.candidate.score, /直接涉及中国/);
  assert.match(texts.candidate.prefilter, /资源国的政治与安全风险/);
  const shared = candidateSystem("score", "shared", texts);
  assert.equal(candidateSystem("prefilter", "shared", texts), shared, "one shared system prompt holds both rules");
  // Swapping the current rules back restores the production prompt byte for byte: nothing else changed.
  const back = (system: string, pairs: [string, string][]) => pairs.reduce((text, [from, to]) => replaceOnce(text, from, to, "back"), system);
  assert.equal(
    back(shared, [
      [texts.candidate.score, texts.current.score],
      [texts.candidate.prefilter, texts.current.prefilter],
    ]),
    selectionSystem("score", "shared"),
  );
  assert.equal(back(candidateSystem("score", "separate", texts), [[texts.candidate.score, texts.current.score]]), selectionSystem("score", "separate"));
  const prefilter = candidateSystem("prefilter", "separate", texts);
  assert.equal(back(prefilter, [[texts.candidate.prefilter, texts.current.prefilter]]), selectionSystem("prefilter", "separate"));
});

const run = (mean: number, selected: boolean) => ({ values: [mean], mean, selected, reson: [5] });
const goldCase = (decision: GoldCase["decision"], current: boolean, candidate: boolean, mean = 60): GoldCase => ({
  caseId: `owner-${decision}-${current}-${candidate}-${mean}`,
  title: "合成",
  tier: "T2",
  decision,
  current: run(mean, current),
  candidate: run(mean + (candidate ? 10 : -10), candidate),
});

test("gold metrics count against the Owner's labels and leave 'either' out", () => {
  const cases = [
    goldCase("select", true, true),
    goldCase("select", false, true),
    goldCase("reject", true, false),
    goldCase("reject", false, false),
    goldCase("either", true, false),
  ];
  const cur = goldMetrics(cases, "current"),
    cand = goldMetrics(cases, "candidate");
  assert.deepEqual([cur.tp, cur.fp, cur.fn, cur.tn, cur.total], [1, 1, 1, 1, 4]);
  assert.deepEqual([cand.tp, cand.fp, cand.fn, cand.tn], [2, 0, 0, 2]);
  assert.equal(cand.f1, 1);
  const sweep = thresholdSweep(cases, "candidate");
  assert.equal(sweep[0]!.threshold, 50);
  assert.equal(sweep.at(-1)!.threshold, 80);
  assert.equal(sweep.find((row) => row.threshold === 62)!.tp, 2, "a flat threshold judges by the mean");
});

const recentCase = (oldSelected: boolean, candidate: boolean | null, rerun: boolean | null = null): RecentCase => ({
  id: `a-${Math.random()}`,
  title: "合成",
  source: "合成来源",
  tier: "T2",
  day: "11-12",
  oldScore: 64,
  oldSelected,
  candidate: candidate === null ? null : run(candidate ? 70 : 55, candidate),
  rerun: rerun === null ? null : run(rerun ? 67 : 61, rerun),
});

test("recent items fall into kept, dropped and added; the noise sample measures the model's own flips", () => {
  const shifts = recentShifts([recentCase(true, true), recentCase(true, false), recentCase(false, true), recentCase(false, false), recentCase(true, null)]);
  assert.equal(shifts.scored, 4);
  assert.deepEqual([shifts.keptIn.length, shifts.dropped.length, shifts.added.length, shifts.keptOut], [1, 1, 1, 1]);
  const noise = noiseOf([recentCase(true, true, true), recentCase(true, true, false), recentCase(false, false)]);
  assert.equal(noise.pairs, 2);
  assert.equal(noise.flips, 1);
  assert.equal(noise.meanShift, 3);
});

test("the meter paces calls and stops at the cost cap, naming the phase", async () => {
  let now = 0;
  const waits: number[] = [];
  const meter = new Meter(
    30,
    6,
    () => now,
    async (ms) => {
      waits.push(ms);
      now += ms;
    },
  );
  assert.equal(await meter.turn("金标集"), true);
  assert.equal(await meter.turn("金标集"), true);
  assert.deepEqual(waits, [10_000], "six a minute: one call every ten seconds");
  meter.spent = 30;
  assert.equal(await meter.turn("最近稿件"), false);
  assert.equal(meter.stopped, "最近稿件");
  meter.spent = 0;
  assert.equal(await meter.turn("被挡稿件"), false, "once stopped, the replay stays stopped");
  assert.equal(meter.calls, 2);
});

test("the report leads with the comparison and says where a capped run stopped", () => {
  const md = renderReport({
    startedAt: "2026-11-13T05:00:00Z",
    finishedAt: "2026-11-13T08:00:00Z",
    model: "deepseek",
    layout: "shared",
    versions: { candidateScore: "selection-score-global@abc" },
    meter: { calls: 120, spent: 30.2, maxYuan: 30, stopped: "被挡稿件" },
    days: 7,
    band: [45, 80],
    gold: [goldCase("select", false, true), goldCase("reject", false, false)],
    recent: [recentCase(true, false), recentCase(false, true)],
    blocked: {
      total: 700,
      sampled: [
        { id: "b1", title: "智利修改矿业权益金法案", source: "合成", day: "11-12", label: "PASS", reason: "资源国税制", candidate: run(70, true) },
        { id: "b2", title: "无关新闻", source: "合成", day: "11-12", label: "BLOCK", reason: "范围外", candidate: null },
      ],
    },
  });
  assert.match(md, /^# 3\.1 新规则回放报告/);
  assert.match(md, /到上限停在“被挡稿件”这一步/);
  assert.match(md, /两版判断不同的 1 篇/);
  assert.match(md, /原来入选、换规则后不选：\*\*1\*\* 篇；原来不选、换规则后入选：\*\*1\*\* 篇/);
  assert.match(md, /推算每天多收约 \*\*50\*\* 条/, "half of 700 blocked over 7 days");
  assert.match(md, /智利修改矿业权益金法案/);
  assert.doesNotMatch(md, /无关新闻/, "only what the candidate lets through is listed");
});

test("every attempt counts toward the cap: priced at cost, unpriced or foreign as one bounded call", () => {
  const rows = [
    { cost: 0.01, currency: "CNY" },
    { cost: null, currency: null },
    { cost: 0.02, currency: "CNY" },
    { cost: 0.5, currency: "USD" },
  ];
  const cost = costOf(rows, 0.1);
  assert.equal(cost.unpriced, 2);
  assert.equal(Math.round(cost.spent * 1000) / 1000, 0.23);
  assert.equal(cost.maxCost, 0.02);
  assert.equal(costOf([], 0.1).spent, 0);
});

test("a call starts only if it still fits under the cap: crossing at the first call or later both stop", async () => {
  const meter = new Meter(
    30,
    600,
    () => 0,
    async () => {},
  );
  meter.spent = 29.95;
  assert.equal(await meter.turn("金标集"), false, "the first call would pass 30 yuan");
  assert.equal(meter.calls, 0);
  const later = new Meter(
    30,
    600,
    () => 0,
    async () => {},
  );
  for (let i = 0; i < 8; i++) assert.equal(await later.turn("最近稿件"), true);
  later.spent = 29.91;
  assert.equal(await later.turn("最近稿件"), false, "the ninth call would pass the cap");
  assert.equal(later.stopped, "最近稿件");
});

test("a billed call that failed still names its receipt; a plain error names none", () => {
  assert.equal(receiptOf(Object.assign(new Error("invalid output"), { receiptId: 4242 })), 4242);
  assert.equal(receiptOf(new Error("network")), null);
  assert.equal(receiptOf({ receiptId: "x" }), null);
  assert.equal(receiptOf(null), null);
});

test("a score stopped before it settled is no judgement", () => {
  assert.equal(settledRun([63], [6], 64), null, "one score near the threshold needs a second");
  assert.equal(settledRun([], [], 64), null);
  assert.deepEqual(settledRun([90], [8], 64)?.selected, true, "far from the threshold one score settles");
  assert.equal(settledRun([63, 66], [6, 7], 64)?.selected, true);
});

test("comparisons use only pairs both rules finished, and count the rest", () => {
  const onlyCurrent: GoldCase = { ...goldCase("select", true, true), caseId: "owner-only-current", candidate: null };
  const cases = [goldCase("select", false, true), goldCase("reject", false, false), onlyCurrent];
  assert.equal(goldMetrics(cases, "current").total, 2);
  assert.equal(goldMetrics(cases, "candidate").total, 2);
  assert.equal(goldIncomplete(cases), 1);
  const md = renderReport({
    startedAt: "s",
    finishedAt: "f",
    model: "m",
    layout: "shared",
    versions: {},
    meter: { calls: 3, spent: 0.03, maxYuan: 30, stopped: null },
    days: 7,
    band: [45, 80],
    gold: cases,
    recent: [],
    blocked: {
      total: 70,
      sampled: [
        { id: "p1", title: "放行已评", source: "s", day: "11-12", label: "PASS", reason: "r", candidate: run(70, true) },
        { id: "p2", title: "放行未评", source: "s", day: "11-12", label: "PASS", reason: "r", candidate: null },
      ],
    },
    errors: 2,
  });
  assert.match(md, /两版都打完分的 2 篇，另有 1 篇没打完，不计/);
  assert.match(md, /未完成 2 篇、出错 2 次/);
  assert.doesNotMatch(md, /全部跑完/);
  assert.match(md, /已打完分 1 篇，其中会入选 1 篇/);
  assert.match(md, /另有 1 篇放行后没打完分，不计/);
});
