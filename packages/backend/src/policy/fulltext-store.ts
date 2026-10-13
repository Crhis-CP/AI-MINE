import { runtimeControlSnapshot, assertRuntimeControl, type RuntimeControlSnapshot } from "../operations/lane-controls.ts";
import { dbOf, type Tx } from "../db.ts";
import { assertOriginalPermissions, readPolicyOriginal as readCurrentOriginal, type readPolicyOriginal } from "./originals.ts";
import { evaluateSourcePolicy } from "@amp/backend/admin/sources";
import { audit } from "../admin/auth.ts";
import { settlePolicyResponse } from "../providers/receipts.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import type { PolicyFulltextPlan } from "./processing-plan.ts";

const sql = dbOf("policy");
export type PolicyOriginal = NonNullable<Awaited<ReturnType<typeof readPolicyOriginal>>>;
export type FulltextRun = {
  id: string;
  plan: PolicyFulltextPlan;
  snapshot: PolicyOriginal;
  controlVersion: number;
  recipeHash: string;
  runtimeControl?: RuntimeControlSnapshot;
};
export class PolicyRunStaleError extends Error {}
export async function readProcessingControl(expressionId: string) {
  const [row] = await sql<{ version: number; paused: boolean }[]>`SELECT version,paused FROM policy.processing_controls WHERE expression_id=${expressionId}`;
  return row ?? null;
}
export async function processingControl(expressionId: string) {
  await sql`INSERT INTO policy.processing_controls(expression_id) VALUES(${expressionId}) ON CONFLICT DO NOTHING`;
  const [row] = await sql<{ version: number; paused: boolean }[]>`SELECT version,paused FROM policy.processing_controls WHERE expression_id=${expressionId}`;
  return row!;
}
export async function setPolicyProcessingPaused(expressionId: string, change: { expectedVersion: number; paused: boolean; reason: string; actor: string }) {
  if (!change.reason.trim() || !change.actor.trim()) throw new Error("Processing pause needs reason and actor");
  return sql.begin(async (tx) => {
    const [row] =
      await tx`UPDATE policy.processing_controls SET version=version+1,paused=${change.paused},reason=${change.reason},actor=${change.actor},updated_at=now()
      WHERE expression_id=${expressionId} AND version=${change.expectedVersion} RETURNING version`;
    if (!row) throw new PolicyRunStaleError("Processing control changed");
    await audit(
      change.actor,
      "policy.processing",
      `policy:${expressionId}`,
      change.reason,
      null,
      { paused: change.paused, version: row.version },
      undefined,
      tx,
    );
    return Number(row.version);
  });
}
export type OriginalRun = { snapshot: PolicyOriginal; expressionId: string; controlVersion: number; runtimeControl?: RuntimeControlSnapshot };
export async function withCurrentPolicyOriginal<T>(run: OriginalRun, action: (tx: Tx) => Promise<T>) {
  return sql.begin(async (tx) => {
    if (run.runtimeControl) await assertRuntimeControl(tx, run.runtimeControl);
    const s = run.snapshot;
    await assertOriginalPermissions(tx, s.sourceId, s.permissionVersion, s.manifest.resources, s.manifest.identity, true);
    for (const resource of s.resources) {
      const allowed = await evaluateSourcePolicy(
        {
          source_id: s.sourceId,
          expected_permission_version: s.permissionVersion,
          lane: "policy",
          capability: "external_model",
          resource: { url: resource.url, document_type: s.manifest.identity.documentType, attachment: resource.attachment },
        },
        undefined,
        tx,
      );
      if (allowed.decision !== "allow") throw new PolicyRunStaleError("Policy processing permission changed");
    }
    const [head] = await tx`SELECT current_revision_id FROM policy.expressions WHERE id=${run.expressionId} FOR SHARE`;
    const [control] = await tx`SELECT version,paused FROM policy.processing_controls WHERE expression_id=${run.expressionId} FOR SHARE`;
    if (head?.current_revision_id !== s.revisionId || control?.version !== run.controlVersion || control?.paused)
      throw new PolicyRunStaleError("Policy original or control changed");
    return action(tx);
  });
}
export async function withCurrentPolicyRun<T>(run: FulltextRun, action: (tx: Tx) => Promise<T>) {
  return withCurrentPolicyOriginal(
    { snapshot: run.snapshot, expressionId: run.plan.context.expressionId, controlVersion: run.controlVersion, runtimeControl: run.runtimeControl },
    action,
  );
}
export async function beginPolicyFulltext(snapshot: PolicyOriginal, plan: PolicyFulltextPlan, recipeHash: string): Promise<FulltextRun | null> {
  const runtimeControl = await runtimeControlSnapshot("policy", ["processing"]);
  if (runtimeControl.paused) return null;
  const control = await processingControl(plan.context.expressionId);
  if (control.paused) return null;
  const run = {
    id: sha256(stableJson([plan.manifestHash, recipeHash, control.version, snapshot.permissionVersion])),
    plan,
    snapshot,
    controlVersion: control.version,
    recipeHash,
    runtimeControl,
  };
  await withCurrentPolicyRun(run, async (tx) => {
    await tx`INSERT INTO policy.fulltext_runs(id,expression_id,revision_id,control_version,recipe_hash,plan)
      VALUES(${run.id},${plan.context.expressionId},${snapshot.revisionId},${control.version},${recipeHash},${tx.json(plan)}) ON CONFLICT DO NOTHING`;
  });
  return run;
}
export async function assertPolicyRunCurrent(run: FulltextRun) {
  await withCurrentPolicyRun(run, async () => {});
}
export async function fulltextCheckpoints(run: FulltextRun) {
  return withCurrentPolicyRun(
    run,
    (tx) => tx<{ partId: string; sourceHash: string; candidate: unknown; receiptId: number; attemptId: string }[]>`
    SELECT part_id AS "partId",source_hash AS "sourceHash",candidate,receipt_id AS "receiptId",attempt_id AS "attemptId" FROM policy.fulltext_parts
    WHERE recipe_hash=${run.recipeHash} AND part_id IN ${tx(run.plan.parts.map((p) => p.partId))}`,
  );
}
export async function saveFulltextResponse(
  run: FulltextRun,
  receipt: { receiptId: number; attemptId: string | null },
  parts: { partId: string; sourceHash: string; candidate: unknown }[],
  allAccepted: boolean | null,
) {
  return withCurrentPolicyRun(run, async (tx) => {
    const settled = await settlePolicyResponse(tx, receipt, allAccepted);
    if (!settled) throw new Error("Policy response has no actual matching attempt");
    if (receipt.attemptId !== null)
      for (const part of parts)
        await tx`INSERT INTO policy.fulltext_parts(part_id,recipe_hash,source_hash,candidate,receipt_id,attempt_id)
        VALUES(${part.partId},${run.recipeHash},${part.sourceHash},${tx.json(part.candidate as never)},${receipt.receiptId},${receipt.attemptId}) ON CONFLICT DO NOTHING`;
    return settled.knownUsage;
  });
}
export async function finishPolicyFulltext(run: FulltextRun, output: unknown, complete: boolean) {
  if (Buffer.byteLength(stableJson(output), "utf8") > 8 * 1024 * 1024) throw new Error("Policy output exceeds capacity");
  await withCurrentPolicyRun(run, async (tx) => {
    await tx`UPDATE policy.fulltext_runs SET status=${complete ? "program_validated" : "partial"},output=${tx.json(output as never)},updated_at=now() WHERE id=${run.id}`;
  });
}

/** A following policy stage must consume a current program-validated run, then validate its output contract. */
export async function readPolicyFulltextRun(runId: string) {
  const [row] = await sql<
    { id: string; expression_id: string; revision_id: string; control_version: number; recipe_hash: string; plan: PolicyFulltextPlan; output: unknown }[]
  >`
    SELECT id,expression_id,revision_id,control_version,recipe_hash,plan,output FROM policy.fulltext_runs WHERE id=${runId} AND status='program_validated'`;
  if (!row) return null;
  const snapshot = await readCurrentOriginal(row.expression_id);
  if (!snapshot || snapshot.revisionId !== row.revision_id || row.plan.revisionId !== row.revision_id || row.plan.context.expressionId !== row.expression_id)
    return null;
  const run: FulltextRun = { id: row.id, plan: row.plan, snapshot, controlVersion: row.control_version, recipeHash: row.recipe_hash };
  await assertPolicyRunCurrent(run);
  return { run, output: row.output };
}
