import "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import {
  selectionTool,
  changeSelectionTool,
  selectionStandards,
  installSelectionDataset,
  selectionSamples,
  labelSelectionSample,
  exportSelectionGold,
  submitSelectionStandard,
  reviewSelectionStandard,
  importSelectBenchRun,
  recordSelectionEvaluation,
  selectionRunEvidence,
  confirmSelectionHoldout,
  readApprovedSelectionCalibration,
} from "@amp/backend/admin/selectbench";
import type { AdminPrincipal } from "@amp/backend/admin/auth";
import { selectionStandardSnapshot, type ModelIdentityPort } from "../packages/backend/src/admin/selectbench-runtime.ts";
const sql = dbOf("ai-gateway"),
  hash = "a".repeat(64),
  model = "synthetic-score";
const modelPort: ModelIdentityPort = async () => ({ key: model, service: "synthetic", requestedModel: model, configuration_hash: hash });
after(closeDb);
async function principal(name: string, role: "owner" | "admin", manage = false): Promise<AdminPrincipal> {
  const [u] = await sql`INSERT INTO admin_users(email,display_name) VALUES(${`${name}@synthetic.test`},${name}) RETURNING id`;
  await sql`INSERT INTO identity.account_access(user_id,role,models_manage,must_change_password) VALUES(${u!.id},${role},${manage},false)`;
  return { userId: Number(u!.id), accessRevision: 1, name, csrf: "synthetic-csrf", dev: false } as AdminPrincipal;
}
const owner = await principal("Synthetic Owner", "owner"),
  manager = await principal("Delegated model manager", "admin", true);
async function open() {
  const state = await selectionTool(owner);
  return changeSelectionTool(
    {
      requestId: randomUUID(),
      expectedRevision: state.revision,
      enabled: true,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      reason: "Synthetic local test only",
    },
    owner,
  );
}
let serial = 0;
async function dataset(count = 2, synthetic = true) {
  const id = `dataset-${++serial}`,
    sourceId = `source-${id}`;
  await sql`INSERT INTO sources(id,name,kind,tier,config) VALUES(${sourceId},'HiddenSourceName-DO-NOT-EXPOSE','rss','T1','{}'::jsonb)`;
  const samples = [];
  for (let i = 0; i < count; i++) {
    const material = await upsertMaterial({
      sourceId,
      url: `https://fixture.invalid/${id}/${i}`,
      title: `合成矿业材料${i}`,
      bodyText: `合成完整正文${i}。项目取得许可并开始建设。`,
      bodyStatus: "ok",
      publishedAt: new Date("2026-01-01T12:00:00Z"),
      via: "fetch",
    });
    samples.push({
      caseId: `c${String(i).padStart(3, "0")}`,
      materialId: material.articleId,
      materialRevision: material.revision,
      split: i < count / 2 ? ("development" as const) : ("holdout" as const),
      stratum: i % 2 ? "新规" : "项目里程碑",
    });
  }
  await installSelectionDataset({ id, label: "Explicit synthetic local evidence", synthetic, samples });
  return { id, samples, sourceId };
}
function labelInput(extra: Record<string, unknown> = {}) {
  return { requestId: randomUUID(), sampleRevision: 1, expectedRevision: 0, decision: "select", note: "仅隔离合成用例", ...extra };
}

test("default closed; delegated models permission, dev stand-in and revoked access never become Owner", async () => {
  assert.equal((await selectionTool(owner)).enabled, false);
  await assert.rejects(selectionTool(manager), /权限/);
  await assert.rejects(selectionTool({ ...owner, dev: true }), /权限/);
  await assert.rejects(selectionSamples(owner), /未开启/);
  const status = await selectionStandards(owner, modelPort);
  assert.equal(status.reviewStatus, "draft");
  assert.equal(status.checks.ownerHoldout, false);
  assert.equal(status.current.configuredForCurrent, false);
  await sql`UPDATE identity.account_access SET revision=revision+1 WHERE user_id=${owner.userId!}`;
  await assert.rejects(selectionTool(owner), /权限/);
  owner.accessRevision = 2;
});

test("Owner labels only scorer input; request replay is idempotent, concurrent and stale-material writes fail without losing prior labels", async () => {
  await open();
  const f = await dataset(),
    view = await selectionSamples(owner, f.id);
  const wire = JSON.stringify(view);
  assert.ok(!wire.includes("HiddenSourceName"));
  assert.ok(!wire.includes('"tier"'));
  assert.ok(!wire.includes('"score"'));
  assert.equal(view.samples[0]!.label, null);
  assert.match(view.samples[0]!.scorerInput, /完整正文/);
  const input = labelInput(),
    a = f.samples[0]!;
  const first = await labelSelectionSample(f.id, a.caseId, input, owner),
    replay = await labelSelectionSample(f.id, a.caseId, input, owner);
  assert.deepEqual(first, replay);
  assert.equal(first.revision, 1);
  await assert.rejects(labelSelectionSample(f.id, a.caseId, { ...input, decision: "reject" }, owner), /操作编号/);
  const races = await Promise.allSettled([
    labelSelectionSample(f.id, a.caseId, labelInput({ expectedRevision: 1, decision: "either" }), owner),
    labelSelectionSample(f.id, a.caseId, labelInput({ expectedRevision: 1, decision: "reject" }), owner),
  ]);
  assert.equal(races.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(races.filter((r) => r.status === "rejected").length, 1);
  const b = f.samples[1]!;
  await upsertMaterial({
    sourceId: f.sourceId,
    url: `https://fixture.invalid/${f.id}/1`,
    title: "合成原材料已更新",
    bodyText: "新的原文",
    bodyStatus: "ok",
    via: "fetch",
  });
  await assert.rejects(labelSelectionSample(f.id, b.caseId, labelInput(), owner), /原材料已有更新/);
  assert.equal((await selectionSamples(owner, f.id)).samples.find((s) => s.caseId === b.caseId)!.materialCurrent, false);
  await sql`UPDATE ai.selection_tool_control SET expires_at=now()-interval '1 second' WHERE id=true`;
  assert.equal((await selectionTool(owner)).enabled, false);
  await assert.rejects(labelSelectionSample(f.id, a.caseId, labelInput({ expectedRevision: 2 }), owner), /到期/);
});

test("standard reviews are append-only, version-bound and synthetic reviews cannot become real approval", async () => {
  await open();
  const current = selectionStandardSnapshot(),
    submission = await submitSelectionStandard({
      materialReference: "Synthetic comparison document",
      changeNote: "No production rule change",
      synthetic: true,
    });
  const input = {
    requestId: randomUUID(),
    submissionId: submission.id,
    standardVersion: current.standardVersion,
    contentHash: current.contentHash,
    readComparison: true,
    decision: "approved",
    note: "Synthetic demonstration",
  };
  const saved = await reviewSelectionStandard(input, owner);
  assert.equal(saved.synthetic, true);
  assert.equal((await reviewSelectionStandard(input, owner)).id, saved.id);
  assert.equal((await selectionStandards(owner, modelPort)).checks.ownerStandardReview, false);
  await assert.rejects(reviewSelectionStandard({ ...input, requestId: randomUUID(), contentHash: "b".repeat(64) }, owner), /版本已变化/);
  const next = await reviewSelectionStandard({ ...input, requestId: randomUUID(), decision: "changes_requested", note: "Synthetic change note" }, owner);
  assert.notEqual(next.id, saved.id);
  assert.equal((await sql`SELECT count(*)::int n FROM ai.selection_records WHERE kind='standard_review'`)[0].n, 2);
});

test("legacy uploaded summaries and caller-supplied metadata never count as trusted calibration", async () => {
  const run = await importSelectBenchRun(
    {
      meta: { split: "holdout", n: 1, datasetVersion: hash, modelConfigurations: { [model]: hash } },
      models: {
        model_configurations: { summary: { [model]: hash } },
        [model]: { summary: { n: 1, accuracy: 1 }, cases: [{ caseId: "legacy", title: "Synthetic legacy", gold: "select", decision: "select", score: 90 }] },
      },
    },
    "Synthetic legacy",
    "fixture",
  );
  assert.equal((await sql`SELECT summary FROM selectbench_runs WHERE id=${run.id}`)[0].summary.model_configurations, undefined);
  const evidence = await selectionRunEvidence(run.id, owner, undefined, modelPort);
  assert.equal(evidence.origin, "legacy_or_upload");
  assert.equal(evidence.models[0]!.confirmable, false);
  await assert.rejects(
    confirmSelectionHoldout({ requestId: randomUUID(), runId: run.id, model, evidenceHash: evidence.models[0]!.evidenceHash, note: "" }, owner, modelPort),
    /证据尚不齐全/,
  );
});

test("matched 100-case development/holdout manifest, two completed score receipts, Owner standard and holdout confirmation remain distinct from deployment activation", async () => {
  await open();
  const f = await dataset(100, false);
  // All records are synthetic test artifacts in this isolated database, including this simulated Owner.
  for (const sample of f.samples) await labelSelectionSample(f.id, sample.caseId, labelInput({ decision: "select" }), owner);
  const exported = await exportSelectionGold(f.id),
    current = selectionStandardSnapshot();
  const selected = exported.rows.filter((r) => r.samplingContext.benchmarkSplit === "holdout"),
    proof = [],
    cases = [];
  for (const sample of selected) {
    const receipts = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const [receipt] =
        await sql`INSERT INTO receipts(logical_key,service,model,purpose,status,request,response) VALUES(${randomUUID()},'synthetic-provider',${model},'score_article','completed',${sql.json({ promptVersion: current.standardVersion, userHash: sample.inputHash, configuration_hash: hash })},'{}'::jsonb) RETURNING id`;
      receipts.push(Number(receipt!.id));
    }
    proof.push({
      caseId: sample.caseId,
      inputHash: sample.inputHash,
      sampleRevision: sample.sampleRevision,
      labelRevision: sample.labelRevision,
      receiptIds: receipts,
    });
    cases.push({ caseId: sample.caseId, title: "Synthetic evaluated sample", gold: "select", decision: "select", score: 80, relevance: "pass" });
  }
  const run = await importSelectBenchRun(
    {
      meta: { split: "holdout", n: 50, promptVersion: `${current.prefilterVersion}+${current.standardVersion}` },
      models: { [model]: { summary: { n: 50, accuracy: 1, precision: 1, recall: 1, fp: 0, fn: 0 }, cases } },
    },
    "Synthetic heldout run",
    "fixture",
  );
  await recordSelectionEvaluation(run.id, {
    datasetId: f.id,
    datasetVersion: exported.datasetVersion,
    synthetic: false,
    modelConfigurations: { [model]: hash },
    modelConfigurationAfter: { [model]: hash },
    cases: { [model]: proof },
  });
  assert.equal((await sql`SELECT summary FROM selectbench_runs WHERE id=${run.id}`)[0].summary.model_configurations[model], hash);
  const evidence = await selectionRunEvidence(run.id, owner, undefined, modelPort);
  assert.equal(evidence.models[0]!.confirmable, true, evidence.models[0]!.missing.join(";"));
  const confirm = {
    requestId: randomUUID(),
    runId: run.id,
    model,
    evidenceHash: evidence.models[0]!.evidenceHash,
    note: "Simulated local Owner confirmation, not production approval",
  };
  await assert.rejects(confirmSelectionHoldout(confirm, owner, modelPort), /真实Owner通过记录/);
  const submission = await submitSelectionStandard({
    materialReference: "Synthetic test-only comparison for positive behavior",
    changeNote: "No actual standard approval",
    synthetic: false,
  });
  await reviewSelectionStandard(
    {
      requestId: randomUUID(),
      submissionId: submission.id,
      standardVersion: current.standardVersion,
      contentHash: current.contentHash,
      readComparison: true,
      decision: "approved",
      note: "Isolated simulated Owner",
    },
    owner,
  );
  const saved = await confirmSelectionHoldout(confirm, owner, modelPort);
  assert.equal(saved.sampleCount, 50);
  assert.equal(saved.accuracy, 1);
  const status = await selectionStandards(owner, modelPort);
  assert.equal(status.checks.ownerHoldout, true);
  assert.equal(status.checks.ownerStandardReview, true);
  assert.equal(status.checks.ready, false);
  const approved = await readApprovedSelectionCalibration({ modelKey: model, configurationHash: hash }, undefined, modelPort);
  assert.equal(approved?.runId, run.id);
  assert.deepEqual(approved?.sourceIds, [f.sourceId]);
  const changedModel: ModelIdentityPort = async () => ({ key: model, service: "synthetic", requestedModel: model, configuration_hash: "b".repeat(64) });
  assert.equal((await selectionRunEvidence(run.id, owner, undefined, changedModel)).models[0]!.confirmable, false);
  const first = f.samples[0]!;
  await labelSelectionSample(f.id, first.caseId, labelInput({ expectedRevision: 1, decision: "either" }), owner);
  assert.equal((await selectionRunEvidence(run.id, owner, undefined, modelPort)).models[0]!.confirmable, false);
  assert.equal(await readApprovedSelectionCalibration({ modelKey: model, configurationHash: hash }, undefined, modelPort), null);
});
