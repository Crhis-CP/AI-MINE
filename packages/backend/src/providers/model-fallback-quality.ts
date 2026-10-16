import { z } from "zod";
import { sql, type Db } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { CAPABILITIES } from "../editorial/models.ts";
import { modelConfigurationIdentity } from "../admin/models.ts";
import { requireOwner, audit, actorOf, type AdminPrincipal } from "../admin/auth.ts";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const Approval = z.strictObject({
  id: z.string(),
  capability: z.string(),
  modelKey: z.string(),
  configurationHash: hash,
  sourceIds: z.array(z.string()).min(1),
  promptVersion: z.string(),
  contracts: z.array(z.strictObject({ purpose: z.string(), contractHash: hash, systemHash: hash })).min(1),
  proofsHash: hash,
  reportedModels: z.array(z.string().min(1)).min(1),
  fingerprints: z.array(z.string().nullable()).min(1),
  goldHash: hash,
  sampleHash: hash,
  reviewEvidence: z.string().min(1),
  reviewedBy: z.number().int().positive(),
  validUntil: z.iso.datetime(),
  installedAt: z.iso.datetime(),
  revoked: z.boolean(),
});
export type ModelRouteApproval = z.infer<typeof Approval>;
export async function capabilityPrompt(capability: string): Promise<string | null> {
  if (["prefilter", "score", "understand", "summarize", "wording", "structure"].includes(capability)) {
    const { PROMPT_VERSIONS } = await import("../editorial/analyze.ts");
    return PROMPT_VERSIONS[capability as keyof typeof PROMPT_VERSIONS];
  }
  if (capability === "group") return (await import("../events/relate.ts")).BATCH_PROMPT_VERSION;
  if (capability === "groupReview") return (await import("../events/relate.ts")).RELATE_PROMPT_VERSION;
  if (capability === "digest") return (await import("../events/digest.ts")).DIGEST_PROMPT_VERSION;
  if (capability === "report") return (await import("../reports/compose.ts")).REPORT_VERSION;
  if (capability === "translate") return (await import("../editorial/translate.ts")).TRANSLATE_PROMPT_VERSION;
  return null;
}
export async function readModelRouteApproval(
  capability: string,
  modelKey: string,
  configurationHash: string,
  db: Db = sql,
): Promise<ModelRouteApproval | null> {
  const rows = await db<
    { id: string; model_route_approvals: unknown }[]
  >`SELECT id,model_route_approvals FROM selectbench_runs WHERE model_route_approvals IS NOT NULL ORDER BY created_at DESC`;
  const current = await capabilityPrompt(capability);
  for (const row of rows) {
    for (const candidate of Array.isArray(row.model_route_approvals) ? row.model_route_approvals : []) {
      const result = Approval.safeParse(candidate);
      if (!result.success) continue;
      const r = result.data;
      if (
        r.capability === capability &&
        r.modelKey === modelKey &&
        r.configurationHash === configurationHash &&
        !r.revoked &&
        Date.parse(r.validUntil) > Date.now() &&
        r.promptVersion === current
      ) {
        const evidence = await routeEvidence(row.id, modelKey, db);
        if (evidence && evidence.sampleHash === r.sampleHash && evidence.proofsHash === r.proofsHash) return r;
      }
    }
  }
  return null;
}
async function routeEvidence(runId: string, modelKey: string, db: Db) {
  const cases = await db<
    { case_id: string; gold: string; receipt_id: string; decision: string | null; error: string | null }[]
  >`SELECT case_id,gold,receipt_id::text,decision,error FROM selectbench_results WHERE run_id=${runId} AND model=${modelKey} ORDER BY case_id`;
  if (!cases.length || cases.some((c) => !c.receipt_id || c.error || !c.gold || !c.decision)) return null;
  const proofs = [];
  for (const c of cases) {
    const [r] = await db<
      {
        id: string;
        attempt_id: string;
        purpose: string;
        service: string;
        model: string | null;
        request: Record<string, unknown>;
        response: Record<string, unknown>;
        configuration_hash: string;
      }[]
    >`
   SELECT r.id::text,a.id::text AS attempt_id,r.purpose,a.service,a.model,r.request,a.response,s.configuration_hash FROM receipts r
   JOIN receipt_attempts a ON a.id=r.response_attempt_id AND a.receipt_id=r.id AND a.attempt=r.attempts
   JOIN ai.model_attempt_snapshots s ON s.attempt_id=a.id WHERE r.id=${c.receipt_id} AND r.status='completed' AND a.status='received' AND a.output_rejected_at IS NULL AND a.response=r.response`;
    if (!r) return null;
    proofs.push(r);
  }
  return { cases, proofs, sampleHash: sha256(stableJson(cases)), proofsHash: sha256(stableJson(proofs)) };
}
const Install = z.strictObject({
  runId: z.string().min(1),
  capability: z.string().min(1),
  modelKey: z.string().min(1),
  goldHash: hash,
  reviewEvidence: z.string().min(1),
  validUntil: z.iso.datetime(),
  heldOutReviewed: z.literal(true),
  sealedReviewed: z.literal(true),
  shadowReviewed: z.literal(true),
  canaryReviewed: z.literal(true),
  qualityAccepted: z.literal(true),
  reason: z.string().min(1),
});
/** Controlled Owner workflow: uploaded report text is never itself route qualification. */
export async function approveModelRoute(input: unknown, principal: AdminPrincipal) {
  const value = Install.parse(input),
    cap = CAPABILITIES[value.capability as keyof typeof CAPABILITIES];
  if (!cap || value.capability === "score" || value.capability.startsWith("policy_")) throw new Error("评分与法规须使用各自的质量资格入口");
  if (Date.parse(value.validUntil) <= Date.now()) throw new Error("资格有效期须在当前时间之后");
  return sql.begin(async (tx) => {
    await requireOwner(principal, tx);
    const model = await modelConfigurationIdentity(value.modelKey, tx);
    if (!model.configuration_hash) throw new Error("缺少实际模型配置");
    const [run] = await tx<
      { models: string[]; model_route_approvals: unknown }[]
    >`SELECT models,model_route_approvals FROM selectbench_runs WHERE id=${value.runId} FOR UPDATE`;
    if (!run?.models.includes(value.modelKey)) throw new Error("评测未包含此模型");
    const evidence = await routeEvidence(value.runId, value.modelKey, tx);
    if (!evidence) throw new Error("评测样本、金标或实际完成回执不完整");
    if (sha256(stableJson(evidence.cases.map((c) => [c.case_id, c.gold]))) !== value.goldHash) throw new Error("金标哈希与实际样本不一致");
    const prompt = await capabilityPrompt(value.capability),
      sources = new Set<string>(),
      reported = new Set<string>(),
      fingerprints = new Set<string | null>(),
      contracts = new Map<string, { purpose: string; contractHash: string; systemHash: string }>();
    for (const r of evidence.proofs) {
      if (
        !r ||
        r.configuration_hash !== model.configuration_hash ||
        r.service !== model.service ||
        r.model !== model.requestedModel ||
        !(cap.purposes as string[]).includes(r.purpose) ||
        r.request.promptVersion !== prompt ||
        ["research", "experiment"].includes(String(r.request.usage_purpose)) ||
        typeof r.request.contractHash !== "string" ||
        typeof r.request.systemHash !== "string" ||
        typeof r.response.model !== "string" ||
        !r.response.model.trim()
      )
        throw new Error("回执未证明本环节当前提示、实际配置与完整评测产物");
      if (!Array.isArray(r.request.sourceIds) || !r.request.sourceIds.length || !r.request.sourceIds.every((id) => typeof id === "string"))
        throw new Error("评测未记录真实材料来源");
      for (const source of r.request.sourceIds as string[]) sources.add(source);
      reported.add(r.response.model);
      const contract = { purpose: r.purpose, contractHash: r.request.contractHash, systemHash: r.request.systemHash };
      contracts.set(stableJson(contract), contract);
      fingerprints.add(typeof r.response.system_fingerprint === "string" ? r.response.system_fingerprint : null);
    }
    const installedAt = new Date().toISOString(),
      id = `mqa_${sha256(stableJson([value, installedAt])).slice(0, 24)}`;
    const record = Approval.parse({
      id,
      capability: value.capability,
      modelKey: value.modelKey,
      configurationHash: model.configuration_hash,
      sourceIds: [...sources].sort(),
      promptVersion: prompt,
      contracts: [...contracts.values()],
      proofsHash: evidence.proofsHash,
      reportedModels: [...reported].sort(),
      fingerprints: [...fingerprints],
      goldHash: value.goldHash,
      sampleHash: evidence.sampleHash,
      reviewEvidence: value.reviewEvidence,
      reviewedBy: principal.userId,
      validUntil: value.validUntil,
      installedAt,
      revoked: false,
    });
    const existing = Array.isArray(run.model_route_approvals) ? run.model_route_approvals : [];
    await tx`UPDATE selectbench_runs SET model_route_approvals=${tx.json([...existing, record] as never)} WHERE id=${value.runId}`;
    await audit(
      actorOf(principal),
      "models.backup.quality",
      value.runId,
      value.reason,
      null,
      { id, capability: value.capability, modelKey: value.modelKey, configurationHash: model.configuration_hash },
      undefined,
      tx,
    );
    return record;
  });
}

export async function revokeModelRouteApproval(runId: string, approvalId: string, reason: string, principal: AdminPrincipal) {
  if (!reason.trim()) throw new Error("请填写撤销依据");
  return sql.begin(async (tx) => {
    await requireOwner(principal, tx);
    const [run] = await tx<{ model_route_approvals: unknown }[]>`SELECT model_route_approvals FROM selectbench_runs WHERE id=${runId} FOR UPDATE`;
    const records = Array.isArray(run?.model_route_approvals) ? run.model_route_approvals : [];
    if (!records.some((r) => r.id === approvalId)) throw new Error("质量记录不存在");
    const next = records.map((r) => (r.id === approvalId ? { ...r, revoked: true } : r));
    await tx`UPDATE selectbench_runs SET model_route_approvals=${tx.json(next as never)} WHERE id=${runId}`;
    await audit(
      actorOf(principal),
      "models.backup.quality_revoke",
      runId,
      reason,
      { id: approvalId, revoked: false },
      { id: approvalId, revoked: true },
      undefined,
      tx,
    );
  });
}
