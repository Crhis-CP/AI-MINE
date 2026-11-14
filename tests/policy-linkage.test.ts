import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { sha256 } from "@amp/backend/lib/ids";
import { CandidateReply, groundImpactDeadlines } from "../modules/policy/backend/domain/interpretation-schema.ts";
import { normalizeSourceTime } from "@amp/contracts/time-assertion";
import { alignPolicyEvidence, auditPolicyLinkage } from "../modules/policy/backend/domain/linkage.ts";
import { buildPolicyFulltextPlan, type PolicyFulltextPlan } from "../modules/policy/backend/domain/processing-plan.ts";
import { readingBlock } from "../modules/policy/backend/publication/policies-project.ts";
import { interpretReply } from "./policy-automation-provider.ts";

function fixture(language: string, texts: string[]) {
  const url = "https://source.invalid/synthetic-law";
  const built = buildPolicyFulltextPlan(
    {
      revisionId: sha256("revision"),
      state: "extracted",
      gaps: [],
      resources: [
        {
          url,
          sha256: sha256(texts.join("\n")),
          state: "extracted",
          gaps: [],
          nodes: texts.map((text, ordinal) => ({ id: `node-${ordinal}`, ordinal, text })),
        },
      ],
    },
    { sourceId: "synthetic-law", expressionId: "expression", language, identityHash: sha256("identity"), recipeVersion: "synthetic" },
  );
  assert.equal(built.status, "planned");
  const plan = built as PolicyFulltextPlan;
  assert.equal(plan.parts.length, texts.length);
  const reply = interpretReply({
    mode: "first_version",
    provisions: [{ label: null, change: "added", parts: [{ ref: plan.parts[0]!.partId, text: texts[0] }] }],
  });
  const candidate = CandidateReply.parse({
    ...reply,
    id: sha256("candidate"),
    input_hash: sha256("input"),
    input_ids: [plan.manifestHash],
    document_title: "Synthetic Mining Regulation",
    instrument_number: "fixture-1",
    comparisons: [],
  });
  return { plan, candidate };
}

test("Chinese and Spanish evidence rebinds to its unique actual paragraph, shared by claims and reading anchors", () => {
  for (const [language, texts, quote] of [
    ["zh-CN", ["第一条 矿山须保存检查记录。", "第二条 运输另有规定。"], "矿山须保存检查记录"],
    [
      "es",
      ["Artículo 1. Las minas conservarán los registros de inspección.", "Artículo 2. Se regula el transporte."],
      "Las minas conservarán los registros de inspección",
    ],
  ] as const) {
    const { plan, candidate } = fixture(language, [...texts]);
    candidate.evidence[0]!.quote = quote;
    candidate.evidence[0]!.part_id = plan.parts[1]!.partId;
    const before = structuredClone(candidate);
    const aligned = alignPolicyEvidence(candidate, plan.parts);
    assert.deepEqual(candidate, before, "the private verified candidate remains unchanged");
    assert.equal(aligned.candidate.evidence[0]!.part_id, plan.parts[0]!.partId);
    assert.equal(aligned.candidate.main_points.length, 1);
    assert.equal(aligned.candidate.impacts.length, 1);
    const blocks = plan.parts.map((p) =>
      readingBlock(
        p.partId,
        p.source,
        p.format,
        p.resourceUrl,
        aligned.candidate.evidence.filter((e) => e.part_id === p.partId).map((e) => e.id),
      ),
    );
    for (const item of [...aligned.candidate.main_points, ...aligned.candidate.impacts]) {
      assert.ok(item.evidence_ids.every((id) => blocks[0]!.evidence_ids.includes(id)));
      assert.ok(item.evidence_ids.every((id) => !blocks[1]!.evidence_ids.includes(id)));
    }
    assert.equal(aligned.linked, aligned.total);
  }
});

test("missing or ambiguous quotes hide only their own claims, including mixed references", () => {
  const { plan, candidate } = fixture("zh-CN", ["第一条 保存矿山记录。共同文字。", "第二条 运输规定。共同文字。"]);
  const good = { ...candidate.evidence[0]!, quote: "保存矿山记录", part_id: plan.parts[0]!.partId };
  candidate.evidence = [
    good,
    { id: "missing", part_id: plan.parts[0]!.partId, quote: "原文没有这句话" },
    { id: "ambiguous", part_id: "unknown-part", quote: "共同文字" },
  ];
  const point = candidate.main_points[0]!,
    impact = candidate.impacts[0]!;
  candidate.main_points = [
    point,
    { ...point, text: "混合的未获支持要点", evidence_ids: [good.id, "missing"] },
    { ...point, text: "不能猜落点", evidence_ids: ["ambiguous"] },
  ];
  candidate.impacts = [impact, { ...impact, id: "missing-impact", evidence_ids: ["missing"] }];
  const aligned = alignPolicyEvidence(candidate, plan.parts);
  assert.deepEqual(aligned.candidate.main_points, [point]);
  assert.deepEqual(aligned.candidate.impacts, [impact]);
  assert.equal(aligned.total, 5);
  assert.equal(aligned.linked, 2);
  assert.deepEqual(aligned.omitted, ["main_points.1", "main_points.2", "impacts.1"]);
});

test("metadata annotations do not stand in for a body paragraph or erase other legal facts", () => {
  const { plan, candidate } = fixture("zh-CN", ["第一条 保存矿山记录。"]);
  candidate.evidence[0]!.quote = "原文没有的元数据";
  candidate.evidence[0]!.annotation_id = "metadata";
  const aligned = alignPolicyEvidence(candidate, plan.parts);
  assert.equal(aligned.linked, 0);
  assert.deepEqual(aligned.candidate.main_points, []);
  assert.deepEqual(aligned.candidate.impacts, []);
  assert.deepEqual(aligned.candidate.legal_state, candidate.legal_state);
});

test("an unquoted or altered deadline becomes null while the impact and a proved deadline survive", () => {
  const { plan, candidate } = fixture("en", ["Article 1. Keep mine records by 2026-11-13."]);
  const date = normalizeSourceTime(
    {
      meaning: "deadline",
      raw: "2026-11-13",
      local_date: "2026-11-13",
      local_time: null,
      timezone: null,
      utc: null,
      precision: "date",
      basis: "原文",
      condition_text: null,
    },
    { instantBasis: null, timezoneEvidence: null },
  );
  const impact = candidate.impacts[0]!;
  candidate.impacts = [
    { ...impact, deadline: date },
    { ...impact, id: "altered", deadline: { ...date, local_date: "2027-11-13" } },
    { ...impact, id: "unquoted", deadline: { ...date, raw: "2027-11-13", local_date: "2027-11-13" } },
  ];
  const grounded = groundImpactDeadlines(candidate, plan, 1);
  assert.equal(grounded.impacts.length, 3);
  assert.deepEqual(grounded.impacts[0]!.deadline, date);
  assert.equal(grounded.impacts[1]!.deadline, null);
  assert.equal(grounded.impacts[2]!.deadline, null);
  assert.notEqual(candidate.impacts[1]!.deadline, null, "preserve the original candidate for audit");
});

test("audit counts actual original anchors and leaves absent completeness and private rejection evidence unknown", () => {
  const { candidate } = fixture("zh-CN", ["第一条 保存矿山记录。"]);
  const value = { id: "synthetic", main_points: candidate.main_points, impacts: candidate.impacts, sections: [], reading: null };
  const report = auditPolicyLinkage(value, []);
  assert.equal(report.ratio, 0);
  assert.equal(report.public_reading_completeness, "unknown");
  assert.equal(report.source_acquisition_kind, null);
  assert.equal(report.blocked_claims, null);
  assert.equal(auditPolicyLinkage({ ...value, main_points: [], impacts: [] }, []).ratio, null);
});

test("audit rejects an apply argument before opening a database", () => {
  const result = spawnSync(process.execPath, ["scripts/policy-linkage-audit.ts", "--apply"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /read-only audit accepts no apply or repair arguments/);
});
