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
test("event relationship keeps a confident same event and splits conflicts", () => {
  const v = { relation: "SAME_OCCURRENCE" as const, confidence: 0.95, evidence };
  assert.equal(validatedRelation(a, b, v), "SAME_OCCURRENCE");
  assert.equal(validatedRelation(a, b, { ...v, evidence: null }), "SAME_OCCURRENCE", "a paraphrase without a boxed quote still joins");
  assert.equal(
    validatedRelation(a, b, { ...v, evidence: { ...evidence, queryQuote: "a wording the original does not contain verbatim" } }),
    "SAME_OCCURRENCE",
    "the quote does not have to be a verbatim slice of both originals",
  );
  assert.equal(validatedRelation(a, b, { ...v, confidence: 0 }), "SAME_OCCURRENCE", "a same-event answer joins even when confidence is low");
  assert.equal(validatedRelation(a, b, { ...v, evidence: { ...evidence, queryStage: "proposed" as const } }), "UNRELATED");
  assert.equal(validatedRelation(a, { ...b, jurisdiction: "CL" }, v), "UNRELATED");
  assert.equal(validatedRelation(a, { ...b, jurisdiction: "CN-AH" }, { ...v }), "UNRELATED", "a Chinese province is not Argentina");
  assert.equal(validatedRelation(a, { ...b, frame: { object: "Beta project" } }, v), "UNRELATED");
  assert.equal(validatedRelation(a, b, { ...v, relation: "SAME_STORY" }), "SAME_OCCURRENCE", "a reprint labeled as a development still joins the same event");
  assert.equal(
    validatedRelation(
      { ...a, at: new Date("2026-10-12"), originalText: "Argentina Alpha project approved 80 tonnes." },
      { ...b, originalText: "Argentina Alpha project approved 10 tonnes." },
      {
        relation: "SAME_STORY",
        confidence: 0.9,
        evidence: { ...evidence, queryQuote: "approved 80", candidateQuote: "approved 10", queryAction: "扩大", change: "产能提高" },
      },
    ),
    "SAME_STORY",
  );
});
function reprint(over: Partial<ReportView> & { originalText: string }): ReportView {
  return {
    title: over.title ?? "转述",
    source: over.source ?? "转述来源",
    firstParty: over.firstParty ?? false,
    at: over.at ?? new Date("2026-10-14T03:25:00Z"),
    summary: null,
    originalText: over.originalText,
    jurisdiction: "jurisdiction" in over ? (over.jurisdiction ?? null) : "CN",
    frame: over.frame ?? null,
  };
}

test("one policy or one speech stays one occurrence when outlets word it differently", () => {
  const catalogA = "自然资源部公布优化调整后的矿产资源目录";
  const catalogB = "自然资源部发布矿产资源目录共174个矿种";
  const catalog = {
    relation: "SAME_OCCURRENCE" as const,
    confidence: 0.95,
    evidence: {
      queryQuote: catalogA,
      candidateQuote: catalogB,
      anchor: "矿产资源目录",
      queryAction: "公布",
      candidateAction: "发布",
      queryStage: "other" as const,
      candidateStage: "other" as const,
      change: "",
    },
  };
  assert.equal(
    validatedRelation(
      reprint({ originalText: catalogA, frame: { subject: "自然资源部", action: "公布", object: "矿产资源目录" } }),
      reprint({
        originalText: catalogB,
        source: "中国地质调查局",
        frame: { subject: "自然资源部会同国家发展改革委", action: "发布", object: "《矿产资源目录》" },
      }),
      catalog,
    ),
    "SAME_OCCURRENCE",
  );
  assert.equal(
    validatedRelation(
      reprint({ originalText: catalogA, source: "安徽省自然资源厅", frame: { subject: "安徽省自然资源厅", object: "矿产资源目录" } }),
      reprint({ originalText: catalogB, source: "中国地质调查局", frame: { subject: "中国地质调查局", object: "《矿产资源目录》" } }),
      catalog,
    ),
    "SAME_OCCURRENCE",
    "outlet names differ, the document does not",
  );
  const speechA = "习近平就推动中非矿业合作提出4点主张";
  const speechB = "习近平主席同博茨瓦纳总统会谈并就中非矿业合作提出4点主张";
  assert.equal(
    validatedRelation(
      reprint({ originalText: speechA, frame: { subject: "习近平", action: "提出", object: "4点主张" } }),
      reprint({ originalText: speechB, frame: { subject: "习近平主席", action: "提出", object: "中非矿业合作4点主张" } }),
      {
        relation: "SAME_OCCURRENCE",
        confidence: 0.95,
        evidence: {
          queryQuote: speechA,
          candidateQuote: speechB,
          anchor: "中非矿业合作",
          queryAction: "提出",
          candidateAction: "提出",
          queryStage: "other",
          candidateStage: "other",
          change: "",
        },
      },
    ),
    "SAME_OCCURRENCE",
  );
  const mine = "自然资源部公布加达锂矿新增氧化锂资源量";
  assert.equal(
    validatedRelation(
      reprint({ originalText: catalogA, frame: { subject: "自然资源部", object: "矿产资源目录" } }),
      reprint({ originalText: mine, frame: { subject: "自然资源部", object: "加达锂矿" } }),
      {
        relation: "SAME_OCCURRENCE",
        confidence: 0.95,
        evidence: {
          queryQuote: catalogA,
          candidateQuote: mine,
          anchor: "自然资源部",
          queryAction: "公布",
          candidateAction: "公布",
          queryStage: "other",
          candidateStage: "other",
          change: "",
        },
      },
    ),
    "UNRELATED",
    "a different project does not join the policy",
  );
  assert.equal(
    validatedRelation(
      reprint({ originalText: catalogA, jurisdiction: null, frame: { subject: "安徽省自然资源厅", object: "矿产资源目录" } }),
      reprint({ originalText: catalogB, jurisdiction: null, frame: { subject: "中国地质调查局", object: "《矿产资源目录》" } }),
      catalog,
    ),
    "SAME_OCCURRENCE",
    "reprints of one policy with no jurisdiction stay one occurrence",
  );
  assert.equal(
    validatedRelation(
      reprint({ originalText: speechA, jurisdiction: "CN", frame: { subject: "习近平", object: "中非矿业合作4点主张" } }),
      reprint({ originalText: speechB, jurisdiction: null, frame: { subject: "省自然资源厅", object: "中非矿业合作4点主张" } }),
      {
        relation: "SAME_OCCURRENCE",
        confidence: 0.95,
        evidence: {
          queryQuote: speechA,
          candidateQuote: speechB,
          anchor: "中非矿业合作",
          queryAction: "提出",
          candidateAction: "提出",
          queryStage: "other",
          candidateStage: "other",
          change: "",
        },
      },
    ),
    "SAME_OCCURRENCE",
    "a speech reprint without a jurisdiction joins the official report",
  );
  assert.equal(
    validatedRelation(
      reprint({ originalText: catalogA, jurisdiction: null, frame: { subject: "自然资源部", object: "矿产资源目录" } }),
      reprint({ originalText: mine, jurisdiction: null, frame: { subject: "自然资源部", object: "加达锂矿" } }),
      {
        relation: "SAME_OCCURRENCE",
        confidence: 0.95,
        evidence: {
          queryQuote: catalogA,
          candidateQuote: mine,
          anchor: "自然资源部",
          queryAction: "公布",
          candidateAction: "公布",
          queryStage: "other",
          candidateStage: "other",
          change: "",
        },
      },
    ),
    "UNRELATED",
    "a different project stays apart even when neither report has a jurisdiction",
  );
  assert.equal(validatedRelation(reprint({ originalText: catalogA }), reprint({ originalText: catalogB, jurisdiction: "CL" }), catalog), "UNRELATED");
  assert.equal(
    validatedRelation(
      reprint({ originalText: catalogA, jurisdiction: "CN", frame: { subject: "自然资源部", action: "公布", object: "矿产资源目录" } }),
      reprint({ originalText: catalogB, jurisdiction: "CN-AH", frame: { subject: "安徽省自然资源厅", action: "印发", object: "《矿产资源目录》" } }),
      { ...catalog, evidence: { ...catalog.evidence, queryAction: "公布", candidateAction: "印发" } },
    ),
    "SAME_OCCURRENCE",
    "a province and the country are one country, and 印发 is the same announcement",
  );
  assert.equal(
    validatedRelation(reprint({ originalText: catalogA, jurisdiction: "CN" }), reprint({ originalText: catalogB, jurisdiction: "中国" }), catalog),
    "SAME_OCCURRENCE",
    "中国 and CN name the same country",
  );
  assert.equal(
    validatedRelation(reprint({ originalText: catalogA }), reprint({ originalText: catalogB }), {
      ...catalog,
      evidence: { ...catalog.evidence, queryStage: "approved", candidateStage: "proposed" },
    }),
    "UNRELATED",
    "proposed and approved stay apart",
  );
  assert.equal(
    validatedRelation(reprint({ originalText: catalogA }), reprint({ originalText: catalogB }), {
      ...catalog,
      evidence: { ...catalog.evidence, queryStage: "stopped", candidateStage: "resumed" },
    }),
    "UNRELATED",
    "stopped and resumed stay apart",
  );
  assert.equal(
    validatedRelation(
      reprint({ originalText: "原文只写了已经批准，没有停产。", frame: { object: "矿产资源目录" } }),
      reprint({ originalText: "原文只写了尚在拟议，没有复产。", frame: { object: "矿产资源目录" } }),
      {
        ...catalog,
        evidence: {
          ...catalog.evidence,
          queryQuote: "已经批准",
          candidateQuote: "尚在拟议",
          queryStage: "other",
          candidateStage: "other",
        },
      },
    ),
    "UNRELATED",
    "opposite stages written in the originals stay apart even when the model marks both as other",
  );
  assert.equal(
    validatedRelation(reprint({ originalText: catalogA }), reprint({ originalText: catalogB }), {
      ...catalog,
      evidence: { ...catalog.evidence, queryQuote: "这是一句不在原文里的编造引文" },
    }),
    "SAME_OCCURRENCE",
    "a non-verbatim paraphrase of the same document still joins",
  );
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
