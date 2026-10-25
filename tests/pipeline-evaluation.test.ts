import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDb, sql } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { installSelectionDataset } from "@amp/backend/admin/selectbench";
import { boundEvaluationFixture } from "./bound-eval-fixture.ts";
import { installUsageFixtureForModel } from "./usage-protection-fixture.ts";
import { config } from "@amp/backend/config";
import { evaluatePipeline } from "../scripts/eval-pipeline.ts";
import { comparePipelineReports, type PipelineReport } from "../scripts/eval-pipeline-core.ts";

const directory = mkdtempSync(path.join(tmpdir(), "pipeline-evaluation-"));
let pauseOnNext = false;
const provider = await stub(async (_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: string }> };
  const system = String(body.messages.find((m) => m.role === "system")?.content ?? "");
  if (pauseOnNext) {
    pauseOnNext = false;
    await sql`UPDATE ops.lane_controls SET paused=true,reason='合成运行中暂停',actor='test',expires_at=now()+interval '1 hour',revision=revision+1 WHERE lane='news' AND switch='processing' AND holder='owner'`;
  }
  let answer: unknown;
  if (system.includes("attentionScore")) answer = { attentionScore: 80 };
  else if (system.includes("PASS") && system.includes("BLOCK")) answer = { label: "PASS", reason: "合成材料属于矿业" };
  else if (system.includes("company_context"))
    answer = {
      scope: "single",
      category: "company_project",
      tags: [],
      subjects: [],
      fact: null,
      geography: {
        status: "identified",
        primary: "AR",
        assignments: [{ code: "AR", role: "event_location", mention: "Argentina", segment: "body_head", quote: "A mine in Argentina began construction." }],
        reason: "合成原文明确项目所在地",
      },
    };
  else
    answer = {
      itemType: "policy_regulation",
      authorRole: "principal",
      tags: [],
      editorialJudgment: "合成项目建设进展",
      titleZh: "合成矿业项目开工",
      summaryZh: "项目在阿根廷开工建设。",
    };
  return { choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 50, completion_tokens: 15 } };
});
for (const variable of ["PREFILTER_MODEL", "SCORE_MODEL", "STRUCTURE_MODEL", "UNDERSTAND_MODEL", "SUMMARIZE_MODEL", "WORDING_MODEL"])
  process.env[variable] = "deepseek-flash";
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
config.modelCallsEnabled = true;
await installUsageFixtureForModel("deepseek-flash");
after(async () => {
  await provider.close();
  await closeDb();
  rmSync(directory, { recursive: true, force: true });
});

async function dataset(body: string | null, count = 1, pending = false) {
  const id = `pipeline-${tag()}`;
  const fixture = await boundEvaluationFixture({
    title: `Synthetic mine ${id}`,
    body,
    source: id,
    tier: "T1",
    kind: "rss",
    firstParty: true,
    publishedAt: "2026-10-20T00:00:00Z",
  });
  const revision = pending
    ? (
        await upsertMaterial({
          sourceId: fixture.analysisInput.sourceId!,
          url: fixture.analysisInput.url,
          title: fixture.analysisInput.title,
          bodyText: null,
          excerpt: "A short feed summary awaiting its original page.",
          bodyStatus: "pending",
          language: "en",
          via: "fetch",
        })
      ).revision
    : fixture.analysisInput.revision;
  if (pending) await sql`UPDATE articles SET body_status='pending' WHERE id=${fixture.analysisInput.id}`;
  await installSelectionDataset({
    id,
    label: "Synthetic pipeline",
    synthetic: true,
    samples: Array.from({ length: count }, (_, i) => ({
      caseId: `case-${i + 1}`,
      materialId: fixture.analysisInput.id,
      materialRevision: revision,
      split: "development",
      stratum: "synthetic",
    })),
  });
  return { id, articleId: fixture.analysisInput.id };
}

test("unlabelled cases use real analysis steps, preserve business rows, reuse receipts and compare the same inputs", async () => {
  const f = await dataset("A mine in Argentina began construction. ".repeat(8));
  const before =
    await sql`SELECT (SELECT count(*) FROM analyses WHERE article_id=${f.articleId})::int AS analyses,(SELECT count(*) FROM publications WHERE article_id=${f.articleId})::int AS publications`;
  const firstPath = path.join(directory, "first.json");
  const first = await evaluatePipeline({ dataset: f.id, output: firstPath });
  assert.equal(first.executionComplete, true);
  assert.equal(first.configurationSnapshotsMatch, true);
  assert.equal(first.cases[0]!.error, null);
  assert.equal(first.cases[0]!.reference, null);
  assert.equal(first.cases[0]!.decision, "select");
  assert.deepEqual(first.cases[0]!.jurisdictions, ["AR"]);
  assert.ok(first.cases[0]!.receiptIds.length >= 4);
  assert.equal(JSON.parse(readFileSync(firstPath, "utf8")).quality.falseNegatives, null);
  const hits = provider.hits();
  const second = await evaluatePipeline({ dataset: f.id, output: path.join(directory, "second.json"), baseline: firstPath });
  assert.equal(provider.hits(), hits, "the evaluator does not buy fresh calls just to warm a cache");
  assert.equal(second.cases[0]!.reused, true);
  assert.deepEqual(second.comparison!.changes, []);
  assert.deepEqual(
    await sql`SELECT (SELECT count(*) FROM analyses WHERE article_id=${f.articleId})::int AS analyses,(SELECT count(*) FROM publications WHERE article_id=${f.articleId})::int AS publications`,
    before,
  );
  await assert.rejects(evaluatePipeline({ dataset: f.id, output: firstPath }), /EEXIST/);
  assert.equal(provider.hits(), hits);
  const bad = structuredClone(first);
  bad.cases[0]!.inputHash = "a".repeat(64);
  const badPath = path.join(directory, "bad.json");
  writeFileSync(badPath, JSON.stringify(bad));
  await assert.rejects(evaluatePipeline({ dataset: f.id, output: path.join(directory, "reject.json"), baseline: badPath }), /不一致/);
  assert.equal(provider.hits(), hits, "baseline validation occurs before any paid work");
  const changed: PipelineReport = structuredClone(first);
  const unknown: PipelineReport = structuredClone(first);
  unknown.cases[0]!.jurisdictions = null;
  assert.equal(comparePipelineReports(first, unknown).changes.length, 1, "lost evidence must not disappear from the difference report");
  assert.equal(comparePipelineReports(unknown, first).changes.length, 1, "recovered evidence must not disappear from the difference report");
  changed.cases[0]!.decision = "reject";
  changed.cases[0]!.jurisdictions = ["CL"];
  const diff = comparePipelineReports(first, changed);
  assert.deepEqual(
    diff.changes.map((c) => [c.removedCandidate, c.jurisdictionsBefore, c.jurisdictionsAfter]),
    [[true, ["AR"], ["CL"]]],
  );
  changed.cases[0]!.error = "waiting_material";
  changed.cases[0]!.decision = null;
  assert.deepEqual(comparePipelineReports(first, changed).incomparable, ["case-1"]);
});

test("missing material and manual pauses cannot become correct rejections or model requests", async () => {
  const f = await dataset(null),
    hits = provider.hits();
  const report = await evaluatePipeline({ dataset: f.id, output: path.join(directory, "empty.json") });
  assert.equal(provider.hits(), hits);
  assert.equal(report.cases[0]!.decision, null);
  assert.equal(report.cases[0]!.error, "waiting_material");
  assert.deepEqual(report.cases[0]!.receiptIds, []);
  await sql`UPDATE ops.lane_controls SET paused=true,reason='合成暂停',actor='test',expires_at=now()+interval '1 hour',revision=revision+1 WHERE lane='news' AND switch='processing' AND holder='owner'`;
  try {
    await assert.rejects(evaluatePipeline({ dataset: f.id, output: path.join(directory, "paused.json") }), /暂停/);
  } finally {
    await sql`UPDATE ops.lane_controls SET paused=false,reason=NULL,actor=NULL,expires_at=NULL,revision=revision+1 WHERE lane='news' AND switch='processing' AND holder='owner'`;
  }
  assert.equal(provider.hits(), hits);
});

test("a pending original page is not judged from its feed summary", async () => {
  const f = await dataset(null, 1, true),
    hits = provider.hits();
  const report = await evaluatePipeline({ dataset: f.id, output: path.join(directory, "pending-body.json") });
  assert.equal(provider.hits(), hits);
  assert.equal(report.cases[0]!.error, "waiting_body");
  assert.equal(report.cases[0]!.decision, null);
});

test("a pause during a response keeps a partial report and stops later cases", async () => {
  const f = await dataset("A mine in Argentina began construction. New synthetic response.", 2);
  const hits = provider.hits();
  pauseOnNext = true;
  try {
    const out = path.join(directory, "interrupted.json");
    const report = await evaluatePipeline({ dataset: f.id, output: out });
    assert.equal(report.executionComplete, false);
    assert.equal(report.stopReason, "processing_control_changed");
    assert.equal(provider.hits(), hits + 1);
    assert.equal(report.cases[0]!.decision, null);
    assert.ok(report.cases[0]!.error);
    assert.equal(report.cases[1]!.error, "not_run");
    assert.equal(JSON.parse(readFileSync(out, "utf8")).executionComplete, false);
  } finally {
    pauseOnNext = false;
    await sql`UPDATE ops.lane_controls SET paused=false,reason=NULL,actor=NULL,expires_at=NULL,revision=revision+1 WHERE lane='news' AND switch='processing' AND holder='owner'`;
  }
});
