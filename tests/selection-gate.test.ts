import "./setup.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, test } from "node:test";
import { REPO_ROOT } from "@amp/backend/config";
import { closeDb } from "@amp/backend/db";
import { draftTierThreshold, PROMPT_VERSIONS, scoringConfirmed } from "@amp/backend/editorial/analyze";

after(async () => {
  await closeDb();
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
      const article = { id: 'gate', revision: 1, bodyStatus: 'ok', title: 'Copper mine expansion', url: 'https://example.invalid/gate',
        author: null, publishedAt: null, bodyText: 'A copper mine expansion.', excerpt: null, media: [],
        source: { name: 'Gate', kind: 'rss', tier: 'T1', firstParty: true } };
      const threshold = tierThreshold('T1');
      // Unconfirmed: the production score step returns before any model call (model calls are off here anyway).
      const scores = threshold === null ? await runSelectionScores(article) : 'not run';
      console.log(JSON.stringify({ threshold, scores, version: PROMPT_VERSIONS.score }));
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
    ) as { threshold: number | null; scores: unknown; version: string };
  const unconfirmed = run("");
  assert.deepEqual([unconfirmed.threshold, unconfirmed.scores], [null, null], "no threshold, no score request");
  assert.equal(run("selection-score@0000000000").threshold, null, "another version's confirmation does not carry over");
  assert.equal(run(unconfirmed.version).threshold, 60, "the confirmed version scores with the tier threshold");
});
