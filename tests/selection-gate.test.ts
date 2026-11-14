import "./setup.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, test } from "node:test";
import { REPO_ROOT } from "@amp/backend/config";
import { closeDb } from "@amp/backend/db";
import { createHash } from "node:crypto";
import { analysisPromptLayout } from "@amp/backend/config";
import {
  buildScoreInput,
  draftTierThreshold,
  PROMPT_VERSIONS,
  promptVersionsFor,
  scoreConfirmationVersion,
  scoringConfirmed,
  type AnalyzeInputArticle,
} from "@amp/backend/editorial/analyze";
import { promptText } from "@amp/backend/editorial/prompts";
import { MAJOR_COMPANIES, SELECTION, SELECTION_RULESETS } from "@amp/industry/selection";
import {
  sharedAnalysisSystem,
  sharedScoreStandard,
  sharedSectionRules,
  sharedSections,
  splitSharedSystem,
  STRUCTURE_CONFIG,
  weightsVersion,
  type SharedSections,
} from "../packages/backend/src/editorial/analysis-layout.ts";
import { GEOGRAPHY_DICTIONARY } from "../packages/backend/src/editorial/geography.ts";
import { compareSelectionConfig, selectionConfigReport, selectionConfigSnapshot } from "../packages/backend/src/editorial/selection-config.ts";

after(async () => {
  await closeDb();
});

test("the score input uses a meaningful excerpt when the stored body is blank", () => {
  const article: AnalyzeInputArticle = {
    id: "score-input",
    revision: 1,
    title: "合成铜矿建设公告",
    url: "https://example.invalid/score-input",
    author: null,
    publishedAt: null,
    bodyText: "",
    excerpt: "合成铜矿取得建设许可，项目规模与审批条件见本摘要。",
    media: [],
    source: { name: "合成来源", kind: "rss", tier: "T1", firstParty: true },
  };
  for (const bodyText of [null, "", " \n\t", "…… ——"]) {
    assert.ok(buildScoreInput({ ...article, bodyText }).endsWith(`【完整正文】\n${article.excerpt}`));
  }
  assert.ok(buildScoreInput({ ...article, bodyText: "合成有效正文" }).endsWith("【完整正文】\n合成有效正文"));
  assert.ok(buildScoreInput({ ...article, excerpt: " " }).endsWith(`【完整正文】\n${article.title}`));
});

test("production scores only with the scoring prompt version the Owner confirmed", () => {
  assert.equal(scoringConfirmed(false, null), true, "development and evaluations run the draft");
  assert.equal(scoringConfirmed(true, null), false, "production without a confirmation scores and selects nothing");
  assert.equal(scoringConfirmed(true, "selection-score@0000000000"), false, "a confirmation of another version does not carry over");
  assert.equal(scoringConfirmed(true, scoreConfirmationVersion(analysisPromptLayout())), true);
  // Evaluations decide with the draft's thresholds in any environment (scripts/eval-selection.ts).
  assert.deepEqual([draftTierThreshold("T1"), draftTierThreshold("T1_5"), draftTierThreshold("T2"), draftTierThreshold("EXCLUDE_MP")], [62, 64, 66, null]);
});

test("the production pipeline sends no score request until this exact version is confirmed (a production process)", () => {
  // The gate is read from the process environment at start-up, so each case runs in its own process.
  const run = (confirmed: string) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import { analysisPromptLayout } from '@amp/backend/config';
      import { scoreConfirmationVersion, runSelectionScores, tierThreshold } from '@amp/backend/editorial/analyze';
      import { recomputeSelection } from './packages/backend/src/publication/selection-recompute.ts';
      const article = { id: 'gate', revision: 1, bodyStatus: 'ok', title: 'Copper mine expansion', url: 'https://example.invalid/gate',
        author: null, publishedAt: null, bodyText: 'A copper mine expansion.', excerpt: null, media: [],
        source: { name: 'Gate', kind: 'rss', tier: 'T1', firstParty: true } };
      const threshold = tierThreshold('T1');
      // Unconfirmed: the production score step returns before any model call (model calls are off here anyway).
      const scores = threshold === null ? await runSelectionScores(article) : 'not run';
      const renominated = recomputeSelection({id: 1, relevance: 'pass', selected: false, output: {threshold: 76, scores: [65, 65]}}, 'T1', new Date(), new Date()).selected;
      console.log(JSON.stringify({ threshold, scores, version: scoreConfirmationVersion(analysisPromptLayout()), renominated }));
      process.exit(0);
    `,
        ],
        {
          cwd: REPO_ROOT,
          env: {
            NODE_ENV: "production",
            SELECTION_CONFIRMED_VERSION: confirmed,
            AMP_CREDENTIALS_DIR: "/nonexistent-selection-gate-test",
            MODEL_CALLS_ENABLED: "false",
            COLLECT_ENABLED: "false",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      )
        .toString()
        .trim()
        .split("\n")
        .at(-1)!,
    ) as { threshold: number | null; scores: unknown; version: string; renominated: boolean };
  const unconfirmed = run("");
  assert.deepEqual([unconfirmed.threshold, unconfirmed.scores], [null, null], "no threshold, no score request");
  assert.equal(unconfirmed.renominated, false, "source tier recomputation uses the same Owner confirmation gate");
  assert.equal(run("selection-score@0000000000").threshold, null, "another version's confirmation does not carry over");
  const confirmed = run(unconfirmed.version);
  assert.equal(confirmed.threshold, 62, "the confirmed version scores with the tier threshold");
  assert.equal(confirmed.renominated, true);
});

// TASK-0710: in the shared layout every step's version hashes the whole shared system prompt, which also carries the
// jurisdiction dictionary, company aliases, vocabulary, writing rules and names list. The confirmation gate reads the
// score standard instead: the score rules, the preamble, the score heading and step instruction, the material recipe
// and the weights. These cases edit a rendered shared prompt the way such an edit would change it.
const RULESETS = Object.keys(SELECTION_RULESETS) as Array<keyof typeof SELECTION_RULESETS>;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
/** The shared prompt with `from` replaced by `to` wherever it appears (in `step`'s rules at least), taken apart again. */
function edited(sections: SharedSections, system: string, step: keyof SharedSections["rules"], from: string, to: string): SharedSections {
  assert.ok(sections.rules[step].includes(from), `${step}: the edited text is in this section`);
  const rules = Object.fromEntries(Object.entries(sections.rules).map(([s, text]) => [s, text.replaceAll(from, to)])) as SharedSections["rules"];
  assert.equal(
    system.split(from).length - 1,
    Object.values(sections.rules).reduce((n, text) => n + text.split(from).length - 1, 0),
    "only inside sections",
  );
  return splitSharedSystem(system.replaceAll(from, to), rules);
}

test("the score standard takes the shared prompt apart: preamble, six headed sections, nothing outside them", () => {
  for (const ruleset of RULESETS) {
    const system = sharedAnalysisSystem(ruleset),
      sections = sharedSections(ruleset);
    assert.deepEqual(sections.rules, sharedSectionRules(ruleset));
    assert.match(sections.preamble, /^你是 .+ 的矿业资讯分析助手/);
    assert.equal(sections.headings.score, "# 第二节 评分");
    assert.ok(system.startsWith(sections.preamble));
    assert.ok(system.includes(`${sections.headings.score}\n\n${sections.rules.score}`));
    // Text added outside a section, or a section without a heading, is refused rather than silently placed.
    assert.throws(() => splitSharedSystem(`${system}\n多出来的一句`, sections.rules), /after the last one/);
    assert.throws(() => splitSharedSystem(system.replace(sections.headings.structure, "第三节"), sections.rules), /no "# " heading/);
    assert.throws(
      () => splitSharedSystem(system.replace(sections.headings.structure, `夹在中间的一句\n${sections.headings.structure}`), sections.rules),
      /outside any section/,
    );
  }
});

test("editing the dictionary, aliases, vocabulary, writing rules or names list leaves the score standard unchanged", () => {
  for (const ruleset of RULESETS) {
    const system = sharedAnalysisSystem(ruleset),
      sections = sharedSections(ruleset),
      standard = sharedScoreStandard(sections);
    assert.equal(scoreConfirmationVersion("shared", ruleset), `${SELECTION_RULESETS[ruleset].score}-shared-standard@${standard}+weights@${weightsVersion()}`);
    // What the score standard hashes contains none of them.
    const scoreParts = [sections.preamble, sections.headings.score, sections.rules.score, promptText("analysis-step-score")].join("\n");
    const names = promptText("rules-domain-names").trim().split("\n")[0]!;
    for (const [label, text] of [
      ["jurisdiction dictionary", GEOGRAPHY_DICTIONARY],
      ["company aliases", STRUCTURE_CONFIG.entities],
      ["topic vocabulary", STRUCTURE_CONFIG.topicTags],
      ["names list", names],
      ["writing rules", promptText("rules-anti-hallucination").trim().split("\n")[0]!],
    ] as const) {
      assert.ok(system.includes(text), `${label} is sent in the shared prompt`);
      assert.ok(!scoreParts.includes(text), `${label} is not part of the score standard`);
    }
    for (const [label, step, from, to] of [
      ["a new province in the dictionary", "structure", GEOGRAPHY_DICTIONARY, `${GEOGRAPHY_DICTIONARY}; CN-XX=合成省/Synthetic Province(parent:CN)`],
      ["a new company alias", "structure", STRUCTURE_CONFIG.entities, `${STRUCTURE_CONFIG.entities}，synthetic（合成矿业/Synthetic Mining）`],
      ["a new name in the names list", "summarize", names, `${names} / 合成矿业（Synthetic Mining）`],
      ["a new writing rule", "summarize", "【矿业领域翻译与写作规则", "【合成新增的写作规则】\n【矿业领域翻译与写作规则"],
      ["a prefilter edit", "prefilter", sections.rules.prefilter.slice(0, 40), `${sections.rules.prefilter.slice(0, 40)}（合成改动）`],
    ] as const) {
      const after = edited(sections, system, step, from, to);
      assert.notEqual(sha(system.replaceAll(from, to)), sha(system), `${label}: the full shared prompt, and so every step's recorded version, changes`);
      assert.equal(sharedScoreStandard(after), standard, `${ruleset}: ${label} leaves the score standard as it is`);
    }
  }
});

test("editing the score rules, preamble or weights changes the score standard, and production then waits for a new confirmation", () => {
  for (const ruleset of RULESETS) {
    const system = sharedAnalysisSystem(ruleset),
      sections = sharedSections(ruleset),
      standard = sharedScoreStandard(sections),
      prefix = `${SELECTION_RULESETS[ruleset].score}-shared-standard@`;
    const rule = sections.rules.score.split("\n").find((line) => line.length > 20)!;
    const moved = sharedScoreStandard(edited(sections, system, "score", rule, `${rule}（合成新增一句）`));
    assert.notEqual(moved, standard, `${ruleset}: a score rule sentence changes the score standard`);
    process.env.ANALYSIS_PROMPT_LAYOUT = "shared";
    assert.equal(scoringConfirmed(true, `${prefix}${moved}+weights@${weightsVersion()}`), false, "the edited standard is not the confirmed one");
    process.env.ANALYSIS_PROMPT_LAYOUT = "separate";
    const heading = splitSharedSystem(system.replace(sections.headings.score, "# 第二节 打分"), sections.rules);
    assert.notEqual(sharedScoreStandard(heading), standard, "the score section's heading is part of the standard");
    const preamble = splitSharedSystem(system.replace(sections.preamble, `${sections.preamble}\n合成新增的前言`), sections.rules);
    assert.notEqual(sharedScoreStandard(preamble), standard, "the preamble is part of the standard");
  }
  // Weights, caps and the major companies the score rules name are in the confirmed value of both layouts.
  const weights = weightsVersion();
  for (const changed of [
    weightsVersion({ ...SELECTION, weights: { ...SELECTION.weights, policy_regulation: [2, 2, 1, 3, 2] } }),
    weightsVersion({ ...SELECTION, noiseCaps: { ...SELECTION.noiseCaps, junior_routine: 50 } }),
    weightsVersion(SELECTION, [...MAJOR_COMPANIES, "合成矿业"]),
  ])
    assert.notEqual(changed, weights);
  for (const ruleset of RULESETS)
    for (const layout of ["shared", "separate"] as const) assert.ok(scoreConfirmationVersion(layout, ruleset).endsWith(`+weights@${weights}`));
  // Thresholds stay outside the version: a threshold change re-decides selection without new scores.
  assert.equal(weightsVersion({ ...SELECTION, thresholds: { T1: 1 } } as typeof SELECTION), weights);
});

test("the confirmed value is the score standard; receipts and judgements keep the full step version", () => {
  for (const ruleset of RULESETS) {
    const shared = promptVersionsFor("shared", ruleset),
      separate = promptVersionsFor("separate", ruleset);
    // Separate layout: the score rules are the score request's whole system prompt, so the two are the same value.
    assert.equal(scoreConfirmationVersion("separate", ruleset), separate.score);
    // Shared layout: the full step version hashes the whole shared prompt and stays on receipts; it no longer confirms.
    assert.match(shared.score, new RegExp(`^${SELECTION_RULESETS[ruleset].score}-shared@[0-9a-f]{10}\\+weights@[0-9a-f]{10}$`));
    assert.match(
      scoreConfirmationVersion("shared", ruleset),
      new RegExp(`^${SELECTION_RULESETS[ruleset].score}-shared-standard@[0-9a-f]{10}\\+weights@[0-9a-f]{10}$`),
    );
  }
  process.env.ANALYSIS_PROMPT_LAYOUT = "shared";
  assert.equal(PROMPT_VERSIONS.score, promptVersionsFor("shared").score, "the score step still records the full version");
  assert.equal(scoringConfirmed(true, scoreConfirmationVersion("shared")), true);
  assert.equal(scoringConfirmed(true, promptVersionsFor("shared").score), false, "the full step version is not the confirmed value");
  assert.equal(scoringConfirmed(true, scoreConfirmationVersion("separate")), false, "nor is the other layout's standard");
  process.env.ANALYSIS_PROMPT_LAYOUT = "separate";
  assert.equal(scoringConfirmed(true, scoreConfirmationVersion("separate")), true);
  assert.equal(scoringConfirmed(true, scoreConfirmationVersion("shared")), false);
});

test("the config check (scripts/eval-selection.ts --config-check) reports non-score changes apart from score-standard changes", () => {
  const current = selectionConfigSnapshot();
  assert.deepEqual(Object.keys(current.versions).sort(), ["classic/separate", "classic/shared", "global/separate", "global/shared"]);
  for (const [key, v] of Object.entries(current.versions)) {
    const [ruleset, layout] = key.split("/") as [keyof typeof SELECTION_RULESETS, "shared" | "separate"];
    assert.equal(v.confirmation, scoreConfirmationVersion(layout, ruleset));
    assert.deepEqual(v.steps, { ...promptVersionsFor(layout, ruleset) });
  }
  // A baseline that differs only in the dictionary and names list: nothing to confirm, two lines for the release note.
  const baseline = structuredClone(current);
  for (const key of ["dictionary", "names", "structure-rules", "summarize-rules"]) baseline.parts[key]!.hash = "0000000000";
  const confirmed = current.versions["global/shared"]!.confirmation;
  assert.deepEqual(compareSelectionConfig(current, { baseline, confirmed }), {
    confirmedMatches: ["global/shared"],
    scoreChanged: [],
    otherChanged: ["structure-rules", "dictionary", "summarize-rules", "names"],
    confirmationsChanged: [],
  });
  const report = selectionConfigReport(current, { baseline, confirmed, configured: "global/shared" });
  assert.match(report, /评分标准没有变化，确认值不用改。/);
  assert.match(report, /非评分部分有变化（写进发布说明，不影响确认值）：结构抽取规则（含下面三项）、法域词典、标题摘要规则（含写作规则与名称表）、名称表。/);
  assert.match(report, /按这个配置上线照常打分/);
  // A score-rule change in the baseline: the report says a new confirmation is needed.
  const scoreChange = structuredClone(current);
  scoreChange.parts["score-rules/global"]!.hash = "0000000000";
  scoreChange.versions["global/shared"]!.confirmation = "selection-score-global-shared-standard@0000000000+weights@0000000000";
  const result = compareSelectionConfig(current, { baseline: scoreChange, confirmed: "selection-score-global-shared-standard@0000000000+weights@0000000000" });
  assert.deepEqual([result.scoreChanged, result.confirmationsChanged, result.confirmedMatches], [["score-rules/global"], ["global/shared"], []]);
  assert.match(selectionConfigReport(current, { baseline: scoreChange, confirmed: "x" }), /评分标准有变化：评分规则（global）。.*须 Owner 确认后改填/);
  assert.match(selectionConfigReport(current, { confirmed: "x" }), /不等于任何当前评分标准：正式站不打分/);
  // The script runs it without a database or a model.
  const out = execFileSync(process.execPath, ["scripts/eval-selection.ts", "--config-check", "--confirmed", confirmed], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH, AMP_CREDENTIALS_DIR: "/nonexistent-selection-config-check", MODEL_CALLS_ENABLED: "false", COLLECT_ENABLED: "false" },
    encoding: "utf8",
  });
  assert.match(out, /# 精选配置核对（不调用模型）/);
  for (const v of Object.values(current.versions)) assert.ok(out.includes(v.confirmation));
  assert.match(out, /等于 global\/shared 当前的评分标准。按这个配置上线照常打分。/);
});
