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
  GROUP_ARTICLE_CANDIDATES,
  GROUP_BRIEF_EXCERPT_CHARS,
  GROUP_BRIEF_FALLBACK_CHARS,
  GROUP_FULL_TEXT_CANDIDATES,
  PAIR_BATCH_SYSTEM,
  PairBatchSchema,
  pairBatchUser,
  certainDuplicate,
  documentKey,
  documentKeys,
  titleNamesDocument,
  firmlyTied,
  reviewUnneeded,
  SKIP_REVIEW_MIN_COSINE,
  TIE_MIN_CONFIDENCE,
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

test("group_article sends full originals only for the query and the leading candidates; the rest carry summary, frame and an excerpt", () => {
  const long = (label: string) => `${label} ${"Andes project construction permit detail. ".repeat(80)}`;
  const report = (label: string, summary: string | null): ReportView => ({ ...a, title: label, summary, originalText: long(label) });
  const candidate = (n: number, summary: string | null) => ({
    factId: n,
    storyId: n,
    factTitle: `事实${n}`,
    members: 1,
    storyRoot: true,
    score: 1 - n / 10,
    report: report(`candidate-${n}`, summary),
  });
  const cands = [
    candidate(1, "摘要一"),
    candidate(2, "摘要二"),
    candidate(3, "摘要三"),
    { ...candidate(4, null), selected: true, selectedReport: report("selected-4", "精选摘要") },
  ];
  const input = batchUser(report("query", "新稿摘要"), cands, "新报道", [{ report: report("background", null) }], GROUP_FULL_TEXT_CANDIDATES);
  const block = (label: string) => input.split("\n\n").find((part) => part.includes(`标题：${label}\n`))!;
  for (const label of ["query", "candidate-1", "candidate-2"]) {
    assert.ok(block(label).includes(`原文证据：${long(label)}`), `${label} keeps its full original`);
    assert.doesNotMatch(block(label), /节选/);
  }
  assert.ok(block("candidate-3").includes(`原文证据（节选前${GROUP_BRIEF_EXCERPT_CHARS}字`), "a stored summary replaces the full original");
  assert.ok(block("candidate-3").includes(`${long("candidate-3").slice(0, GROUP_BRIEF_EXCERPT_CHARS)}\n`));
  assert.ok(!block("candidate-3").includes(long("candidate-3").slice(0, GROUP_BRIEF_EXCERPT_CHARS + 1)));
  assert.match(block("candidate-3"), /摘要：摘要三\n事实要素：主体=Alpha/);
  for (const label of ["candidate-4", "background"]) {
    assert.ok(block(label).includes(`原文证据（节选前${GROUP_BRIEF_FALLBACK_CHARS}字`), `${label} without a summary falls back to a longer excerpt`);
    assert.ok(!block(label).includes(long(label).slice(0, GROUP_BRIEF_FALLBACK_CHARS + 1)));
  }
  assert.ok(block("selected-4").includes(`原文证据（节选前${GROUP_BRIEF_EXCERPT_CHARS}字`), "a later candidate's selected report is brief too");
  assert.ok(input.length < long("x").length * 5, "three full originals and short excerpts instead of seven full originals");
  assert.equal(batchUser(a, [candidate(3, "摘要三")]).includes("节选"), false, "other callers keep the full rendering");
  const short = { ...candidate(3, "摘要三"), report: { ...b, summary: "摘要三" } };
  assert.ok(
    batchUser(a, [short, short, short], "新报道", [], GROUP_FULL_TEXT_CANDIDATES).includes(`原文证据：${text}`),
    "a short original is not labelled as an excerpt",
  );
  assert.equal(GROUP_ARTICLE_CANDIDATES, 5);
});

test("batched review pairs map each decision back to its own candidate", () => {
  const user = pairBatchUser({ ...a, title: "query" }, [
    { ...b, title: "B1" },
    { ...b, title: "B2" },
  ]);
  assert.match(user, /^候选数：2\n候选编号：\["C1","C2"\]\n\n【报道 A】\n标题：query/);
  assert.match(user, /【候选 C1（报道 B）】\n标题：B1[\s\S]*【候选 C2（报道 B）】\n标题：B2/);
  assert.match(PAIR_BATCH_SYSTEM, /SAME_OCCURRENCE（同一次发生）/);
  const answer = PairBatchSchema.parse({
    decisions: [
      { id: "C2", relation: "UNRELATED", confidence: 0.9, difference: "不同项目" },
      { id: "C1", relation: "SAME_STORY", confidence: 0.95, difference: "后续批准", evidence },
    ],
  });
  assert.equal(completeDecisions(answer.decisions, 2), true);
  assert.equal(completeDecisions(answer.decisions.slice(0, 1), 2), false);
  assert.equal(answer.decisions.find((d) => d.id === "C2")!.evidence, null);
  assert.equal(PairBatchSchema.safeParse({ a: "x", b: "y", relation: "SAME_STORY", confidence: 0.9 }).success, false, "a pair answer is not a batch answer");
});

test("a named document has one key however it is written, and a local measure built on its name is another document", () => {
  assert.equal(documentKey("中华人民共和国生态环境法典"), "生态环境法典");
  assert.equal(documentKey("生态环境法典（2026年修订）"), "生态环境法典", "version notes do not split a document");
  assert.equal(documentKey("矿产资源法(征求意见稿)"), "矿产资源法");
  assert.equal(documentKey("通知"), null, "a generic name identifies nothing");
  assert.equal(documentKey("华尔街日报"), null, "a newspaper is no document");
  assert.deepEqual(documentKeys(["河南省水利厅转载《中华人民共和国生态环境法典》全文", "据《人民日报》报道"]), ["生态环境法典"]);
  assert.deepEqual(documentKeys(["河南省印发《河南省生态环境法典实施办法》"]), ["河南省生态环境法典实施办法"]);
  assert.equal(titleNamesDocument("全国人大常委会表决通过生态环境法典", "生态环境法典"), true, "a fact title without book-title marks still names it");
  assert.equal(titleNamesDocument("学习《生态环境法典》（全文）", "生态环境法典"), true);
  assert.equal(titleNamesDocument("河南省印发《河南省生态环境法典实施办法》", "生态环境法典"), false);
  assert.equal(titleNamesDocument("矿产资源目录发布", "生态环境法典"), false);
});

test("the tie bar is 0.7 and only near-identical same-day pairs in one country skip the review call", () => {
  assert.equal(TIE_MIN_CONFIDENCE, 0.7);
  assert.equal(firmlyTied("SAME_OCCURRENCE", 0.72), true);
  assert.equal(firmlyTied("SAME_STORY", 0.69), false);
  assert.equal(firmlyTied("UNRELATED", 0.99), false);
  const day = { at: new Date("2026-11-05T09:00:00+08:00"), jurisdiction: "CN" };
  assert.equal(SKIP_REVIEW_MIN_COSINE, 0.92);
  assert.equal(reviewUnneeded(0.95, day, { at: new Date("2026-11-05T23:00:00+08:00"), jurisdiction: "中国" }), true, "one country by any name");
  assert.equal(reviewUnneeded(0.95, day, { at: new Date("2026-11-05T20:00:00+08:00"), jurisdiction: null }), true, "a blank side is no conflict");
  assert.equal(reviewUnneeded(0.91, day, day), false);
  assert.equal(reviewUnneeded(0.95, day, { ...day, at: new Date("2026-11-06T00:30:00+08:00") }), false, "another Beijing day");
  assert.equal(reviewUnneeded(0.95, day, { ...day, jurisdiction: "CL" }), false, "conflicting countries");
  assert.equal(reviewUnneeded(0.95, day, { ...day, at: null }), false);
});

test("only near-identical same-day copies with one title or one named document are tied without the judge", () => {
  const day = { at: new Date("2026-11-05T09:00:00+08:00"), jurisdiction: "CN" };
  const t = (title: string, extra: Partial<typeof day> = {}) => ({ ...day, ...extra, title });
  assert.equal(
    certainDuplicate(0.95, t("紫金矿业宣布卡莫阿铜矿三期投产"), t("新华社：紫金矿业宣布卡莫阿铜矿三期投产！")),
    true,
    "source label and punctuation ignored",
  );
  assert.equal(certainDuplicate(0.95, t("学习《中华人民共和国生态环境法典》"), t("《生态环境法典》全文")), true, "one named document");
  assert.equal(certainDuplicate(0.95, t("《生态环境法典》全文"), t("《河南省生态环境法典实施办法》")), false, "a local measure is another document");
  assert.equal(certainDuplicate(0.95, t("紫金矿业宣布卡莫阿铜矿三期投产"), t("紫金矿业宣布卡莫阿铜矿三期投产延期")), false, "different titles go to the judge");
  assert.equal(certainDuplicate(0.9, t("紫金矿业宣布卡莫阿铜矿三期投产"), t("紫金矿业宣布卡莫阿铜矿三期投产")), false, "below 0.92");
  assert.equal(
    certainDuplicate(0.99, t("紫金矿业宣布卡莫阿铜矿三期投产"), t("紫金矿业宣布卡莫阿铜矿三期投产", { at: new Date("2026-11-06T09:00:00+08:00") })),
    false,
    "another day",
  );
  assert.equal(certainDuplicate(0.99, t("矿业新闻"), t("矿业新闻")), false, "too short a title");
});
