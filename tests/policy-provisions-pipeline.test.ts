// Policy restart, no-model stages (DEC-78补充·五项决定 5): archive → structure → publish with the model switch off,
// the public clause-by-clause comparison, the backfill, and the operator switches' defaults. No model is reachable.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { config } from "@amp/backend/config";
import { stopBoss } from "@amp/backend/jobs/queue";
import { PolicyComparison, PolicyScopeList } from "@amp/contracts/http/public";
import { capturePolicyMaterial } from "../modules/policy/backend/domain/capture.ts";
import { advancePolicyMaterial, discoverPolicyWorkflows, readPolicyWorkflow, type PolicyAutomationPorts } from "../modules/policy/backend/domain/automation.ts";
import { extractPolicyOriginal } from "../modules/policy/backend/domain/extraction.ts";
import { backfillPolicyStructures, readPolicyProvisions } from "../modules/policy/backend/domain/provision-store.ts";
import { publishPolicyPublication } from "../modules/policy/backend/publication/policies-publish.ts";
import { projectPendingPolicyProvisions } from "../modules/policy/backend/publication/policy-provisions-project.ts";
import { policyHistory, policyScope, PolicyReadError } from "../modules/policy/backend/read.ts";
import { policyComparison } from "../modules/policy/backend/compare.ts";
import { createPolicyGateway } from "../modules/policy/backend/provider.ts";
import { PolicyModelStagesDisabled, policyArchiveEnabled } from "../modules/policy/backend/pilot.ts";
import { ensurePolicyQueues, sweepPolicyMaterials } from "../modules/policy/backend/jobs.ts";
import { POLICY_STAGES } from "../modules/policy/backend/domain/automation.ts";
import { currentPolicyProcessingRecipe } from "../modules/policy/backend/domain/recipe.ts";
import { fixture } from "./policy-automation-fixture.ts";

// A model endpoint that cannot answer: any attempt would fail loudly rather than buy anything.
Object.assign(process.env, { LLM_BASE_URL: "http://127.0.0.1:9/v1", LLM_API_KEY: "unused", COLLECT_ENABLED: "true", COLLECT_POLICY_ENABLED: "true" });
config.modelCallsEnabled = true;
const root = new AbortController().signal;
const V1 = [
  "Article 1 Scope",
  "This Regulation applies to every holder of a mining lease.",
  "Article 2 Royalty",
  "A holder must pay royalty at 5 per cent of the value of the mineral recovered.",
  "Article 3 Reports",
  "A holder must file a quarterly production report.",
];
const V2 = [
  "Article 1 Scope",
  "This Regulation applies to every holder of a mining lease.",
  "Article 2 Royalty",
  "A holder must pay royalty at 7 per cent of the value of the mineral recovered.",
  "Article 2A Critical minerals",
  "Royalty on lithium is payable at 4 per cent.",
];
const html = (lines: string[]) => lines.join("</p><p>");

beforeEach(() => {
  delete process.env.POLICY_MODEL_STAGES_ENABLED;
  process.env.POLICY_PILOT_ENABLED = "true";
});
after(async () => {
  await stopBoss();
  await closeDb();
});

test("switch defaults: archive and model stages stay off until the operator sets them; the reader notice follows", async () => {
  delete process.env.POLICY_PILOT_ENABLED;
  assert.equal(policyArchiveEnabled(), false);
  assert.equal(PolicyScopeList.parse(await policyScope()).updates, "paused");
  await assert.rejects(
    createPolicyGateway({ root, resolve: async () => null }).chat({
      input: { kind: "policy_part", id: "x", version: "1" } as never,
      purpose: "policy_interpret",
      schema: PolicyScopeList,
    }),
    PolicyModelStagesDisabled,
  );
  await ensurePolicyQueues();
  await sql`DELETE FROM pgboss.job WHERE name LIKE 'policy.%'`;
  await sql`UPDATE ops.lane_controls SET paused=false,revision=revision+1`;
  for (const stage of POLICY_STAGES)
    await sql`INSERT INTO policy.material_workflows(source_id,material_id,material_revision,processing_recipe_hash,stage,next_check_at)
      VALUES('switch-defaults',${`material-${stage}`},1,${currentPolicyProcessingRecipe()},${stage},now()-interval '1 minute')`;
  await sweepPolicyMaterials();
  const queued = async () =>
    (await sql<{ name: string }[]>`SELECT name FROM pgboss.job WHERE name LIKE 'policy.%' AND state='created' ORDER BY name`).map((r) => r.name);
  assert.deepEqual(await queued(), ["policy.publish"], "without either switch only publication of existing work runs");
  process.env.POLICY_PILOT_ENABLED = "true";
  await sql`DELETE FROM pgboss.job WHERE name LIKE 'policy.%'`;
  await sweepPolicyMaterials();
  assert.deepEqual(await queued(), ["policy.acquire", "policy.publish"], "the pilot resumes archive only; no model stage is queued");
  assert.equal(PolicyScopeList.parse(await policyScope()).updates, "pilot");
  await sql`DELETE FROM policy.material_workflows WHERE source_id='switch-defaults'`;
  await sql`DELETE FROM pgboss.job WHERE name LIKE 'policy.%'`;
});

test("archive → structure → publish without a model; two revisions compare clause by clause on read", async () => {
  const f = await fixture(),
    job = { lane: "policy" as const, sourceId: f.sourceId, materialId: f.materialId };
  await discoverPolicyWorkflows();
  let fulltext = 0;
  const ports: PolicyAutomationPorts = {
    publish: publishPolicyPublication,
    capture: (sourceId, materialId) => capturePolicyMaterial(sourceId, materialId, f.get),
    fulltext: async () => {
      fulltext++;
      throw new Error("model stage must not run");
    },
  };
  f.setText(html(V1));
  await advancePolicyMaterial(job, "acquire", ports, { root, collectionEnabled: true });
  const first = (await readPolicyWorkflow(f.sourceId, f.materialId))!;
  assert.equal(first.stage, "acquire");
  assert.equal(first.status, "structured", "with model stages off the workflow stops after archive and structure");
  const stored = (await readPolicyProvisions(first.document_revision_id!))!;
  assert.equal(stored.structure.status, "structured");
  assert.deepEqual(
    stored.provisions.map((p) => [p.key, p.heading]),
    [
      ["1", "Scope"],
      ["2", "Royalty"],
      ["3", "Reports"],
    ],
  );
  // A queued model stage observes the switch at execution and waits.
  await sql`UPDATE policy.material_workflows SET stage='fulltext',status='pending' WHERE source_id=${f.sourceId}`;
  await advancePolicyMaterial(job, "fulltext", ports, { root, collectionEnabled: true });
  const waiting = (await readPolicyWorkflow(f.sourceId, f.materialId))!;
  assert.deepEqual([waiting.stage, waiting.status, waiting.reason], ["fulltext", "pending", "模型阶段未启用"]);
  assert.equal(fulltext, 0);
  await sql`UPDATE policy.material_workflows SET stage='acquire',status='structured' WHERE source_id=${f.sourceId}`;
  const editions = await sql<
    { policy_id: string }[]
  >`SELECT policy_id FROM publication.policy_editions WHERE native_revision_id=${first.document_revision_id!}`;
  assert.equal(editions.length, 1);
  const policyId = editions[0]!.policy_id;
  await assert.rejects(policyComparison(policyId, {}), (e: unknown) => e instanceof PolicyReadError && e.status === 404, "one revision has nothing to compare");

  f.setText(html(V2));
  await sql`UPDATE policy.material_workflows SET next_check_at=now() WHERE source_id=${f.sourceId}`;
  await advancePolicyMaterial(job, "acquire", ports, { root, collectionEnabled: true });
  const second = (await readPolicyWorkflow(f.sourceId, f.materialId))!;
  assert.notEqual(second.document_revision_id, first.document_revision_id);
  assert.equal(second.status, "structured");
  assert.equal((await sql`SELECT count(*)::int AS n FROM publication.policy_provision_sets`)[0]!.n >= 2, true);

  const history = await policyHistory(policyId, { limit: 20 });
  assert.equal(history.items.length, 2);
  const comparison = PolicyComparison.parse(await policyComparison(policyId, {}));
  assert.equal(comparison.method, "deterministic");
  assert.equal(comparison.to.current, true);
  assert.equal(comparison.from.current, false);
  assert.deepEqual(comparison.counts, { added: 1, modified: 1, removed: 1, unchanged: 1 });
  assert.deepEqual(
    comparison.provisions.map((p) => [p.change, p.from?.number_key ?? null, p.to?.number_key ?? null]),
    [
      ["unchanged", "1", "1"],
      ["modified", "2", "2"],
      ["removed", "3", null],
      ["added", null, "2A"],
    ],
  );
  assert.deepEqual(
    comparison.provisions[1]!.diff!.filter((s) => s.op !== "equal"),
    [
      { op: "delete", text: "5" },
      { op: "insert", text: "7" },
    ],
  );
  assert.equal(comparison.candidates.length, 2);
  // Explicit selection by public revision ids, in either direction, and refusal of a self-comparison.
  const reverse = await policyComparison(policyId, { from: comparison.to.document_revision_id, to: comparison.from.document_revision_id });
  assert.deepEqual(reverse.counts, { added: 1, modified: 1, removed: 1, unchanged: 1 });
  await assert.rejects(
    policyComparison(policyId, { from: comparison.to.document_revision_id, to: comparison.to.document_revision_id }),
    (e: unknown) => e instanceof PolicyReadError && e.status === 400,
  );
  await assert.rejects(policyComparison(policyId, { from: "unknown-revision" }), (e: unknown) => e instanceof PolicyReadError && e.status === 404);
  // Withdrawal applies to the comparison as to every other read.
  await sql`UPDATE publication.policy_documents SET withdrawn=true WHERE id=${policyId}`;
  await assert.rejects(policyComparison(policyId, {}), (e: unknown) => e instanceof PolicyReadError && e.status === 410);
  await sql`UPDATE publication.policy_documents SET withdrawn=false WHERE id=${policyId}`;
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipt_attempts`)[0]!.n, 0, "no model request was made");
});

test("backfill structures earlier revisions from their cached extraction; dry run writes nothing; projection is idempotent", async () => {
  const f = await fixture(),
    job = { lane: "policy" as const, sourceId: f.sourceId, materialId: f.materialId };
  await discoverPolicyWorkflows();
  // An archive made before the structure stage existed: no provisions, but a cached extraction of the original.
  const ports: PolicyAutomationPorts = {
    publish: publishPolicyPublication,
    capture: (sourceId, materialId) => capturePolicyMaterial(sourceId, materialId, f.get),
    structure: async () => undefined,
  };
  f.setText(html(V1));
  await advancePolicyMaterial(job, "acquire", ports, { root, collectionEnabled: true });
  const row = (await readPolicyWorkflow(f.sourceId, f.materialId))!;
  assert.equal(await readPolicyProvisions(row.document_revision_id!), null);
  await extractPolicyOriginal(row.expression_id!, f.profile.extraction);
  const dry = await backfillPolicyStructures({ apply: false });
  const planned = dry.results.find((r) => r.revisionId === row.document_revision_id);
  assert.deepEqual(planned && [planned.status, planned.provisions], ["structured", 3]);
  assert.equal(await readPolicyProvisions(row.document_revision_id!), null, "dry run writes nothing");
  await backfillPolicyStructures({ apply: true });
  assert.equal((await readPolicyProvisions(row.document_revision_id!))?.provisions.length, 3);
  const projected = await projectPendingPolicyProvisions();
  assert.deepEqual(
    projected.results.filter((r) => r.revisionId === row.document_revision_id).map((r) => r.status),
    ["projected"],
  );
  assert.deepEqual(
    (await projectPendingPolicyProvisions()).results.filter((r) => r.revisionId === row.document_revision_id),
    [],
    "a projected revision is not visited again",
  );
});
