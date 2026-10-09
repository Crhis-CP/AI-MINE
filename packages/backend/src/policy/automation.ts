import { runtimeControlSnapshot } from "../operations/lane-controls.ts";
import { readSourceDateContext, sourceIdsOnLane } from "@amp/backend/admin/sources";
import { policyMaterialReference, policyMaterialReferences } from "@amp/backend/content/materials";
import { latestSuccessfulRunResult } from "@amp/backend/admin/runs";
import { config } from "../config.ts";
import { dbOf } from "../db.ts";
import { policyProfile } from "./automation-profile.ts";
import { capturePolicyMaterial } from "./capture.ts";
import { runPolicyFulltext } from "./fulltext-runtime.ts";
import { processingControl } from "./fulltext-store.ts";
import { runPolicyVision } from "./vision-runtime.ts";
import { policyRelationshipCandidates } from "../publication/policy-relations.ts";
import { runPolicyInterpretation } from "./interpretation-runtime.ts";
import type { ExtractionProfile } from "./extraction.ts";

const sql = dbOf("policy");
export const POLICY_STAGES = ["acquire", "fulltext", "vision", "interpret", "publish"] as const;
export type PolicyStage = (typeof POLICY_STAGES)[number];
export type PolicyJob = { lane: "policy"; sourceId: string; materialId: string };
export type PublishResult =
  | { status: "published"; mode: "basic_facts" | "complete"; policyId: string; editionId: string; pending?: "quality" | "interpretation" }
  | { status: "pending"; reason: "identity" | "permission" | "paused" | "withdrawn" | "stale" };
export interface PolicyAutomationPorts {
  publish: (input: { expressionId: string; fulltextRunId?: string }) => Promise<PublishResult>;
  capture?: typeof capturePolicyMaterial;
  fulltext?: typeof runPolicyFulltext;
  interpret?: typeof runPolicyInterpretation;
  vision?: (expressionId: string, profile: ExtractionProfile, options: { root: AbortSignal; maxRequests: number }) => Promise<{ status: string }>;
}
type Workflow = {
  source_id: string;
  material_id: string;
  material_revision: number;
  profile_hash: string | null;
  expression_id: string | null;
  document_revision_id: string | null;
  fulltext_run_id: string | null;
  stage: PolicyStage;
  status: string;
  reason: string | null;
  next_check_at: Date;
};
const runnable = new Set(["pending", "partial"]);
const finished = new Set(["published", "semantic_verified", "semantic_failed", "excluded", "uncertain"]);
export async function readPolicyWorkflow(sourceId: string, materialId: string) {
  const [row] = await sql<
    Workflow[]
  >`SELECT source_id,material_id,material_revision,profile_hash,expression_id,document_revision_id,fulltext_run_id,stage,status,reason,next_check_at
    FROM policy.material_workflows WHERE source_id=${sourceId} AND material_id=${materialId}`;
  return row ?? null;
}
async function save(row: Workflow, stage: PolicyStage, status: string, reason: string | null, delayMinutes: number) {
  await sql`UPDATE policy.material_workflows SET material_revision=${row.material_revision},profile_hash=${row.profile_hash},expression_id=${row.expression_id},
    document_revision_id=${row.document_revision_id},fulltext_run_id=${row.fulltext_run_id},stage=${stage},status=${status},reason=${reason},
    next_check_at=now()+${delayMinutes}*interval '1 minute',updated_at=now() WHERE source_id=${row.source_id} AND material_id=${row.material_id}`;
  return { status, stage, reason };
}
/** One bounded worker turn. Blocked paid stages are only revisited after changed source inputs or an explicit pause release. */
export async function advancePolicyMaterial(
  job: PolicyJob,
  stage: PolicyStage,
  ports: PolicyAutomationPorts,
  options: { root: AbortSignal; collectionEnabled: boolean },
) {
  options.root.throwIfAborted();
  const row = await readPolicyWorkflow(job.sourceId, job.materialId);
  if (!row || row.stage !== stage) return { status: "obsolete" };
  const source = await readSourceDateContext(job.sourceId),
    material = await policyMaterialReference(job.materialId, job.sourceId);
  if (!source?.enabled || source.lane !== "policy" || !material) return save(row, "acquire", "unavailable", null, 60);
  const configured = policyProfile(source);
  if (!configured) return save(row, "acquire", "needs_configuration", "缺少明确的官方原件取得配置", 60);
  const { profile, profileHash } = configured,
    interval = profile.recheckMinutes;
  const previousStatus = row.status,
    previousRevision = row.document_revision_id,
    previousProfile = row.profile_hash;
  const needsAcquire =
    stage === "acquire" || !runnable.has(row.status) || row.profile_hash !== profileHash || row.material_revision !== material.materialRevision;
  if (needsAcquire) {
    if ((await runtimeControlSnapshot("policy", ["collection"])).paused) return save(row, "acquire", "pending", "采集已暂停", 1);
    if (!options.collectionEnabled) return save(row, "acquire", "collection_paused", null, interval);
    const capture = await (ports.capture ?? capturePolicyMaterial)(job.sourceId, job.materialId);
    if (capture.status !== "captured") return save(row, "acquire", capture.status, null, interval);
    row.expression_id = capture.expressionId;
    row.document_revision_id = capture.revisionId;
    row.material_revision = material.materialRevision;
    row.profile_hash = profileHash;
    const changed = previousRevision !== capture.revisionId || previousProfile !== profileHash;
    if (changed) row.fulltext_run_id = null;
    const basic = await ports.publish({ expressionId: capture.expressionId });
    if (basic.status === "pending" && basic.reason === "paused" && !capture.fulltextAllowed) return save(row, "publish", "pending", "公开已暂停", 1);
    if (basic.status === "pending" && basic.reason === "withdrawn") return save(row, "acquire", basic.reason, null, interval);
    if (!capture.fulltextAllowed) return save(row, "acquire", "permission", "全文用途未获准，保留独立基本事实", interval);
    if (!changed && finished.has(previousStatus)) {
      const result = await ports.publish({ expressionId: capture.expressionId, ...(row.fulltext_run_id ? { fulltextRunId: row.fulltext_run_id } : {}) });
      if (result.status === "pending" && result.reason === "paused") return save(row, "publish", "pending", "公开已暂停", 1);
      return save(row, "acquire", previousStatus, result.status === "pending" ? result.reason : (result.pending ?? null), interval);
    }
    const control = await processingControl(capture.expressionId);
    if (control.paused) return save(row, "acquire", "paused", null, interval);
    if (!changed && !runnable.has(previousStatus) && !["collection_paused", "paused", "needs_configuration", "unavailable"].includes(previousStatus))
      return save(row, "acquire", previousStatus, row.reason, interval);
    return save(row, "fulltext", "pending", null, 0);
  }
  if (!row.expression_id) return save(row, "acquire", "pending", null, 0);
  if ((await processingControl(row.expression_id)).paused) return save(row, "acquire", "paused", null, interval);
  if (["fulltext", "vision", "interpret"].includes(stage) && !config.modelCallsEnabled) return save(row, stage, "pending", "模型调用已暂停", 1);
  if (stage === "fulltext") {
    const result = await (ports.fulltext ?? runPolicyFulltext)(row.expression_id, profile.extraction, { root: options.root, maxRequests: 2 });
    if (["paused", "waiting_control"].includes(result.status)) return save(row, "fulltext", "pending", "运行控制暂停或变化，等待复核", 1);
    if (result.status === "program_validated" && "runId" in result) {
      row.fulltext_run_id = result.runId;
      return save(row, "interpret", "pending", null, 0);
    }
    if (result.status === "incomplete" && "runId" in result) return save(row, "fulltext", "partial", null, 0);
    if (result.status === "incomplete" && row.reason !== "vision_extracted") return save(row, "vision", "pending", null, 0);
    return save(row, "acquire", result.status, "全文尚未通过完整性要求", interval);
  }
  if (stage === "vision") {
    const vision = await (ports.vision ?? runPolicyVision)(row.expression_id, profile.extraction, { root: options.root, maxRequests: 2 });
    if (["paused", "waiting_control"].includes(vision.status)) return save(row, "vision", "pending", "运行控制暂停或变化，等待复核", 1);
    if (vision.status === "partial") return save(row, "vision", "partial", null, 0);
    if (vision.status === "extracted") return save(row, "fulltext", "pending", "vision_extracted", 0);
    return save(row, "acquire", vision.status === "not_required" ? "incomplete" : vision.status, "原件版面或图件尚未完整", interval);
  }
  if (stage === "interpret") {
    if (!row.fulltext_run_id) return save(row, "fulltext", "pending", null, 0);
    const result = await (ports.interpret ?? runPolicyInterpretation)(row.fulltext_run_id, {
      root: options.root,
      maxRequests: 2,
      related: await policyRelationshipCandidates(row.fulltext_run_id),
    });
    if (["paused", "waiting_control"].includes(result.status)) return save(row, "interpret", "pending", "运行控制暂停或变化，等待复核", 1);
    if (result.status === "partial") return save(row, "interpret", "partial", null, 0);
    if (finished.has(result.status)) return save(row, "publish", "pending", result.status, 0);
    return save(row, "acquire", result.status, "解读或核验尚未完成", interval);
  }
  const result = await ports.publish({ expressionId: row.expression_id, ...(row.fulltext_run_id ? { fulltextRunId: row.fulltext_run_id } : {}) });
  if (result.status === "pending" && result.reason === "paused") return save(row, "publish", "pending", "公开已暂停", 1);
  return save(
    row,
    "acquire",
    result.status === "published" ? (row.reason && finished.has(row.reason) ? row.reason : "published") : result.reason,
    result.status === "published" ? (result.pending ?? null) : result.reason,
    interval,
  );
}

/** Bounded discovery repair; content owns the rows, job_runs owns the round-robin cursor. */
export async function discoverPolicyWorkflows(limit = 50) {
  const previous = (await latestSuccessfulRunResult("policy.pipeline.sweep")) as { cursor?: { materialId: string; sourceId: string } } | null;
  const cursor =
    previous?.cursor && typeof previous.cursor.materialId === "string" && typeof previous.cursor.sourceId === "string"
      ? previous.cursor
      : { materialId: "", sourceId: "" };
  const rows = await policyMaterialReferences(await sourceIdsOnLane("policy"), cursor, limit);
  for (const row of rows)
    await sql`INSERT INTO policy.material_workflows(source_id,material_id,material_revision)
    VALUES(${row.sourceId},${row.materialId},${row.materialRevision}) ON CONFLICT DO NOTHING`;
  const last = rows.at(-1);
  return {
    scanned: rows.length,
    cursor: rows.length === limit && last ? { materialId: last.materialId, sourceId: last.sourceId } : { materialId: "", sourceId: "" },
  };
}
export async function duePolicyWorkflows(limit = 50) {
  return sql<
    Workflow[]
  >`SELECT source_id,material_id,material_revision,profile_hash,expression_id,document_revision_id,fulltext_run_id,stage,status,reason,next_check_at
    FROM policy.material_workflows WHERE next_check_at<=now() ORDER BY next_check_at,source_id,material_id LIMIT ${limit}`;
}
export async function policyWorkflowFailed(job: PolicyJob, stage: PolicyStage) {
  const row = await readPolicyWorkflow(job.sourceId, job.materialId);
  if (row?.stage === stage) await save(row, "acquire", "failed", "自动处理失败；待来源复查或人工处理", 60);
}
