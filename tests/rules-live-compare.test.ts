// The daily rules comparison (TASK-0670, scripts/rules-live-compare.ts): what the Owner reads after go-live. The
// grouping, the baseline and the report are pure and tested on synthetic rows without a database; the last test runs
// the three read-only queries on synthetic rows in the throwaway test database.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  firstGlobalDay,
  addCost,
  addDays,
  beijingDay,
  collect,
  costText,
  globalPicks,
  renderReport,
  rulesVersion,
  stepVersions,
  summarize,
  type CostRow,
  type JudgementRow,
  type PickRow,
} from "../scripts/rules-live-compare.ts";

const CLASSIC = { prefilter: "prefilter-shared@aa4cb4ab1b", score: "selection-score-shared@a195d5bf17+weights@20542a669a" };
const GLOBAL = { prefilter: "prefilter-four-layers-shared@4cbc95fcc9", score: "selection-score-global-shared@d3b4cb6ac0+weights@20542a669a" };
const REST = "understand-shared@0000000001+summarize-article-shared@0000000002+mend-wording-shared@0000000003+structure-shared@0000000004";
const full = (v: { prefilter: string; score: string }) => `${v.prefilter}+${v.score}+${REST}`;
/** An X post's judgement stores the post prompts' version after the six steps. */
const post = (v: { prefilter: string; score: string }) => `${full(v)}+summarize-short-post+summarize-long-post+identity-context@0000000005`;

const judged = (day: string, promptVersion: string | null, n: Partial<JudgementRow> = {}): JudgementRow => ({
  day,
  promptVersion,
  analysed: 10,
  judged: 10,
  passed: 6,
  inAll: 5,
  inAllShown: 4,
  scoreSelected: 2,
  selected: 1,
  ...n,
});
const cost = (day: string, step: CostRow["step"], version: string | null, cny: number | null, attempts = 10, unpriced = 0): CostRow => ({
  day,
  step,
  version,
  attempts,
  unpriced,
  cny,
});

test("a stored prompt version names its prefilter and score versions, and through them the rule set", () => {
  assert.deepEqual(stepVersions(full(CLASSIC)), CLASSIC);
  assert.deepEqual(stepVersions(post(GLOBAL)), GLOBAL, "an X post's extra version does not change the rules");
  assert.deepEqual(stepVersions(GLOBAL.prefilter), { prefilter: GLOBAL.prefilter, score: null }, "stopped after the prefilter");
  assert.deepEqual(stepVersions(null), { prefilter: null, score: null });
  assert.equal(rulesVersion(full(CLASSIC)).ruleset, "classic");
  assert.equal(rulesVersion(full(GLOBAL)).ruleset, "global");
  assert.equal(rulesVersion("prefilter@f1a5eca242+selection-score@9881743a29+weights@20542a669a").ruleset, "classic", "the separate layout");
  assert.equal(rulesVersion("prefilter-four-layers@82a70b39f8+selection-score-global@6780f69e09+weights@20542a669a").ruleset, "global");
  assert.equal(rulesVersion(GLOBAL.prefilter).ruleset, "global");
  assert.equal(rulesVersion(`${CLASSIC.prefilter}+${GLOBAL.score}`).ruleset, null, "mixed versions are not called either rule set");
  assert.equal(rulesVersion("prefilter@f1a5eca242+selection-score-b@1234567890").ruleset, null, "an experiment's score rules");
  assert.equal(rulesVersion(null).ruleset, null);
  assert.equal(rulesVersion(full(GLOBAL)).key, rulesVersion(post(GLOBAL)).key);
  assert.notEqual(rulesVersion(full(GLOBAL)).key, rulesVersion(full(CLASSIC)).key);
});

test("days are Beijing calendar days", () => {
  assert.equal(addDays("2026-11-15", -7), "2026-11-08");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.throws(() => addDays("15/11/2026", 1), /not a day/);
  assert.equal(beijingDay(new Date("2026-11-14T16:30:00Z")), "2026-11-15");
  assert.equal(beijingDay(new Date("2026-11-14T15:59:59Z")), "2026-11-14");
});

test("rows are grouped by day and by rules version; each step's cost goes to the version that names it", () => {
  const summary = summarize(
    [
      judged("2026-11-14", full(CLASSIC)),
      judged("2026-11-15", full(CLASSIC), { analysed: 3, judged: 3, passed: 1, inAll: 1, inAllShown: 1, scoreSelected: 0, selected: 0 }),
      judged("2026-11-15", full(GLOBAL), { analysed: 20, judged: 18, passed: 15, inAll: 12, inAllShown: 9, scoreSelected: 4, selected: 2 }),
      // The same rules under another stored version (an X post), and judgements stopped after the prefilter.
      judged("2026-11-15", post(GLOBAL), { analysed: 2, judged: 2, passed: 2, inAll: 2, inAllShown: 2, scoreSelected: 1, selected: 1 }),
      judged("2026-11-15", GLOBAL.prefilter, { analysed: 1, judged: 1, passed: 1, inAll: 0, inAllShown: 0, scoreSelected: 0, selected: 0 }),
    ],
    [
      cost("2026-11-14", "prefilter", CLASSIC.prefilter, 0.2),
      cost("2026-11-14", "score", CLASSIC.score, 0.8, 12),
      cost("2026-11-15", "prefilter", GLOBAL.prefilter, 0.5, 23),
      cost("2026-11-15", "score", GLOBAL.score, 1.5, 30),
      cost("2026-11-15", "score", CLASSIC.score, 0.1, 2),
    ],
  );
  assert.deepEqual(
    summary.versions.map((v) => v.ruleset),
    ["classic", "global"],
    "the earlier rules first",
  );
  assert.deepEqual(
    summary.days.map((d) => [d.day, d.cells.map((c) => c.version.ruleset)]),
    [
      ["2026-11-14", ["classic"]],
      ["2026-11-15", ["classic", "global"]],
    ],
  );
  const [before, live] = summary.days;
  assert.deepEqual(before!.cells[0]!.cell.cost, { cny: 1, attempts: 22, unpriced: 0 });
  const global = live!.cells[1]!.cell;
  assert.deepEqual(
    [global.analysed, global.judged, global.passed, global.inAll, global.inAllShown, global.scoreSelected, global.selected],
    [23, 21, 18, 14, 11, 5, 3],
    "the X-post rows and the prefilter-only rows belong to the same rules version",
  );
  assert.deepEqual(global.cost, { cny: 2, attempts: 53, unpriced: 0 });
  assert.deepEqual(live!.cells[0]!.cell.cost, { cny: 0.1, attempts: 2, unpriced: 0 });
  assert.deepEqual([live!.total.analysed, live!.total.selected, live!.total.cost.cny], [26, 3, 2.1]);
  assert.equal(summary.liveDate, "2026-11-15");
  assert.equal(summary.liveDateFrom, "first global judgement");
});

test("a missing cost is reported as missing, never as 0", () => {
  assert.deepEqual(addCost({ cny: null, attempts: 0, unpriced: 0 }, { cny: null, attempts: 3, unpriced: 3 }), { cny: null, attempts: 3, unpriced: 3 });
  assert.deepEqual(addCost({ cny: null, attempts: 3, unpriced: 3 }, { cny: 0.4, attempts: 2, unpriced: 0 }), { cny: 0.4, attempts: 5, unpriced: 3 });
  const summary = summarize(
    [judged("2026-11-15", full(GLOBAL)), judged("2026-11-16", full(GLOBAL))],
    [
      // No attempt of the day carries a cost.
      cost("2026-11-15", "prefilter", GLOBAL.prefilter, null, 10, 10),
      cost("2026-11-15", "score", GLOBAL.score, null, 12, 12),
      // Some do: the sum is of those, and the rest are counted.
      cost("2026-11-16", "prefilter", GLOBAL.prefilter, 0.3, 10, 0),
      cost("2026-11-16", "score", GLOBAL.score, 0.9, 12, 4),
      // A step version no judgement names is not guessed into a rules version.
      cost("2026-11-16", "score", "selection-score-b@1234567890", 0.05, 1, 0),
      cost("2026-11-16", "score", null, null, 2, 2),
    ],
  );
  const [none, some] = summary.days;
  assert.deepEqual(none!.total.cost, { cny: null, attempts: 22, unpriced: 22 });
  assert.equal(costText(none!.total.cost), "—（22 次调用没有费用记录，未计入）");
  assert.deepEqual(some!.cells[0]!.cell.cost, { cny: 1.2, attempts: 22, unpriced: 4 });
  assert.equal(costText(some!.cells[0]!.cell.cost), "1.2（另有 4 次调用没有费用记录，未计入）");
  assert.deepEqual(some!.unassigned, { cny: 0.05, attempts: 3, unpriced: 2 });
  assert.deepEqual(some!.total.cost, { cny: 1.25, attempts: 25, unpriced: 6 });
  assert.equal(costText({ cny: null, attempts: 0, unpriced: 0 }), "—", "no call at all is not a cost of 0 either");
  const report = renderReport(summary, [], { generatedAt: "2026-11-16T12:00:00.000Z", titles: 10 });
  assert.match(report, /\| 2026-11-15 \| 新规则·版本1 \| 10 \| 60%（6\/10） \| 5 \| 4 \| 2 \| 1 \| —（22 次调用没有费用记录，未计入） \|/);
  assert.match(report, /\| 2026-11-16 \| 对不上规则版本的调用 \| — \| — \| — \| — \| — \| — \| 0\.05（另有 2 次调用没有费用记录，未计入） \|/);
  assert.match(report, /\| 2026-11-16 \| \*\*当天合计\*\* \| 10 \|.*\| 1\.25（另有 6 次调用没有费用记录，未计入） \|/);
});

test("the baseline is the mean of the seven days before go-live; a day costing more than double it is flagged", () => {
  const rows: JudgementRow[] = [];
  const costs: CostRow[] = [];
  // Eight classic days; the first is outside the seven before go-live. One baseline day has no priced cost.
  for (let i = 8; i >= 1; i--) {
    const day = addDays("2026-11-15", -i);
    rows.push(
      judged(day, full(CLASSIC), { analysed: i === 8 ? 1000 : 100, judged: 100, passed: 40, inAll: 30, inAllShown: 28, scoreSelected: 8, selected: 6 }),
    );
    costs.push(i === 3 ? cost(day, "score", CLASSIC.score, null, 50, 50) : cost(day, "score", CLASSIC.score, i === 8 ? 100 : 2, 50));
  }
  rows.push(judged("2026-11-15", full(GLOBAL), { analysed: 110, judged: 100, passed: 55, inAll: 44, inAllShown: 35, scoreSelected: 9, selected: 7 }));
  rows.push(judged("2026-11-16", full(GLOBAL), { analysed: 120, judged: 110, passed: 60, inAll: 50, inAllShown: 40, scoreSelected: 9, selected: 7 }));
  costs.push(cost("2026-11-15", "score", GLOBAL.score, 3.9, 60), cost("2026-11-16", "score", GLOBAL.score, 4.2, 70));
  const summary = summarize(rows, costs);
  assert.equal(summary.liveDate, "2026-11-15");
  const b = summary.baseline!;
  assert.deepEqual([b.from, b.to, b.days], ["2026-11-08", "2026-11-14", 7]);
  assert.deepEqual([b.mean!.analysed, b.mean!.passed, b.mean!.judged, b.mean!.inAll, b.mean!.selected], [100, 40, 100, 30, 6]);
  assert.deepEqual([b.costMean, b.costDays, b.unpriced], [2, 6, 50], "the day without a cost record is left out of the mean, not counted as 0");
  assert.deepEqual(summary.costAlerts, [{ day: "2026-11-16", cny: 4.2, ratio: 2.1 }], "3.9 is not more than double 2; 4.2 is");
  const report = renderReport(summary, [], { generatedAt: "2026-11-16T12:00:00.000Z", titles: 10 });
  assert.match(report, /上线日：2026-11-15（按第一条新规则判断推定）/);
  assert.match(
    report,
    /上线前七天（2026-11-08 至 2026-11-14，有数据 7 天）日均：进入分析 100 篇，预筛放行率 40%，进“全部” 30 条，进精选 6 条，两步费用 2 元（按有费用记录的 6 天）；这七天另有 50 次调用没有费用记录，未计入。/,
  );
  assert.match(report, /\*\*费用提醒\*\*：2026-11-16 两步费用 4\.2 元，是上线前日均的 2\.1 倍。已超过“高出一倍”这条线/);
  // A go-live day given by the release wins over the inferred one; without data before it there is no mean to compare.
  const given = summarize(rows, costs, "2026-11-16");
  assert.deepEqual([given.liveDate, given.liveDateFrom, given.baseline!.from, given.baseline!.to], ["2026-11-16", "argument", "2026-11-09", "2026-11-15"]);
  const early = summarize(rows, costs, "2026-11-01");
  assert.deepEqual([early.baseline!.days, early.baseline!.mean, early.baseline!.costMean], [0, null, null]);
  assert.match(renderReport(early, [], { generatedAt: "x", titles: 10 }), /没有查到分析记录，暂时没有均值可比/);
  assert.throws(() => summarize(rows, costs, "11-15"), /--live-date must be YYYY-MM-DD/);
  // Before any judgement under the new rules there is no go-live day and no baseline.
  const none = summarize(rows.slice(0, 8), costs.slice(0, 8));
  assert.deepEqual([none.liveDate, none.baseline, none.costAlerts], [null, null, []]);
  assert.match(renderReport(none, [], { generatedAt: "x", titles: 10 }), /数据里还没有新规则下的判断/);
});

test("the report lists the titles and sources selected under the new rules, and says what each number counts", () => {
  const pick = (day: string, promptVersion: string, title: string, inSelected: boolean): PickRow => ({
    day,
    promptVersion,
    title,
    source: "合成来源",
    tier: "T1",
    score: 71.25,
    inSelected,
  });
  const picks = [
    pick("2026-11-15", full(GLOBAL), "智利提高铜矿权益金 | 议会表决", true),
    pick("2026-11-16", post(GLOBAL), "刚果（金）延长钴出口配额", false),
    pick("2026-11-15", full(CLASSIC), "原规则下入选的一条", true),
  ];
  assert.deepEqual(
    globalPicks(picks).map((p) => p.title),
    ["刚果（金）延长钴出口配额", "智利提高铜矿权益金 | 议会表决"],
    "newest day first, the classic pick left out",
  );
  const summary = summarize([judged("2026-11-15", full(GLOBAL)), judged("2026-11-16", full(GLOBAL))], []);
  const report = renderReport(summary, picks, { generatedAt: "2026-11-16T12:00:00.000Z", titles: 1 });
  assert.match(report, /^# 新旧评分规则每日对比（真实数据）/);
  assert.match(report, /## 二、新规则下评分达线的稿件（2 条，列出最近 1 条）/);
  assert.match(report, /\| 2026-11-16 \| 刚果（金）延长钴出口配额 \| 合成来源（T1） \| 71\.3 \| 还没有 \|/);
  assert.ok(!report.includes("智利提高铜矿权益金") && !report.includes("原规则下入选的一条"));
  assert.match(renderReport(summary, picks, { generatedAt: "x", titles: 10 }), /\| 智利提高铜矿权益金 ／ 议会表决 \| 合成来源（T1） \| 71\.3 \| 是 \|/);
  assert.match(report, /- 新规则·版本1：预筛 `prefilter-four-layers-shared@4cbc95fcc9`，评分 `selection-score-global-shared@d3b4cb6ac0\+weights@20542a669a`/);
  assert.match(report, /没有费用记录或不是人民币的调用单独计数，不当作 0/);
  assert.match(renderReport(summarize([], []), [], { generatedAt: "x", titles: 10 }), /查询范围内没有分析记录/);
});

const database = new URL(process.env.DATABASE_URL ?? "postgres://unset/unset").pathname.slice(1);
test("the queries read each article's latest judgement, the public lists and the two steps' receipts, and write nothing", {
  skip: !/_(test|ci)$/.test(database) && "needs a throwaway *_test database",
}, async () => {
  const { tag } = await import("./setup.ts");
  const { closeDb, sql } = await import("@amp/backend/db");
  try {
    const T = tag(),
      source = `rules-live-${T}`;
    const at = (day: string, hour = 12) => new Date(`${day}T${String(hour).padStart(2, "0")}:00:00+08:00`);
    const today = beijingDay(new Date()),
      yesterday = addDays(today, -1);
    await sql`INSERT INTO sources(id,name,kind,tier,config) VALUES(${source},'对比合成来源','rss','T1','{}')`;
    await sql`INSERT INTO sources(id,name,kind,tier,lane,config) VALUES(${`${source}-policy`},'法规合成来源','rss','T1','policy','{}')`;
    const receipt = async (purpose: string, version: string, startedAt: Date, cny: number | null, extra: Record<string, unknown> = {}, origin = "live") => {
      const [r] = await sql<{ id: number }[]>`INSERT INTO receipts(logical_key,service,purpose,status,request,origin)
        VALUES(${`rules-live-${tag()}`},'fixture',${purpose},'completed',${sql.json({ promptVersion: version, ...extra } as never)},${origin}) RETURNING id`;
      await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,origin,status,cost,currency,cost_basis,started_at)
        VALUES(${r!.id},1,'fixture','fixture-model',${origin},'received',${cny},${cny === null ? null : "CNY"},${cny === null ? null : "actual"},${startedAt})`;
      return r!.id;
    };
    const article = async (
      name: string,
      opts: {
        version: string;
        day: string;
        label: string | null;
        selected?: boolean;
        score?: number | null;
        publication?: "pick" | "listed" | "hidden";
        src?: string;
      },
    ) => {
      const id = `${source}-${name}`,
        url = `https://example.invalid/${id}`,
        when = at(opts.day);
      await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at,language,body_text,raw)
        VALUES(${id},${opts.src ?? source},${id},${url},${`原题 ${name}`},${when},${when},'zh','body','{}'::jsonb)`;
      // An earlier judgement of the same article under the other rules: only the latest one counts.
      await sql`INSERT INTO analyses(article_id,input_revision,origin,prompt_version,relevance,selected,output,created_at)
        VALUES(${id},1,'model',${full(CLASSIC)},'pass',true,${sql.json({ prefilter: { label: "PASS" } })},${at(opts.day, 1)})`;
      await sql`INSERT INTO analyses(article_id,input_revision,origin,prompt_version,relevance,score,selected,output,created_at)
        VALUES(${id},2,'model',${opts.version},${opts.label === "BLOCK" ? "block" : "pass"},${opts.score ?? null},${opts.selected ?? false},
          ${sql.json(opts.label ? { prefilter: { label: opts.label } } : { prefilter: null })},${when})`;
      if (opts.publication) {
        const pick = opts.publication === "pick";
        await sql`INSERT INTO publications(article_id,title,source_id,channel,url,discovered_at,timeline_at,sort_at,visibility,eligible,selected,selection_candidate,score,visible_after)
          VALUES(${id},${`中文题 ${name}`},${opts.src ?? source},'news',${url},${when},${when},${when},'public',true,${pick},${pick},${opts.score ?? null},
            ${new Date(Date.now() - 3_600_000)})`;
      }
      return id;
    };
    await article("classic-pass", { version: full(CLASSIC), day: yesterday, label: "PASS", score: 40, publication: "listed" });
    await article("classic-block", { version: full(CLASSIC), day: yesterday, label: "BLOCK" });
    await article("global-pick", { version: full(GLOBAL), day: today, label: "PASS", selected: true, score: 70, publication: "pick" });
    await article("global-waiting", { version: post(GLOBAL), day: today, label: "UNKNOWN", selected: true, score: 68, publication: "listed" });
    await article("global-low", { version: full(GLOBAL), day: today, label: "PASS", score: 10, publication: "listed" });
    await article("global-block", { version: full(GLOBAL), day: today, label: "BLOCK" });
    await article("global-no-material", { version: full(GLOBAL), day: today, label: null });
    await article("policy-lane", { version: full(GLOBAL), day: today, label: "PASS", selected: true, score: 90, publication: "pick", src: `${source}-policy` });
    await receipt("prefilter_article", CLASSIC.prefilter, at(yesterday), 0.25);
    await receipt("prefilter_article", GLOBAL.prefilter, at(today), 0.5);
    await receipt("score_article", GLOBAL.score, at(today), 1.5);
    await receipt("score_article", GLOBAL.score, at(today), null);
    // Not the two steps' production spending: another step, an evaluation, a replayed receipt.
    await receipt("understand_article", "understand-shared@0000000001", at(today), 9);
    await receipt("score_article", GLOBAL.score, at(today), 9, { usage_purpose: "evaluation" });
    await receipt("score_article", GLOBAL.score, at(today), 9, {}, "replay");
    const count = async () =>
      (await sql<{ n: number }[]>`SELECT (SELECT count(*) FROM analyses)::int + (SELECT count(*) FROM receipt_attempts)::int AS n`)[0]!.n;
    const before = await count();
    const data = await collect(yesterday);
    assert.equal(await count(), before, "nothing was written");
    const numbers = (r: JudgementRow) => [r.analysed, r.judged, r.passed, r.inAll, r.inAllShown, r.scoreSelected, r.selected];
    assert.deepEqual(
      data.rows.map((r) => [r.day, r.promptVersion, ...numbers(r)]),
      [
        [yesterday, full(CLASSIC), 2, 2, 1, 1, 1, 0, 0],
        [today, full(GLOBAL), 4, 3, 2, 2, 1, 1, 1],
        [today, post(GLOBAL), 1, 1, 1, 1, 1, 1, 0],
      ],
      "the latest judgement of each news article; the policy lane and earlier judgements are not counted",
    );
    assert.deepEqual(data.costs, [
      { day: yesterday, step: "prefilter", version: CLASSIC.prefilter, attempts: 1, unpriced: 0, cny: 0.25 },
      { day: today, step: "prefilter", version: GLOBAL.prefilter, attempts: 1, unpriced: 0, cny: 0.5 },
      { day: today, step: "score", version: GLOBAL.score, attempts: 2, unpriced: 1, cny: 1.5 },
    ]);
    assert.deepEqual(data.picks.map((p) => [p.day, p.title, p.source, p.tier, p.score, p.inSelected]).sort(), [
      [today, "中文题 global-pick", "对比合成来源", "T1", 70, true],
      [today, "中文题 global-waiting", "对比合成来源", "T1", 68, false],
    ]);
    const summary = summarize(data.rows, data.costs);
    assert.equal(summary.liveDate, today);
    // The go-live day is read without a window, so it stays fixed long after the switch (Codex review on #542).
    assert.equal(await firstGlobalDay(), today);
    const inferred = summarize(data.rows, data.costs, today, true);
    assert.deepEqual([inferred.liveDate, inferred.liveDateFrom], [today, "first global judgement"]);
    const live = summary.days.find((d) => d.day === today)!;
    assert.deepEqual(live.total.cost, { cny: 2, attempts: 3, unpriced: 1 });
    assert.deepEqual([live.cells.length, live.cells[0]!.version.ruleset, live.cells[0]!.cell.analysed], [1, "global", 5]);
  } finally {
    await closeDb();
  }
});
