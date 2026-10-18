import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BatchSchema,
  ValueBatchSchema,
  BATCH_SYSTEM,
  batchUser,
  PairSchema,
  SignalSchema,
  LegacyIdentityAnswerSchema,
  completeDecisions,
  verdictsByFact,
  sameOccurrence,
  storyForDevelopment,
  type ReportView,
  type RelationEvidence,
} from "../packages/backend/src/events/relate.ts";
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
test("the batch example includes scope and value even when there are no identity candidates", () => {
  const example = JSON.parse(BATCH_SYSTEM.match(/```json\s*([\s\S]*?)```/)![1]!);
  assert.equal(ValueBatchSchema.safeParse(example).success, true);
  assert.equal(example.queryScope, "single");
  assert.deepEqual(example.decisions, []);
  const empty = batchUser({ ...a, scope: "unknown" }, []);
  assert.match(empty, /^事实候选数：0\n事实候选编号：\[\]/);
  assert.doesNotMatch(empty, /【候选 C1】/);
  const candidate = { factId: 1, storyId: 1, factTitle: "A", members: 1, storyRoot: true, score: 1, report: b };
  assert.match(batchUser(a, [candidate]), /^事实候选数：1\n事实候选编号：\["C1"\]/);
  assert.equal(completeDecisions([{ id: "C1" }], 0), false, "a fabricated zero-candidate answer remains invalid");
});
test("whole-report decisions survive different metadata labels and preserve distinct developments", () => {
  const candidate = {
    factId: 1,
    storyId: 1,
    factTitle: "矿产资源目录",
    members: 1,
    storyRoot: true,
    score: 0.95,
    report: { ...b, jurisdiction: "CN", frame: { object: "矿产资源分类目录" } },
  };
  const query = { ...a, jurisdiction: "CL", frame: { object: "《矿产资源目录》" } };
  const same = verdictsByFact([{ id: "C1", relation: "SAME_OCCURRENCE", confidence: 0.95, evidence }], [candidate], query);
  assert.deepEqual(
    sameOccurrence([candidate], same).map((c) => c.factId),
    [1],
    "publisher geography and extracted aliases do not split a confirmed event",
  );
  const progress = verdictsByFact([{ id: "C1", relation: "SAME_STORY", confidence: 0.95, evidence }], [candidate], query);
  assert.deepEqual(sameOccurrence([candidate], progress), [], "equal saved wording does not collapse a distinct later occurrence");
  assert.equal(storyForDevelopment([candidate], progress)?.factId, 1);
  const different = verdictsByFact([{ id: "C1", relation: "UNRELATED", confidence: 0.95 }], [candidate], query);
  assert.deepEqual(sameOccurrence([candidate], different), []);
  assert.equal(storyForDevelopment([candidate], different), null);
});

test("a same-event answer joins even when confidence is below the old 0.8 bar", () => {
  const c = { factId: 1, storyId: 1, factTitle: "A", members: 2, storyRoot: true, score: 1, report: b };
  assert.deepEqual(
    sameOccurrence([c], new Map([[1, { relation: "SAME_OCCURRENCE", confidence: 0.7, note: "" }]])).map((item) => item.factId),
    [1],
  );
  assert.equal(storyForDevelopment([c], new Map([[1, { relation: "SAME_STORY", confidence: 0.7, note: "" }]]))?.factId, 1);
  assert.deepEqual(sameOccurrence([c], new Map([[1, { relation: "UNRELATED", confidence: 0.99, note: "" }]])), []);
});

test("identity answers must cover each candidate exactly once without coercing broken output", () => {
  const candidates = [1, 2].map((n) => ({ factId: n, storyId: n, factTitle: "项目批准", members: 1, storyRoot: true, score: 1, report: b }));
  const decision = (id: string) => ({ id, relation: "UNRELATED" as const, confidence: 0.9 });
  assert.equal(completeDecisions([decision("C2"), decision("C1")], 2), true);
  assert.equal(verdictsByFact([decision("C2"), decision("C1")], candidates).size, 2);
  for (const ids of [[], ["C1"], ["C1", "C1"], ["C0", "C2"], ["C1", "C3"], ["1", "C2"], ["C1", "C2", "C3"]]) {
    assert.equal(completeDecisions(ids.map(decision), 2), false);
    assert.throws(() => verdictsByFact(ids.map(decision), candidates), /every candidate/);
  }
  for (const malformed of [
    {},
    { decisions: null },
    { decisions: [{ ...decision("C1"), relation: "MAYBE" }] },
    { decisions: [{ ...decision("C1"), confidence: "0.9" }] },
    { decisions: [decision("C0")] },
  ]) {
    assert.equal(BatchSchema.safeParse(malformed).success, false);
    assert.equal(SignalSchema.safeParse(malformed).success, false);
  }
  assert.equal(PairSchema.safeParse({ relation: "MAYBE", confidence: 0.9 }).success, false);
  const legacy = LegacyIdentityAnswerSchema.parse({ decisions: [{ ...decision("1"), confidence: "0.9" }] });
  assert.equal("selection" in legacy, false, "legacy identity evidence never implies selection value");
});

test("reading context is separate from identity candidates and missing value is never affirmative", () => {
  const candidate = { factId: 1, storyId: 1, factTitle: "铜矿建设", members: 1, storyRoot: true, score: 1, report: b };
  const unseen = batchUser(a, [candidate]);
  assert.match(unseen, /尚无公开精选/);
  assert.doesNotMatch(unseen, /【已公开精选】/);
  const selected = batchUser(a, [{ ...candidate, selected: true, selectedReport: { ...b, summary: "已公开建设计划" } }], "新报道", [
    { report: { ...b, summary: "已公开综合稿" } },
  ]);
  assert.match(selected, /【候选 C1】/);
  assert.match(selected, /【已公开精选】/);
  assert.match(selected, /阅读背景 R1/);
  assert.equal(ValueBatchSchema.safeParse({ decisions: [] }).success, false);
  assert.equal(ValueBatchSchema.safeParse({ decisions: [], selection: { addsValue: "false", reason: "已覆盖" } }).success, false);
  assert.equal(ValueBatchSchema.parse({ decisions: [], selection: { addsValue: false, reason: "已覆盖" } }).selection.addsValue, false);
});

test("date-only grouping context does not manufacture a midnight publication clock", () => {
  const input = batchUser({ ...a, at: new Date("2026-10-15T00:00:00+08:00") }, []);
  assert.match(input, /发布时间：2026-10-15\n/);
  assert.doesNotMatch(input, /发布时间：2026-10-15 00:00/);
});
