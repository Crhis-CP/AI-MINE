import { POLICY_MODEL_BINDING_VERSION } from "../packages/backend/src/policy/model-evidence.ts";
import { policyInterpretationQualityRecipe } from "../packages/backend/src/policy/references.ts";
import { stub } from "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { config } from "@amp/backend/config";
import { getBoss, stopBoss, recordRun } from "@amp/backend/jobs/queue";
import { publishPolicyPublication } from "../packages/backend/src/publication/policies-publish.ts";
import { listPolicies, policyDetail, policyReading } from "../packages/backend/src/publication/policies.ts";
import { installPolicyQualityRelease } from "../packages/backend/src/policy/quality.ts";
import { sha256 } from "../packages/backend/src/lib/ids.ts";
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
  return publishPolicyPublication(input);
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
  const publicList = await listPolicies({ page: 1, page_size: 20 });
  const visible = publicList.items.find((item) => item.original_url === f.url);
  assert.equal(visible?.interpretation_state, "basic_facts", "synthetic execution does not grant real quality qualification");
  assert.equal(visible?.summary, null);
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
  const loaded = (await loadPolicyInterpretation(final.fulltext_run_id))!;
  const qualityInput = {
    sourceIds: [f.sourceId],
    languages: [loaded.run.snapshot.language],
    fulltextRecipe: loaded.run.plan.context.recipeVersion,
    interpretationRecipe: policyInterpretationQualityRecipe(loaded.recipeVersion),
    models: loaded.models,
    reviewedBy: "owner",
    reviewEvidence: "SYNTHETIC isolated test qualification only; no actual Owner quality approval",
    evaluationHash: sha256(`synthetic-only:${loaded.contentHash}`),
    reviewedAt: new Date(Date.now() - 1000).toISOString(),
    validUntil: new Date(Date.now() + 3600_000).toISOString(),
  };
  const qualityId = await installPolicyQualityRelease(qualityInput);
  await advancePolicyMaterial({ lane: "policy", sourceId: f.sourceId, materialId: f.materialId }, "acquire", ports, { root, collectionEnabled: true });
  const complete = await publishPolicyPublication({ expressionId: final.expression_id!, fulltextRunId: final.fulltext_run_id });
  assert.equal(complete.status, "published");
  if (complete.status !== "published") return;
  assert.equal(complete.mode, "complete");
  const detail = await policyDetail(complete.policyId, {});
  assert.equal(detail.interpretation_state, "complete");
  assert.ok(detail.guide);
  assert.ok(detail.impacts.length);
  assert.ok(detail.reading?.next_cursor);
  const reading = await policyReading(complete.policyId, {
    expression_id: detail.reading!.expression_id,
    document_revision_id: detail.reading!.document_revision_id,
    cursor: detail.reading!.next_cursor!,
    limit: 20,
  });
  assert.ok(reading.blocks.length);
  const retry = await publishPolicyPublication({ expressionId: final.expression_id! });
  assert.equal(retry.status, "published");
  assert.equal("editionId" in retry && retry.editionId, complete.editionId);
  assert.equal("mode" in retry && retry.mode, "complete");
  const [timeBefore] = await sql`SELECT released_at,discovered_at FROM publication.policy_editions WHERE id=${complete.editionId}`;
  // A pre-upgrade window has no physical binding. Reading and the metadata-preservation branch must downgrade it immediately.
  await sql`UPDATE publication.policy_quality_windows SET binding_version=NULL WHERE id=${qualityId}`;
  await sql`UPDATE policy.quality_releases SET models=ARRAY['synthetic-model'] WHERE id=${qualityId}`;
  assert.equal((await policyDetail(complete.policyId, {})).interpretation_state, "basic_facts");
  const legacyRetry = await publishPolicyPublication({ expressionId: final.expression_id! });
  assert.equal("mode" in legacyRetry && legacyRetry.mode, "basic_facts");
  const replacement = await installPolicyQualityRelease(qualityInput);
  const restored = await publishPolicyPublication({ expressionId: final.expression_id!, fulltextRunId: final.fulltext_run_id });
  assert.equal("mode" in restored && restored.mode, "complete");
  assert.equal((await policyDetail(complete.policyId, {})).interpretation_state, "complete");
  assert.equal(
    (await sql`SELECT binding_version FROM publication.policy_quality_windows WHERE id=${replacement}`)[0].binding_version,
    POLICY_MODEL_BINDING_VERSION,
  );
  assert.equal("editionId" in restored && restored.editionId, complete.editionId);
  assert.deepEqual((await sql`SELECT released_at,discovered_at FROM publication.policy_editions WHERE id=${complete.editionId}`)[0], timeBefore);
  assert.equal(requests.length, before, "quality recheck and reading must never call a model");
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

test("official landing-page metadata binds the linked PDF, and missing actual visual configuration stops without a text-model fallback", async () => {
  const f = await fixture(),
    job = { lane: "policy" as const, sourceId: f.sourceId, materialId: f.materialId };
  f.profile.originalLinkSelector = "a.original";
  await sql`UPDATE sources SET config=${sql.json({ policyProfile: f.profile })} WHERE id=${f.sourceId}`;
  const pdf = readFileSync("tests/fixtures/policy/text.pdf"),
    url = `${f.url}.pdf`;
  const get = async (address: string) => {
    if (address === url) return { status: 200, url, headers: new Headers({ "content-type": "application/pdf" }), body: pdf, text: () => "" };
    const response = await f.get(address);
    response.body = Buffer.from(response.body.toString().replace("</html>", `<a class="original" href="${url}">Original</a></html>`));
    return response;
  };
  const ports: PolicyAutomationPorts = { publish, capture: (sourceId, materialId) => capturePolicyMaterial(sourceId, materialId, get) };
  await discoverPolicyWorkflows();
  const before = requests.length;
  for (const stage of ["acquire", "fulltext", "vision"] as const) await advancePolicyMaterial(job, stage, ports, { root, collectionEnabled: true });
  assert.equal((await readPolicyWorkflow(f.sourceId, f.materialId))?.status, "needs_configuration");
  assert.equal(requests.length, before);
});

test("collection and model switches leave resumable work without making a new network or model request", async () => {
  const f = await fixture(),
    job = { lane: "policy" as const, sourceId: f.sourceId, materialId: f.materialId };
  await discoverPolicyWorkflows();
  let modelCalls = 0;
  const ports: PolicyAutomationPorts = {
    publish,
    capture: (sourceId, materialId) => capturePolicyMaterial(sourceId, materialId, f.get),
    fulltext: async () => {
      modelCalls++;
      throw new Error("model switch must be checked before runtime dispatch");
    },
  };
  await advancePolicyMaterial(job, "acquire", ports, { root, collectionEnabled: false });
  assert.equal(f.hits(), 0);
  assert.equal((await readPolicyWorkflow(f.sourceId, f.materialId))?.status, "collection_paused");
  await advancePolicyMaterial(job, "acquire", ports, { root, collectionEnabled: true });
  config.modelCallsEnabled = false;
  try {
    await advancePolicyMaterial(job, "fulltext", ports, { root, collectionEnabled: true });
    const row = await readPolicyWorkflow(f.sourceId, f.materialId);
    assert.equal(row?.stage, "fulltext");
    assert.equal(row?.status, "pending");
    assert.equal(modelCalls, 0);
  } finally {
    config.modelCallsEnabled = true;
  }
});
