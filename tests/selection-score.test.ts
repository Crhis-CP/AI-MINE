// The score is computed in code from the model's type and five axes (Owner 2026-11-05): continuous to one decimal,
// weighted by the confirmed type table, capped for unusable material; selection still compares the mean with the tier threshold.
import assert from "node:assert/strict";
import { test } from "node:test";
import { attentionScore, meetsThreshold, scoreSettled, SELECTION } from "@amp/industry/selection";
import { normalizeAnalysis, ScoreSchema } from "@amp/backend/editorial/analyze";

test("weighted axes give a one-decimal score instead of a few habitual integers", () => {
  // policy_regulation weights [3,1,2,2,2]
  assert.equal(attentionScore({ type: "policy_regulation", sig: 6.4, nov: 5.8, cred: 7.1, reson: 6.2, act: 5.5 }), 61.7);
  assert.equal(attentionScore({ type: "policy_regulation", sig: 6.6, nov: 5.8, cred: 7.1, reson: 6.2, act: 5.5 }), 62.3);
  assert.equal(attentionScore({ type: "safety_incident", sig: 10, nov: 10, cred: 10, reson: 10, act: 10 }), 100);
  assert.equal(attentionScore({ type: "company_project", sig: 9, nov: 9, cred: 9, reson: 9, act: 9, materialUnusable: true }), SELECTION.unusableMaterialCap);
  assert.throws(() => attentionScore({ type: "unknown", sig: 5, nov: 5, cred: 5, reson: 5, act: 5 }));
  assert.equal(ScoreSchema.safeParse({ type: "capital_ma", sig: 11, nov: 5, cred: 5, reson: 5, act: 5 }).success, false);
});

test("the shown score is the one-decimal mean; reaching the threshold exactly selects", () => {
  const run = (values: number[]) =>
    normalizeAnalysis({
      prefilter: { label: "PASS", reason: "", model: "m", receiptId: 1, reused: false },
      scores: { model: "m", threshold: 60, values, receiptIds: [1, 2], reused: false },
      writing: { kind: "summarize", model: "m", titleZh: "标题", summaryZh: "摘要", reasonZh: null, tags: null, receiptIds: [], reused: false },
      structure: null,
    } as unknown as Parameters<typeof normalizeAnalysis>[0]);
  assert.deepEqual([run([63.6, 64.2]).score, run([63.6, 64.2]).selected], [63.9, true]);
  assert.deepEqual([run([59.9, 60.1]).score, run([59.9, 60.1]).selected], [60, true]);
  assert.deepEqual([run([59.8, 60.1]).score, run([59.8, 60.1]).selected], [60, false]);
});

test("noise types cap the total in code; the model cannot lift a capped item past its cap", () => {
  const high = { type: "company_project", sig: 9, nov: 9, cred: 9, reson: 9, act: 9 };
  assert.equal(attentionScore({ ...high, noise: "none" }), 90);
  assert.equal(attentionScore({ ...high, noise: "out_of_scope" }), SELECTION.noiseCaps.out_of_scope);
  assert.equal(attentionScore({ ...high, noise: "event_routine" }), SELECTION.noiseCaps.event_routine);
  assert.equal(attentionScore({ ...high, noise: "junior_routine" }), SELECTION.noiseCaps.junior_routine);
  assert.equal(attentionScore({ ...high, noise: "junior_routine", materialUnusable: true }), SELECTION.unusableMaterialCap);
  assert.equal(ScoreSchema.parse({ type: "capital_ma", sig: 5, nov: 5, cred: 5, reson: 5, act: 5 }).noise, "none");
  assert.equal(ScoreSchema.parse({ type: "capital_ma", sig: 5, nov: 5, cred: 5, reson: 5, act: 5, noise: "made_up" }).noise, "none");
});

test("a first score far from the threshold settles alone; near ones take a second call (Owner 2026-11-05, cost)", () => {
  assert.equal(SELECTION.secondScoreMargin, 15, "this file runs without tests/setup.ts, so it sees the production margin");
  assert.equal(scoreSettled([40], 62), true);
  assert.equal(scoreSettled([80], 62), true);
  assert.equal(scoreSettled([50], 62), false);
  assert.equal(scoreSettled([75], 62), false);
  assert.equal(scoreSettled([40, 41], 62), true);
  assert.equal(scoreSettled([], 62), false);
  assert.equal(meetsThreshold([80], 62), true);
  assert.equal(meetsThreshold([40], 62), false);
  assert.equal(meetsThreshold([59.8, 60.1], 60), false);
  assert.equal(meetsThreshold([59.9, 60.1], 60), true);
});
