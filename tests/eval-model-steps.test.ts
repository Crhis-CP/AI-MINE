// Pure parts of the model comparison (TASK-0601): no database, network or model.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  blindSheet,
  checkSegment,
  draw,
  emptyUsage,
  missingNumbers,
  missingUnits,
  changedEntities,
  pairedVerdict,
  parseDomainNames,
  pickSheet,
  prefilterMetrics,
  renderReport,
  residualEnglish,
  scoreMetrics,
  seededOrder,
  structureMetrics,
  summarize,
  TokenBudget,
  translationMetrics,
  usageOf,
  wilson,
  type Baseline,
  type CaseResult,
  type Candidate,
  type Gold,
  type ResultFile,
  type SegmentResult,
} from "../scripts/eval-model-steps-core.ts";

const names = parseDomainNames(
  ["rules-domain-names.md", "rules-domain-names-extra.md"]
    .map((f) => readFileSync(path.join(import.meta.dirname, "../industry/prompts", f), "utf8"))
    .join("\n"),
);
const baseline = (b: Partial<Baseline> = {}): Baseline => ({
  label: "PASS",
  selected: true,
  firstScore: 70,
  threshold: 60,
  category: "production",
  subjects: [],
  countries: [],
  hasFact: true,
  promptCurrent: true,
  ...b,
});
const item = (
  id: string,
  opts: { stratum?: string; gold?: Gold | null; baseline?: Partial<Baseline>; candidate?: Candidate | null; error?: string; language?: string } = {},
): CaseResult => ({
  articleId: id,
  revision: 1,
  title: id,
  fingerprint: "f",
  stratum: opts.stratum ?? "s",
  language: opts.language ?? "en",
  gold: opts.gold ?? null,
  baseline: baseline(opts.baseline),
  candidate: opts.candidate === undefined ? {} : opts.candidate,
  error: opts.error ?? null,
  receiptIds: [],
  usage: { ...emptyUsage(), calls: 1, tokensIn: 1000, tokensOut: 100, cached: 400 },
});

test("sampling depends on the seed only, takes preferred items first and lets groups take turns", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, lang: i < 20 ? "en" : i < 27 ? "es" : "pt", rich: i % 5 === 0 }));
  const key = (r: (typeof rows)[number]) => r.id;
  const first = draw(rows, 10, { seed: 7, key });
  assert.deepEqual(draw([...rows].reverse(), 10, { seed: 7, key }), first, "database order does not change the sample");
  assert.notDeepEqual(draw(rows, 10, { seed: 8, key }), first);
  assert.equal(new Set(first.map(key)).size, 10);
  assert.deepEqual(seededOrder(rows, 7, key).slice(0, 10), first);

  const preferred = draw(rows, 6, { seed: 7, key, prefer: (r) => (r.rich ? 1 : 0) });
  assert.ok(preferred.every((r) => r.rich));
  const grouped = draw(rows, 6, { seed: 7, key, groupOf: (r) => r.lang });
  assert.deepEqual(
    grouped.map((r) => r.lang),
    ["en", "es", "pt", "en", "es", "pt"],
  );
  const short = draw(rows, 30, { seed: 7, key, groupOf: (r) => r.lang });
  assert.equal(short.length, 30, "a small group running out leaves its turns to the others");
  const excluded = draw(rows, 30, { seed: 7, key, exclude: new Set(first.map(key)) });
  assert.equal(excluded.length, 20);
  assert.ok(excluded.every((r) => !first.includes(r)));
});

test("Wilson intervals and the paired tie rule follow the evaluation-set statistics", () => {
  assert.deepEqual(wilson(0, 30), { k: 0, n: 30, rate: 0, low: 0, high: 0.114 });
  assert.deepEqual(wilson(5, 10), { k: 5, n: 10, rate: 0.5, low: 0.237, high: 0.763 });
  assert.equal(wilson(0, 0).rate, null);
  assert.equal(pairedVerdict(5, 3, 40), "持平", "2 of 40 is below max(0.8, 3)");
  assert.equal(pairedVerdict(6, 3, 40), "候选更差");
  assert.equal(pairedVerdict(0, 3, 40), "候选更好");
  assert.equal(pairedVerdict(8, 5, 200), "持平", "on 200 cases the margin is 4");
});

test("the token cap refuses a call that could pass it and never lets the measured spend exceed it", () => {
  assert.throws(() => new TokenBudget(0, 0, 10), RangeError);
  const budget = new TokenBudget(100, 20, 30);
  const a = budget.reserve();
  assert.equal(a, 30);
  assert.equal(budget.reserve(), 30, "a second call in flight still fits: 20 + 30 + 30");
  assert.equal(budget.reserve(), null, "a third would reach 110");
  budget.settle(30, 50);
  assert.equal(budget.spent, 70);
  assert.equal(budget.reserve(), null, "the largest call seen (50) is now the reservation");
  budget.settle(30, 10);
  assert.equal(budget.spent, 80);
  assert.equal(budget.remainingCalls(), 0);

  // A whole run at a steady size: stops before the cap, with earlier runs of the same model counted.
  const run = new TokenBudget(900_000, 300_000, 13_800);
  let calls = 0;
  for (let size = run.reserve(); size !== null; size = run.reserve()) {
    run.settle(size, 13_500 + (calls % 3) * 100);
    calls++;
  }
  assert.ok(run.spent <= 900_000);
  assert.ok(900_000 - run.spent < 13_800 * 2);
  assert.equal(calls, 44);
});

test("usage reads both cache-hit spellings and reasoning tokens", () => {
  assert.deepEqual(
    usageOf(
      { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 64 }, completion_tokens_details: { reasoning_tokens: 7 } },
      300,
      "qwen-flash",
    ),
    {
      calls: 1,
      tokensIn: 100,
      tokensOut: 20,
      cached: 64,
      reasoning: 7,
      latencyMs: 300,
      returnedModels: ["qwen-flash"],
    },
  );
  assert.equal(usageOf({ prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 8 }, 0, null).cached, 8);
  assert.equal(usageOf(null, 0, null).tokensIn, 0);
});

test("translation checks find lost numbers, units, renamed companies, lost links and untranslated text", () => {
  const source = "<p>Production rose 12.5% to 1,200,000 ounces at 2.1 g/t, worth US$3.5 billion.</p>";
  assert.deepEqual(missingNumbers(source, "产量增长12.5%，达到120万盎司，品位2.1克/吨，价值35亿美元。"), []);
  assert.deepEqual(missingNumbers(source, "产量增长12.5%，达到120万盎司，价值35亿美元。"), ["2.1"]);
  assert.deepEqual(missingNumbers("La producción alcanzó 1.234,5 toneladas", "产量达到1234.5吨"), [], "a Spanish decimal comma");
  assert.deepEqual(missingNumbers("a US$3.5 billion expansion", "35亿美元的扩建"), [], "the whole value meets");
  assert.deepEqual(missingNumbers("a US$3.5 billion expansion", "3.5万美元的扩建"), ["3.5"], "a wrong scale is caught even with the digits kept");
  assert.deepEqual(missingNumbers("a US$3.5 billion expansion", "3.5美元的扩建"), ["3.5"], "a dropped scale is caught");
  assert.deepEqual(missingNumbers("a US$3.5 billion expansion", "3.5 billion 美元的扩建"), [], "an English scale word left in place");
  assert.deepEqual(missingUnits(source, "产量增长12.5%，达到120万盎司，品位2.1克/吨，价值35亿美元。"), []);
  assert.deepEqual(missingUnits(source, "产量增长12.5，达到120万，品位2.1，价值35亿。"), ["%", "g/t", "oz", "US$"]);
  assert.deepEqual(missingUnits("C$40 million", "4000万加元"), []);

  assert.equal(names.get("BHP"), "必和必拓");
  assert.equal(names.get("Barrick"), "巴里克");
  const said = "Barrick Gold said the Reko Diq project will start, and Lundin Mining agreed.";
  assert.deepEqual(changedEntities(said, "巴里克（Barrick）表示，Reko Diq 项目将启动，Lundin Mining 同意。", names), []);
  assert.deepEqual(changedEntities(said, "巴里克表示，雷科迪克项目将启动，伦丁矿业同意。", names), ["Reko Diq", "Lundin Mining"]);
  assert.deepEqual(
    changedEntities("Meanwhile Lundin Mining agreed.", "与此同时，Lundin Mining 同意。", names),
    [],
    "a sentence's first word is not part of the name",
  );

  const linked = '<p>See <a href="https://example.com/r">the report</a> on 3 mines.</p>';
  assert.equal(checkSegment(linked, '<p>见<a id="L0">报告</a>，涉及3座矿山。</p>', names).structureKept, true);
  assert.equal(checkSegment(linked, "<p>见报告，涉及3座矿山。</p>", names).structureKept, false);
  const check = checkSegment("<p>The company said output was steady.</p>", "<p>The company said output was steady this year.</p>", names, {
    finishReason: "length",
    reference: "<p>公司表示产量稳定，今年也是。这是很长的一段参考译文用于比较长度。</p>",
  });
  assert.equal(check.truncated, true);
  assert.equal(check.residualEnglish, true);
  assert.equal(residualEnglish("公司表示 Reko Diq 项目稳定"), false);
});

const segment = (index: number, s: Partial<SegmentResult> = {}): SegmentResult => ({
  index,
  language: "en",
  source: "<p>Output rose 12% to 300 tonnes at Kamoa Kakula.</p>",
  candidate: "<p>产量增长12%，达到300吨，Kamoa Kakula。</p>",
  baseline: "<p>产量增长12%至300吨，Kamoa Kakula。</p>",
  finishReason: "stop",
  ...s,
});

test("step metrics compare with stored DeepSeek results and the Owner's labels", () => {
  const prefilter = prefilterMetrics([
    item("1", { stratum: "selected-owner", gold: "select", candidate: { label: "BLOCK" } }),
    item("2", { stratum: "selected-deepseek", candidate: { label: "PASS" } }),
    item("3", { stratum: "selected-deepseek", candidate: { label: "UNKNOWN" } }),
    item("4", { stratum: "block-en", baseline: { label: "BLOCK", selected: false }, candidate: { label: "BLOCK" } }),
    item("5", { stratum: "block-es", baseline: { label: "BLOCK", selected: false }, candidate: { label: "PASS" } }),
    item("6", { candidate: null, error: "skipped: 材料已有新修订" }),
  ]);
  assert.deepEqual(prefilter.falseReject, wilson(1, 3));
  assert.equal(prefilter.ownerSelectBlocked, 1);
  assert.deepEqual(prefilter.agreement, wilson(3, 5), "UNKNOWN goes on like PASS");
  assert.deepEqual(prefilter.blockedWhereDeepSeekPassed, wilson(1, 3));

  const score = scoreMetrics([
    item("1", { gold: "select", baseline: { firstScore: 70, selected: true }, candidate: { score: 66, selected: true } }),
    item("2", { gold: "select", baseline: { firstScore: 62, selected: true }, candidate: { score: 55, selected: false } }),
    item("3", { gold: "reject", baseline: { firstScore: 50, selected: false, promptCurrent: false }, candidate: { score: 61, selected: true } }),
    item("4", { gold: "either", baseline: { firstScore: 58, selected: false }, candidate: { score: 58, selected: false } }),
  ]);
  assert.equal(score.meanAbsDiff, 5.5);
  assert.deepEqual(score.selectionAgreement, wilson(2, 4));
  assert.deepEqual(score.ownerAccuracy, wilson(1, 3));
  assert.deepEqual(score.deepSeekOwnerAccuracy, wilson(3, 3));
  assert.equal(score.missed, 1);
  assert.equal(score.falselySelected, 1);
  assert.equal(score.staleBaseline, 1);

  const structure = structureMetrics([
    item("1", {
      baseline: { subjects: ["a", "b"], countries: ["CL"] },
      candidate: { category: "production", subjects: ["b", "a"], countries: ["CL"], hasFact: true },
    }),
    item("2", { baseline: { category: "deals" }, candidate: { category: "production", subjects: ["x"], countries: [], hasFact: false } }),
    item("3", { candidate: null, error: "Model x returned unusable output for y" }),
  ]);
  assert.deepEqual(structure.category, wilson(1, 2));
  assert.deepEqual(structure.subjects, wilson(1, 2));
  assert.deepEqual(structure.countries, wilson(2, 2));
  assert.deepEqual(structure.fact, wilson(1, 2));
  assert.deepEqual(structure.parseFailures, wilson(1, 3));

  const good = translationMetrics([item("1", { candidate: { segments: [segment(0), segment(1)] } })], names);
  assert.equal(good.automaticChecksPass, true);
  assert.equal(good.candidate.segments, 2);
  const lossy = translationMetrics(
    [
      item("1", {
        candidate: {
          segments: [
            segment(0, { candidate: "<p>产量增长，Kamoa Kakula。</p>" }),
            segment(1, { candidate: null, error: "x" }),
            segment(2, { finishReason: "length" }),
          ],
        },
      }),
    ],
    names,
  );
  assert.equal(lossy.automaticChecksPass, false);
  assert.equal(lossy.candidate.failed, 1);
  assert.equal(lossy.candidate.numbers, 2);
  assert.equal(lossy.candidate.truncated, 1);
  assert.equal(lossy.deepseek.numbers, 0);
});

test("the summary and report count tokens, flag small samples and hold no article text", () => {
  const file: ResultFile = {
    format: "model-bakeoff-result-v1",
    step: "prefilter",
    model: "qwen-flash",
    stopReason: "token_cap",
    tokenCap: 900_000,
    priorTokens: 5_000,
    startedAt: "2026-11-09T00:00:00Z",
    finishedAt: null,
    cases: [item("secret-title", { candidate: { label: "PASS" } }), item("2", { candidate: { label: "BLOCK" } })],
  };
  const s = summarize(file);
  assert.equal(s.n, 2);
  assert.equal(s.insufficient, true);
  assert.equal(s.usage.cacheHitRate, 0.4);
  assert.equal(s.tokensThisRun, 2200);
  assert.equal(s.tokensWithEarlierRuns, 7200);
  const report = renderReport([s]);
  assert.match(report, /## prefilter/);
  assert.match(report, /qwen-flash（样本不足/);
  assert.match(report, /非人工金标/);
  assert.doesNotMatch(report, /secret-title/);
});

test("the blind sheet takes segments from different articles in a seeded A/B order with a separate key", () => {
  const numbers = (id: string, language = "en") =>
    item(id, {
      language,
      candidate: {
        segments: [
          segment(0, { language, source: "<p>Output rose 12% to 300 tonnes in 2025 at 4 sites.</p>" }),
          segment(1, { language, source: "<p>Barrick Gold and Lundin Mining met.</p>", candidate: "<p>Barrick Gold 与 Lundin Mining 会面。</p>" }),
          segment(2, {
            language,
            source: '<p>See <a href="https://x.test">it</a>.</p>',
            candidate: '<p>见<a id="L0">此</a>。</p>',
            baseline: '<p>见<a id="L0">此处</a>。</p>',
          }),
        ],
      },
    });
  const cases = [...Array.from({ length: 9 }, (_, i) => numbers(`en${i}`)), numbers("es0", "es"), numbers("pt0", "pt")];
  const items = pickSheet(cases, names, 1);
  assert.equal(items.length, 10);
  assert.equal(new Set(items.map((i) => i.articleId)).size, 10);
  assert.deepEqual(
    items.map((i) => i.kind),
    ["numbers", "numbers", "numbers", "numbers", "names", "names", "names", "es-pt", "es-pt", "link"],
  );
  assert.deepEqual(pickSheet([...cases].reverse(), names, 1), items);
  const sheet = blindSheet(items, "qwen3.7-flash-2026-07-15", 1);
  assert.equal(sheet.key.length, 10);
  assert.doesNotMatch(sheet.markdown, /qwen|deepseek/i, "the sheet does not say which model wrote which");
  for (const [i, k] of sheet.key.entries()) {
    assert.notEqual(k.A, k.B);
    const shown = sheet.markdown.split("## 第 ")[i + 1]!;
    const a = k.A === "deepseek" ? items[i]!.baseline : items[i]!.candidate;
    assert.ok(
      shown.includes(
        `译文 A：${a
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()}`,
      ),
    );
  }
  assert.ok(new Set(sheet.key.map((k) => k.A)).size === 2, "both orders occur");
});
