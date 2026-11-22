// The selection rule sets (TASK-0670, SELECTION_RULESET): `global` is the default, `classic` is the rules production
// ran before the switch existed. A rollback is "SELECTION_RULESET=classic and the earlier confirmed version", so the
// classic prompts and versions are locked here to what main produced before this card, byte for byte.
import "./setup.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { after, afterEach, test } from "node:test";
import { REPO_ROOT, selectionRuleset } from "@amp/backend/config";
import { closeDb } from "@amp/backend/db";
import {
  draftTierThreshold,
  PROMPT_VERSIONS,
  promptVersionsFor,
  scoreConfirmationVersion,
  scoringConfirmed,
  selectionStepRequest,
  selectionSystem,
  type AnalyzeInputArticle,
} from "@amp/backend/editorial/analyze";
import { promptText } from "@amp/backend/editorial/prompts";
import { MAJOR_COMPANIES, SELECTION, SELECTION_RULESETS } from "@amp/industry/selection";
import { selectionStandardSnapshot } from "../packages/backend/src/admin/selectbench-runtime.ts";
import { replaceOnce } from "../scripts/rules-replay.ts";

const PINNED = process.env.SELECTION_RULESET;
const use = (ruleset: string | undefined) => {
  if (ruleset === undefined) delete process.env.SELECTION_RULESET;
  else process.env.SELECTION_RULESET = ruleset;
};
afterEach(() => use(PINNED));
after(async () => {
  await closeDb();
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

// Computed on main at d6d455a (the card's base), before the switch existed, from the rule files this card leaves
// unchanged (industry/prompts/selection-score.md, prefilter.md and every file analysis-shared.md includes). A later
// card that edits a classic prompt on purpose updates these with it; nothing else may move them.
const CLASSIC = {
  shared: {
    prefilter: "prefilter-shared@aa4cb4ab1b",
    score: "selection-score-shared@a195d5bf17+weights@20542a669a",
    understand: "understand-shared@67013426b1",
    summarize: "summarize-article-shared@0fb433b2f0",
    wording: "mend-wording-shared@92bbeecad5",
    structure: "structure-shared@d1b6dd90cf",
  },
  separate: {
    prefilter: "prefilter@f1a5eca242",
    score: "selection-score@9881743a29+weights@20542a669a",
    understand: "understand@020b743696",
    summarize: "summarize-article+summarize-article-empty+identity-context@443eeceb36",
    wording: "mend-wording@ce7f633f0f",
    structure: "structure@d2f901c571",
  },
  systems: {
    shared: "940918c94cd77c4e0626af2e08d128bba3f39df48f5445590e994bfb2c29cab7",
    score: "c7ffd384dcd001bc1e199b2d25ddc5d65a4644e1f8eba26d19d8368dc67d7fbf",
    prefilter: "95396960e6ad8e0e35f77318232a08dfb54a2a4006b73adf4cd1e3fc4bc35f86",
  },
} as const;
// The global rule set's selection versions, as the card's delivery record gives them to the release.
const GLOBAL = {
  shared: { prefilter: "prefilter-four-layers-shared@de030505f1", score: "selection-score-global-shared@39c374ad10+weights@20542a669a" },
  separate: { prefilter: "prefilter-four-layers@ab17e835d0", score: "selection-score-global@47d13bde9b+weights@20542a669a" },
} as const;
// The values SELECTION_CONFIRMED_VERSION names (TASK-0710: the score standard, not the whole shared prompt), as the
// card's delivery record gives them to the release. In the separate layout the score standard is the score step's
// version. Only a change to what defines the score (score rules, preamble, score heading and step instruction, material
// recipe, weights and caps) may move them, and that change needs a new Owner confirmation.
const CONFIRMED = {
  global: { shared: "selection-score-global-shared-standard@e85fbf2117+weights@20542a669a", separate: GLOBAL.separate.score },
  classic: { shared: "selection-score-shared-standard@8a6af9afe0+weights@20542a669a", separate: CLASSIC.separate.score },
} as const;

const article: AnalyzeInputArticle = {
  id: "ruleset",
  revision: 1,
  title: "合成铜矿权益金法案",
  url: "https://example.invalid/ruleset",
  author: null,
  publishedAt: null,
  bodyText: "合成资源国议会通过矿业权益金法案，铜矿项目税负上调。",
  excerpt: null,
  media: [],
  source: { name: "合成来源", kind: "rss", tier: "T1", firstParty: true },
};

test("the default rule set is global; classic is named explicitly; anything else is refused, not replaced", () => {
  use(undefined);
  assert.equal(selectionRuleset(), "global");
  use("");
  assert.equal(selectionRuleset(), "global", "an empty value is an unset one");
  use("global");
  assert.equal(selectionRuleset(), "global");
  use("classic");
  assert.equal(selectionRuleset(), "classic");
  for (const bad of ["Global", "classic ", "old", "selection-score"]) {
    use(bad);
    assert.throws(() => selectionRuleset(), /SELECTION_RULESET must be one of global, classic/, bad);
    assert.throws(() => PROMPT_VERSIONS.score, /SELECTION_RULESET/, "no version, so no request, under a mistyped rule set");
  }
});

test("a backend process with an invalid rule set stops as it starts; without the variable it runs the global rules", () => {
  // The switch is read from the process environment, so each case is its own process, as production starts one.
  const start = (ruleset: string | undefined) =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import '@amp/backend/config';
         const { PROMPT_VERSIONS } = await import('@amp/backend/editorial/analyze');
         console.log(JSON.stringify([PROMPT_VERSIONS.prefilter, PROMPT_VERSIONS.score]));
         process.exit(0);`,
      ],
      {
        cwd: REPO_ROOT,
        env: {
          PATH: process.env.PATH,
          AMP_CREDENTIALS_DIR: "/nonexistent-selection-ruleset-test",
          MODEL_CALLS_ENABLED: "false",
          COLLECT_ENABLED: "false",
          ...(ruleset === undefined ? {} : { SELECTION_RULESET: ruleset }),
        },
        encoding: "utf8",
      },
    );
  const versions = (ruleset: string | undefined) => {
    const run = start(ruleset);
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout.trim().split("\n").at(-1)!) as string[];
  };
  // No SELECTION_RULESET and no ANALYSIS_PROMPT_LAYOUT: the production defaults.
  assert.deepEqual(versions(undefined), [GLOBAL.shared.prefilter, GLOBAL.shared.score]);
  assert.deepEqual(versions("classic"), [CLASSIC.shared.prefilter, CLASSIC.shared.score], "the rollback's versions");
  const bad = start("globl");
  assert.notEqual(bad.status, 0, "the process must not start");
  assert.match(bad.stderr, /SELECTION_RULESET must be one of global, classic \(got "globl"\)/);
  assert.equal(bad.stdout.trim(), "", "it stopped at the configuration, before any prompt was read");
});

test("classic: both layouts' system prompts and every prompt version are what main produced before the switch", () => {
  assert.deepEqual({ ...promptVersionsFor("shared", "classic") }, CLASSIC.shared);
  assert.deepEqual({ ...promptVersionsFor("separate", "classic") }, CLASSIC.separate);
  const shared = selectionSystem("score", "shared", "classic"),
    score = selectionSystem("score", "separate", "classic"),
    prefilter = selectionSystem("prefilter", "separate", "classic");
  assert.equal(selectionSystem("prefilter", "shared", "classic"), shared, "one shared system prompt for both steps");
  assert.deepEqual({ shared: sha(shared), score: sha(score), prefilter: sha(prefilter) }, CLASSIC.systems);
  // The same bytes, straight from the unmodified rule files.
  assert.equal(score, promptText("selection-score", { majorCompanies: MAJOR_COMPANIES.join("、") }));
  assert.equal(prefilter, promptText("prefilter"));
  assert.equal(shared.split(score).length, 2);
  assert.equal(shared.split(prefilter).length, 2);
  // The configured switch reaches the same prompts and versions: this is what a rollback runs.
  use("classic");
  for (const layout of ["shared", "separate"] as const) {
    assert.deepEqual({ ...promptVersionsFor(layout) }, CLASSIC[layout]);
    assert.equal(selectionStepRequest("score", article, layout).system, layout === "shared" ? shared : score);
    assert.equal(selectionStepRequest("prefilter", article, layout).system, layout === "shared" ? shared : prefilter);
  }
});

test("global: both layouts send the new score and prefilter rules, under their own versions", () => {
  for (const layout of ["shared", "separate"] as const) {
    const versions = promptVersionsFor(layout, "global");
    assert.deepEqual({ prefilter: versions.prefilter, score: versions.score }, GLOBAL[layout]);
    const score = selectionSystem("score", layout, "global"),
      prefilter = selectionSystem("prefilter", layout, "global");
    assert.match(score, /影响面/);
    assert.match(score, /资源国政治与安全风险/);
    assert.match(prefilter, /资源国的政治与安全风险/);
    assert.match(prefilter, /中国对外投资与中资动态/);
    assert.match(prefilter, /只有写明了对某种金属的具体影响时才 PASS/);
    // Nothing written only for Chinese readers is left in what the global rule set sends.
    for (const system of [score, prefilter])
      for (const only of ["中国读者", "直接涉及中国", "对华贸易措施", "中资企业的海外项目", "或中资收购", "与中资合作", "共振面"])
        assert.ok(!system.includes(only), `${layout}: ${only}`);
    for (const step of ["understand", "summarize", "wording", "structure"] as const)
      assert.equal(versions[step] === promptVersionsFor(layout, "classic")[step], layout === "separate", `${layout} ${step}`);
  }
  // The files are the ones the industry pack names, unchanged by the layout.
  assert.equal(selectionSystem("score", "separate", "global"), promptText(SELECTION_RULESETS.global.score, { majorCompanies: MAJOR_COMPANIES.join("、") }));
  assert.equal(selectionSystem("prefilter", "separate", "global"), promptText(SELECTION_RULESETS.global.prefilter));
  // The shared prompts of the two rule sets differ in the two rules and in nothing else.
  const back = [
    [selectionSystem("score", "separate", "global"), selectionSystem("score", "separate", "classic")],
    [selectionSystem("prefilter", "separate", "global"), selectionSystem("prefilter", "separate", "classic")],
  ].reduce((text, [from, to]) => replaceOnce(text, from!, to!, "back to classic"), selectionSystem("score", "shared", "global"));
  assert.equal(back, selectionSystem("score", "shared", "classic"));
});

test("the configured rule set decides what a request sends and which version it records", () => {
  const systems = (layout: "shared" | "separate") => [
    selectionStepRequest("prefilter", article, layout).system,
    selectionStepRequest("score", article, layout).system,
  ];
  for (const ruleset of ["global", "classic"] as const) {
    use(ruleset === "global" ? undefined : ruleset);
    for (const layout of ["shared", "separate"] as const) {
      assert.deepEqual(systems(layout), [selectionSystem("prefilter", layout, ruleset), selectionSystem("score", layout, ruleset)], `${ruleset} ${layout}`);
      assert.equal(promptVersionsFor(layout), promptVersionsFor(layout, ruleset));
      // The article and the step instruction are the same under either rule set: only the rules differ.
      assert.equal(selectionStepRequest("score", article, layout).user, selectionStepRequest("score", article, layout, undefined, "classic").user);
    }
    assert.equal(PROMPT_VERSIONS.score, promptVersionsFor("separate", ruleset).score, "setup.ts pins the separate layout");
    const snapshot = selectionStandardSnapshot();
    assert.deepEqual(
      [snapshot.text, snapshot.prefilterText, snapshot.prefilterVersion],
      [selectionSystem("score", "separate", ruleset), selectionSystem("prefilter", "separate", ruleset), promptVersionsFor("separate", ruleset).prefilter],
      "SelectBench shows the standard the configured rule set scores with",
    );
  }
});

test("production scores only when the confirmed version is the configured rule set's; weights and thresholds are shared", () => {
  for (const layout of ["shared", "separate"] as const) {
    process.env.ANALYSIS_PROMPT_LAYOUT = layout;
    use(undefined);
    assert.equal(scoringConfirmed(true, CONFIRMED.global[layout]), true);
    assert.equal(scoringConfirmed(true, CONFIRMED.classic[layout]), false, "the earlier confirmation does not release the new rules");
    use("classic");
    assert.equal(scoringConfirmed(true, CONFIRMED.classic[layout]), true, "rollback: the switch and the earlier confirmed version together");
    assert.equal(scoringConfirmed(true, CONFIRMED.global[layout]), false);
  }
  for (const ruleset of ["global", "classic"] as const)
    for (const layout of ["shared", "separate"] as const)
      assert.equal(scoreConfirmationVersion(layout, ruleset), CONFIRMED[ruleset][layout], `${ruleset} ${layout}`);
  process.env.ANALYSIS_PROMPT_LAYOUT = "separate";
  const weights = (version: string) => version.split("+").at(-1);
  assert.deepEqual(
    [GLOBAL.shared.score, GLOBAL.separate.score, CLASSIC.shared.score, CLASSIC.separate.score, CONFIRMED.global.shared, CONFIRMED.classic.shared].map(weights),
    Array.from({ length: 6 }, () => "weights@20542a669a"),
  );
  assert.deepEqual(SELECTION.thresholds, { T1: 62, T1_5: 64, T2: 66 });
  assert.deepEqual([draftTierThreshold("T1"), draftTierThreshold("T1_5"), draftTierThreshold("T2")], [62, 64, 66]);
});
