import { stub } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { config } from "@amp/backend/config";
import { getBoss, stopBoss, recordRun } from "@amp/backend/jobs/queue";
import { capturePolicyMaterial } from "../packages/backend/src/policy/capture.ts";
import { readPolicyWorkflow, advancePolicyMaterial, discoverPolicyWorkflows, type PolicyAutomationPorts } from "../packages/backend/src/policy/automation.ts";
import { loadPolicyInterpretation } from "../packages/backend/src/policy/interpretation-runtime.ts";
import { registerPolicyJobs, sweepPolicyMaterials } from "../packages/backend/src/jobs/policy.ts";
import { fixture } from "./policy-automation-fixture.ts";
import { answer } from "./policy-automation-provider.ts";
const sql = dbOf("policy"),
  requests: unknown[] = [];
const provider = await stub(async (_hit, req) => {
  const input = JSON.parse(JSON.parse(req.body).messages.at(-1).content);
  requests.push(input);
  return {
    id: `synthetic-${requests.length}`,
    model: "synthetic-model",
    choices: [{ message: { content: JSON.stringify(answer(input)) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 50, completion_tokens: 20 },
  };
});
Object.assign(process.env, {
  LLM_BASE_URL: `${provider.url}/v1`,
  LLM_API_KEY: "synthetic-only",
  LLM_MODEL: "synthetic-model",
  COLLECT_ENABLED: "true",
  COLLECT_POLICY_ENABLED: "true",
});
config.modelCallsEnabled = true;
after(async () => {
  await stopBoss();
  await provider.close();
  await closeDb();
});
const published: { expressionId: string; fulltextRunId?: string }[] = [];
const publish: PolicyAutomationPorts["publish"] = async (input) => {
  published.push(input);
  if (input.fulltextRunId) assert.equal((await loadPolicyInterpretation(input.fulltextRunId))?.status, "semantic_verified");
  return { status: "published", mode: "basic_facts", pending: "quality", policyId: "synthetic-id", editionId: "synthetic-edition" };
};
const root = new AbortController().signal;

test("pg-boss lane jobs progress acquired HTML through actual fulltext receipts and verified interpretation before calling publication", async () => {
  const f = await fixture();
  f.setText("Published Regulation: Mining threshold at 10 kg.");
  const ports = { publish, capture: (sourceId: string, materialId: string) => capturePolicyMaterial(sourceId, materialId, f.get) };
  const boss = await getBoss();
  await registerPolicyJobs(boss, ports);
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await recordRun("policy.pipeline.sweep", sweepPolicyMaterials);
    const row = await readPolicyWorkflow(f.sourceId, f.materialId);
    if (row?.status === "semantic_verified") break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const final = await readPolicyWorkflow(f.sourceId, f.materialId);
  assert.equal(final?.status, "semantic_verified");
  assert.equal(final.reason, "quality");
  assert.ok(final.fulltext_run_id);
  assert.ok(published.some((input) => input.fulltextRunId === final.fulltext_run_id));
  assert.ok(requests.length >= 4);
  const rows = await sql`SELECT job,detail FROM job_runs WHERE job LIKE 'policy.pipeline.%' AND status='ok'`;
  assert.ok(rows.some((row) => row.job === "policy.pipeline.fulltext"));
  assert.ok(rows.some((row) => row.job === "policy.pipeline.interpret" && row.detail.status === "partial"));
  assert.equal((await sql`SELECT processing_state FROM articles WHERE id=${f.materialId}`)[0].processing_state, "new");
  await boss.offWork("policy.acquire");
  await boss.offWork("policy.fulltext");
  await boss.offWork("policy.vision");
  await boss.offWork("policy.interpret");
  await boss.offWork("policy.publish");
  const before = requests.length;
  await advancePolicyMaterial({ lane: "policy", sourceId: f.sourceId, materialId: f.materialId }, "acquire", ports, { root, collectionEnabled: true });
  assert.equal(requests.length, before, "periodic unchanged recheck only republishes trusted saved output");
});

test("unknown paid outcomes stay blocked across unchanged reacquisition, while a changed original starts from its current revision", async () => {
  const f = await fixture(),
    job = { lane: "policy" as const, sourceId: f.sourceId, materialId: f.materialId };
  await discoverPolicyWorkflows();
  let attempts = 0;
  const ports: PolicyAutomationPorts = {
    publish,
    capture: (sourceId, materialId) => capturePolicyMaterial(sourceId, materialId, f.get),
    fulltext: async () => {
      attempts++;
      return { status: "blocked_unknown", runId: "synthetic-run", requestsAttempted: 1, semantic_verified: false, runtime_authorization: "none" };
    },
  };
  await advancePolicyMaterial(job, "acquire", ports, { root, collectionEnabled: true });
  await advancePolicyMaterial(job, "fulltext", ports, { root, collectionEnabled: true });
  await advancePolicyMaterial(job, "acquire", ports, { root, collectionEnabled: true });
  assert.equal(attempts, 1);
  assert.equal((await readPolicyWorkflow(f.sourceId, f.materialId))?.status, "blocked_unknown");
  f.setText("Changed original 11 kg.");
  await advancePolicyMaterial(job, "acquire", ports, { root, collectionEnabled: true });
  assert.equal((await readPolicyWorkflow(f.sourceId, f.materialId))?.stage, "fulltext");
  assert.equal((await readPolicyWorkflow(f.sourceId, f.materialId))?.status, "pending");
});

test("vision partial resumes independently, extracted returns to fulltext and remaining catalogue gaps stop the loop", async () => {
  const f = await fixture(),
    job = { lane: "policy" as const, sourceId: f.sourceId, materialId: f.materialId };
  await discoverPolicyWorkflows();
  let visionCalls = 0;
  const ports: PolicyAutomationPorts = {
    publish,
    capture: (sourceId, materialId) => capturePolicyMaterial(sourceId, materialId, f.get),
    fulltext: async () => ({ status: "incomplete", revisionId: "synthetic", gaps: ["catalogue"], requests: [] }),
    vision: async () => ({ status: ++visionCalls === 1 ? "partial" : "extracted" }),
  };
  for (const stage of ["acquire", "fulltext", "vision", "vision", "fulltext"] as const)
    await advancePolicyMaterial(job, stage, ports, { root, collectionEnabled: true });
  assert.equal(visionCalls, 2);
  assert.equal((await readPolicyWorkflow(f.sourceId, f.materialId))?.status, "incomplete");
  await advancePolicyMaterial(job, "acquire", ports, { root, collectionEnabled: true });
  assert.equal(visionCalls, 2);
});
