import { dbOf, type Db } from "../db.ts";
import { CAPABILITIES } from "../editorial/models.ts";
import { currentModelConfiguration } from "../admin/models.ts";
import { readStoredBackup, type StoredBackup } from "../admin/model-fallback.ts";
import { modelRegistryLock } from "./model-registry.ts";
import { backupAdmission, type BackupAdmission } from "./model-fallback-admission.ts";
import { logicalKeyFor, ProviderRejectedError, ReceiptUnknownError, ReceiptPhysicalLimitError, type ReceiptRequest } from "./receipts.ts";
import type { FallbackPermitPort } from "./model-fallback-permit.ts";
import type { PolicyFallbackContext } from "../policy/fallback-quality.ts";
import type { ChatJsonResult } from "./llm.ts";
const sql = dbOf("ai-gateway");
export class ModelFallbackBlocked extends Error {}
export class ModelContentFiltered extends Error {
  readonly receiptId: number;
  readonly attemptId: string | null;
  constructor(receiptId: number, attemptId: string | null) {
    super("content_filter：供应商拒答，保留已确认回执，不在原路由重试");
    this.receiptId = receiptId;
    this.attemptId = attemptId;
  }
}
export const isModelRouteWaiting = (error: unknown) =>
  error instanceof ModelFallbackBlocked || error instanceof ModelContentFiltered || error instanceof ReceiptPhysicalLimitError;
type Resolution = {
  route_revision: number;
  primary_receipt_id: number;
  primary_attempt_id: string;
  backup_model: string;
  backup_configuration_hash: string;
  permit_fingerprint: string;
  blocked_reason: string | null;
};
type Input = {
  request: ReceiptRequest;
  model: string;
  purpose: string;
  configurationHash: string;
  usagePurpose?: string;
  registeredProbe?: unknown;
  fallbackHop?: boolean;
  permit?: FallbackPermitPort;
  policy?: PolicyFallbackContext;
  contractHash: string;
  vision: boolean;
};
async function admission(input: Input, capability: string, db: Db) {
  await modelRegistryLock(db);
  const route = await readStoredBackup(capability, db);
  if (!route?.backup_model || route.blocked_reason) return null;
  const primary = await currentModelConfiguration(capability, db);
  if (
    primary.key !== input.model ||
    route.primary_model !== input.model ||
    primary.configuration_hash !== input.configurationHash ||
    route.primary_configuration_hash !== input.configurationHash
  )
    return null;
  const sources = input.permit?.sourceIds ?? [];
  if (!sources.length || sources.some((s) => !route.source_ids.includes(s))) return null;
  if (capability.startsWith("policy_") && !input.policy) return null;
  const approved = await backupAdmission(capability, route.backup_model, input.model, db, input.policy, sources);
  if (
    !approved ||
    approved.id !== route.approval_id ||
    approved.configurationHash !== route.backup_configuration_hash ||
    approved.connectionRevision !== route.backup_connection_revision ||
    sources.some((s) => !approved.sourceIds.includes(s)) ||
    (input.vision && !approved.vision) ||
    (approved.contracts !== null &&
      !approved.contracts.some(
        (c) => c.purpose === input.purpose && c.contractHash === input.contractHash && c.systemHash === input.request.requestSummary?.systemHash,
      ))
  )
    return null;
  return { route, approved };
}
async function proof(key: string, configurationHash: string, db: Db) {
  const [r] = await db<{ receiptId: number; attemptId: string; safe: boolean }[]>`SELECT r.id AS "receiptId",a.id::text AS "attemptId",
 ((a.status='failed' AND r.status='failed' AND a.failure_kind='connect_before_send' AND u.state='failed') OR
 (a.status='received' AND r.status IN ('received','completed','failed') AND a.response=r.response AND a.id=r.response_attempt_id AND a.response->'choices'->0->>'finish_reason'='content_filter' AND u.state='settled')) AS safe
 FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id AND a.attempt=r.attempts JOIN ai.model_attempt_snapshots s ON s.attempt_id=a.id
 JOIN ai.usage_attempts u ON u.attempt_id=a.id WHERE r.logical_key=${key} AND s.configuration_hash=${configurationHash} AND a.origin='live' AND r.origin='live'`;
  return r?.safe ? r : null;
}
async function resolution(key: string, db: Db) {
  const [r] = await db<
    Resolution[]
  >`SELECT route_revision,primary_receipt_id,primary_attempt_id::text,backup_model,backup_configuration_hash,permit_fingerprint,blocked_reason FROM ai.model_fallback_resolutions WHERE primary_key=${key} ORDER BY route_revision DESC LIMIT 1`;
  return r ?? null;
}
async function verifyResponse<T>(result: ChatJsonResult<T>, route: StoredBackup, approved: BackupAdmission, key: string) {
  const [p] = await sql<
    { model: string | null; response: Record<string, unknown>; configuration_hash: string }[]
  >`SELECT a.model,a.response,s.configuration_hash FROM receipts r JOIN receipt_attempts a ON a.id=r.response_attempt_id AND a.receipt_id=r.id AND a.attempt=r.attempts JOIN ai.model_attempt_snapshots s ON s.attempt_id=a.id
 WHERE r.id=${result.receiptId} AND a.id::text=${result.attemptId} AND a.status='received' AND a.response=r.response AND a.service=${route.backup_model}`;
  const reported = p?.response.model,
    fingerprint = typeof p?.response.system_fingerprint === "string" ? p.response.system_fingerprint : null;
  const accepted =
    p?.configuration_hash === approved.configurationHash &&
    p.model === approved.modelName &&
    typeof reported === "string" &&
    approved.reportedModels.includes(reported) &&
    approved.fingerprints.includes(fingerprint);
  await sql.begin(async (tx) => {
    await tx`UPDATE ai.model_fallback_resolutions SET backup_receipt_id=${result.receiptId},backup_attempt_id=${result.attemptId},blocked_reason=${accepted ? null : "备用接入实际响应模型或版本标记不符合质量记录，须重新评测"},updated_at=now() WHERE primary_key=${key} AND route_revision=${route.revision}`;
  });
  if (!accepted) throw new ModelFallbackBlocked("备用响应已保存，但模型身份与质量依据不一致，当前不采用");
}
/** One durable alternate decision. Neither a retry nor a new route can erase an unresolved alternate attempt. */
export async function withModelFallback<T>(
  input: Input,
  primary: () => Promise<ChatJsonResult<T>>,
  backup: (model: string, authorize: () => Promise<void>) => Promise<ChatJsonResult<T>>,
): Promise<ChatJsonResult<T>> {
  const capability = Object.entries(CAPABILITIES).find(([, c]) => (c.purposes as string[]).includes(input.purpose))?.[0];
  if (!capability || input.fallbackHop || input.registeredProbe || (input.usagePurpose && input.usagePurpose !== "production")) return primary();
  const key = logicalKeyFor(input.request),
    stored = await resolution(key, sql);
  if (!stored) {
    try {
      return await primary();
    } catch (error) {
      if (!(error instanceof ModelContentFiltered) && !(error instanceof ProviderRejectedError && error.failureKind === "connect_before_send")) throw error;
      const eligible = await sql.begin((tx) => admission(input, capability, tx));
      if (!eligible || !input.permit) throw error;
    }
  }
  if (!input.permit) throw new ModelFallbackBlocked("此任务尚无可重建的原始材料许可，保持待处理");
  const selected = await sql.begin((tx) => admission(input, capability, tx));
  if (
    !selected ||
    (stored && (stored.route_revision !== selected.route.revision || stored.backup_model !== selected.route.backup_model || stored.blocked_reason))
  )
    throw new ModelFallbackBlocked("已记录的备用决定当前不再合格，保留原回执并等待处理");
  const permit = await input.permit
    .authorize({ modelKey: selected.route.backup_model!, configurationHash: selected.approved.configurationHash })
    .catch((error) => {
      throw new ModelFallbackBlocked(error instanceof Error ? error.message : "备用来源许可未满足");
    });
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`model-fallback:${key}`}))`;
      const current = await admission(input, capability, tx),
        original = await proof(key, input.configurationHash, tx),
        prior = await resolution(key, tx);
      if (
        !current ||
        current.route.revision !== selected.route.revision ||
        !original ||
        (prior && (prior.route_revision !== selected.route.revision || prior.permit_fingerprint !== permit.inputFingerprint || prior.blocked_reason))
      )
        throw new ModelFallbackBlocked("主路由未有明确可安全回退证据，或备用配置已变化");
      await tx`INSERT INTO ai.model_fallback_resolutions(primary_key,route_revision,capability,primary_receipt_id,primary_attempt_id,backup_model,backup_configuration_hash,source_ids,permit_fingerprint)
    VALUES(${key},${selected.route.revision},${capability},${original.receiptId},${original.attemptId},${selected.route.backup_model!},${selected.approved.configurationHash},${[...input.permit!.sourceIds]},${permit.inputFingerprint}) ON CONFLICT DO NOTHING`;
    });
    const authorize = async () => {
      await permit.beforeRequest();
      const current = await sql.begin((tx) => admission(input, capability, tx));
      if (!current || current.route.revision !== selected.route.revision) throw new ModelFallbackBlocked("备用接入或质量资格已变更");
    };
    await authorize();
    let result: ChatJsonResult<T>;
    try {
      result = await backup(selected.route.backup_model!, authorize);
    } catch (error) {
      if (
        (error instanceof ProviderRejectedError || error instanceof ReceiptUnknownError || error instanceof ModelContentFiltered) &&
        error.receiptId !== null &&
        error.attemptId !== null
      )
        await sql`UPDATE ai.model_fallback_resolutions SET backup_receipt_id=${error.receiptId},backup_attempt_id=${error.attemptId},updated_at=now() WHERE primary_key=${key} AND route_revision=${selected.route.revision}`;
      throw error;
    }
    await authorize();
    await verifyResponse(result, selected.route, selected.approved, key);
    return result;
  } finally {
    permit.close();
  }
}
