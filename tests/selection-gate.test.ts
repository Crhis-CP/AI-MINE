import "./setup.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, test } from "node:test";
import { REPO_ROOT } from "@amp/backend/config";
import { closeDb } from "@amp/backend/db";
import { buildScoreInput, draftTierThreshold, PROMPT_VERSIONS, scoringConfirmed, type AnalyzeInputArticle } from "@amp/backend/editorial/analyze";

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
  assert.equal(scoringConfirmed(true, PROMPT_VERSIONS.score), true);
  // Evaluations decide with the draft's thresholds in any environment (scripts/eval-selection.ts).
  assert.deepEqual([draftTierThreshold("T1"), draftTierThreshold("T1_5"), draftTierThreshold("T2"), draftTierThreshold("EXCLUDE_MP")], [60, 65, 76, null]);
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
      import { PROMPT_VERSIONS, runSelectionScores, tierThreshold } from '@amp/backend/editorial/analyze';
      import { recomputeSelection } from './packages/backend/src/publication/selection-recompute.ts';
      const article = { id: 'gate', revision: 1, bodyStatus: 'ok', title: 'Copper mine expansion', url: 'https://example.invalid/gate',
        author: null, publishedAt: null, bodyText: 'A copper mine expansion.', excerpt: null, media: [],
        source: { name: 'Gate', kind: 'rss', tier: 'T1', firstParty: true } };
      const threshold = tierThreshold('T1');
      // Unconfirmed: the production score step returns before any model call (model calls are off here anyway).
      const scores = threshold === null ? await runSelectionScores(article) : 'not run';
      const renominated = recomputeSelection({id: 1, relevance: 'pass', selected: false, output: {threshold: 76, scores: [65, 65]}}, 'T1', new Date(), new Date()).selected;
      console.log(JSON.stringify({ threshold, scores, version: PROMPT_VERSIONS.score, renominated }));
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
  assert.equal(confirmed.threshold, 60, "the confirmed version scores with the tier threshold");
  assert.equal(confirmed.renominated, true);
});
