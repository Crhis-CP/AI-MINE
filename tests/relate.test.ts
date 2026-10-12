import { test } from "node:test";
import assert from "node:assert/strict";
import { validatedRelation, sameOccurrence, storyForDevelopment, type ReportView, type RelationEvidence } from "../packages/backend/src/events/relate.ts";
const text = "Argentina Alpha project approved its lithium plant construction on Monday.";
const a: ReportView = {
  title: "A",
  source: "A",
  firstParty: true,
  at: new Date("2026-10-10"),
  summary: null,
  originalText: text,
  jurisdiction: "AR",
  frame: { subject: "Alpha", object: "Alpha project" },
};
const b = { ...a, at: new Date("2026-10-09") };
const evidence: RelationEvidence = {
  queryQuote: text,
  candidateQuote: text,
  anchor: "Alpha project",
  queryAction: "approved",
  candidateAction: "approved",
  queryStage: "approved",
  candidateStage: "approved",
  change: "",
};
test("event relationship requires confidence and current bilateral raw evidence", () => {
  const v = { relation: "SAME_OCCURRENCE" as const, confidence: 0.95, evidence };
  assert.equal(validatedRelation(a, b, v), "SAME_OCCURRENCE");
  for (const bad of [
    { ...v, confidence: 0 },
    { ...v, evidence: null },
    { ...v, evidence: { ...evidence, queryQuote: "invented quotation" } },
    { ...v, evidence: { ...evidence, queryStage: "proposed" as const } },
  ])
    assert.equal(validatedRelation(a, b, bad), "UNRELATED");
  assert.equal(validatedRelation(a, { ...b, jurisdiction: "CL" }, v), "UNRELATED");
  assert.equal(validatedRelation(a, { ...b, frame: { object: "Beta project" } }, v), "UNRELATED");
  assert.equal(validatedRelation(a, b, { ...v, relation: "SAME_STORY" }), "UNRELATED");
});
test("low confidence cannot enter occurrence or development through a secondary path", () => {
  const c = { factId: 1, storyId: 1, factTitle: "A", members: 2, storyRoot: true, score: 1, report: b };
  assert.deepEqual(sameOccurrence([c], new Map([[1, { relation: "SAME_OCCURRENCE", confidence: 0, note: "" }]])), []);
  assert.equal(storyForDevelopment([c], new Map([[1, { relation: "SAME_STORY", confidence: 0, note: "" }]])), null);
});
