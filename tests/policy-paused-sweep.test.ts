import "./setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { config } from "@amp/backend/config";
import { recordRun, stopBoss } from "@amp/backend/jobs/queue";
import { latestSuccessfulRunResult } from "@amp/backend/admin/runs";
import { changeSystemLaneControl, laneControlHolderRevisions, runtimeControlSnapshot, type RuntimeSwitch } from "@amp/backend/operations/lane-controls";
import { ensurePolicyQueues, policyQueues, sweepPolicyMaterials } from "../modules/policy/backend/jobs.ts";
import { POLICY_STAGES, duePolicyWorkflows, readPolicyWorkflow } from "../modules/policy/backend/domain/automation.ts";
import { currentPolicyProcessingRecipe } from "../modules/policy/backend/domain/recipe.ts";
import { fixture } from "./policy-automation-fixture.ts";

const sweep = () => recordRun("policy.pipeline.sweep", sweepPolicyMaterials);
async function hold(switches: RuntimeSwitch[], action: "pause" | "resume" = "pause") {
  await changeSystemLaneControl({
    lane: "policy",
    switches,
    action,
    expected: await laneControlHolderRevisions("policy", "system"),
    reason: "Synthetic paused scheduler regression",
    actor: "test-policy-sweep",
    ...(action === "pause" ? { expiresAt: new Date(Date.now() + 3600_000).toISOString() } : {}),
  });
}
async function queued() {
  return (await sql<{ name: string }[]>`SELECT name FROM pgboss.job WHERE name LIKE 'policy.%' AND state='created' ORDER BY name`).map((r) => r.name);
}
async function workflow(stage: (typeof POLICY_STAGES)[number], suffix: string = stage, minutesAgo = 1) {
  await sql`INSERT INTO policy.material_workflows(source_id,material_id,material_revision,processing_recipe_hash,stage,next_check_at)
    VALUES('synthetic-sweep',${`material-${suffix}`},1,${currentPolicyProcessingRecipe()},${stage},now()-${minutesAgo}*interval '1 minute')`;
}

beforeEach(async () => {
  process.env.COLLECT_ENABLED = "true";
  process.env.COLLECT_POLICY_ENABLED = "true";
  config.modelCallsEnabled = true;
  await sql`UPDATE ops.lane_controls SET paused=false,revision=revision+1`;
  await sql`DELETE FROM policy.material_workflows`;
  await sql`DELETE FROM job_runs WHERE job='policy.pipeline.sweep'`;
  await sql`UPDATE sources SET lane='news' WHERE id LIKE 'automation-%'`;
  await ensurePolicyQueues();
  await sql`DELETE FROM pgboss.job WHERE name LIKE 'policy.%'`;
});
after(async () => {
  await stopBoss();
  await closeDb();
});

test("paused collection neither discovers nor enqueues acquisition, preserves cursor across sweeps, and resumes after it", async () => {
  const materials = [await fixture(), await fixture()].sort((a, b) => a.materialId.localeCompare(b.materialId));
  const cursor = { materialId: materials[0]!.materialId, sourceId: materials[0]!.sourceId };
  await recordRun("policy.pipeline.sweep", async () => ({ scanned: 1, cursor, enqueued: 0 }));
  await hold(["collection"]);
  for (let round = 0; round < 2; round++) {
    const result = await sweep();
    assert.equal(result.scanned, 0);
    assert.equal(result.enqueued, 0);
    assert.deepEqual(result.cursor, cursor);
    assert.equal((await sql`SELECT count(*)::int AS n FROM policy.material_workflows`)[0].n, 0);
    assert.deepEqual(await queued(), []);
  }
  assert.equal((await runtimeControlSnapshot("news", ["collection", "processing", "publication"])).paused, false);
  await hold(["collection"], "resume");
  assert.equal((await sweep()).scanned, 1);
  assert.equal(await readPolicyWorkflow(materials[0]!.sourceId, materials[0]!.materialId), null);
  assert.ok(await readPolicyWorkflow(materials[1]!.sourceId, materials[1]!.materialId));
});

test("collection, processing and publication independently filter their own stages before enqueue", async () => {
  for (const stage of POLICY_STAGES) await workflow(stage);
  const scenarios: { paused: RuntimeSwitch[]; expected: string[] }[] = [
    { paused: ["processing"], expected: ["policy.acquire", "policy.publish"] },
    { paused: ["collection"], expected: ["policy.fulltext", "policy.interpret", "policy.publish", "policy.vision"] },
    { paused: ["publication"], expected: ["policy.acquire", "policy.fulltext", "policy.interpret", "policy.vision"] },
    { paused: ["collection", "processing", "publication"], expected: [] },
  ];
  for (const scenario of scenarios) {
    await hold(scenario.paused);
    assert.equal((await sweep()).enqueued, scenario.expected.length);
    assert.deepEqual(await queued(), scenario.expected);
    await hold(scenario.paused, "resume");
    await sql`DELETE FROM pgboss.job WHERE name LIKE 'policy.%'`;
  }
  assert.equal((await duePolicyWorkflows()).length, POLICY_STAGES.length, "the original unfiltered read stays compatible");
});

test("more than one batch of paused work cannot starve permitted publication", async () => {
  for (let i = 0; i < 51; i++) await workflow("fulltext", `old-${i}`, 10);
  await workflow("publish", "ready", 1);
  await hold(["collection", "processing"]);
  assert.equal((await sweep()).enqueued, 1);
  assert.deepEqual(await queued(), ["policy.publish"]);
  assert.equal((await sql`SELECT count(*)::int AS n FROM policy.material_workflows WHERE stage='fulltext'`)[0].n, 51);
});

test("processing pause still discovers and schedules newly allowed collection; environment switches suppress only their stages", async () => {
  const material = await fixture();
  await hold(["processing"]);
  const result = await sweep();
  assert.equal(result.scanned, 1);
  assert.deepEqual(await queued(), ["policy.acquire"]);
  assert.ok(await readPolicyWorkflow(material.sourceId, material.materialId));
  await hold(["processing"], "resume");
  for (const stage of ["fulltext", "vision", "interpret", "publish"] as const) await workflow(stage);
  await sql`DELETE FROM pgboss.job WHERE name LIKE 'policy.%'`;
  process.env.COLLECT_POLICY_ENABLED = "false";
  config.modelCallsEnabled = false;
  assert.equal((await sweep()).enqueued, 1);
  assert.deepEqual(await queued(), ["policy.publish"]);
});

test("already queued acquisition still observes a later pause at execution, without fetching or buying a model result", async () => {
  const material = await fixture();
  assert.equal((await sweep()).enqueued, 1);
  await hold(["collection"]);
  let captures = 0;
  const acquire = policyQueues({
    publish: async () => ({ status: "pending", reason: "identity" }),
    capture: async () => {
      captures++;
      throw new Error("Paused acquisition must not fetch");
    },
  }).find((q) => q.name === "policy.acquire")!;
  await acquire.run([{ lane: "policy", sourceId: material.sourceId, materialId: material.materialId }]);
  assert.equal(captures, 0);
  assert.equal((await readPolicyWorkflow(material.sourceId, material.materialId))?.reason, "采集已暂停");
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipt_attempts`)[0].n, 0);
  assert.ok(await latestSuccessfulRunResult("policy.pipeline.acquire"));
});
