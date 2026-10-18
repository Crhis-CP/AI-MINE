import { modelBudgetService } from "./model-budget.ts";
import { environmentModelMetadata } from "./llm.ts";
import { sql, type Db } from "../db.ts";
import { CAPABILITIES } from "../editorial/models.ts";
import { connectionRow, registeredModelId, modelConfigurationHash, type ConnectionConfig } from "./model-registry.ts";
import { modelConfigurationIdentity } from "../admin/models.ts";
import { readModelRouteApproval } from "./model-fallback-quality.ts";
import { policyFallbackQuality, type PolicyFallbackContext } from "../policy/fallback-quality.ts";
import { policyModelQualificationKey } from "../policy/model-evidence.ts";

export type BackupAdmission = {
  kind: "selection" | "policy" | "capability";
  id: string;
  sourceIds: string[];
  configurationHash: string;
  connectionRevision: number;
  reportedModels: string[];
  fingerprints: (string | null)[];
  contracts: { purpose: string; contractHash: string; systemHash: string }[] | null;
  vision: boolean;
  name: string;
  modelName: string;
};
export async function modelService(key: string, db: Db): Promise<string | null> {
  const id = registeredModelId(key);
  if (id) {
    const row = await connectionRow(id, db);
    return modelBudgetService(row.config.endpoint, row.config.interface === "deepseek" ? "deepseek" : undefined);
  }
  const configured = environmentModelMetadata(key);
  return configured && "budgetService" in configured ? configured.budgetService : null;
}
/** A fallback must survive the primary service failing; another model on the same service cannot do so. */
export async function differentModelServices(primaryKey: string, backupConfig: ConnectionConfig, db: Db): Promise<boolean> {
  const primaryService = await modelService(primaryKey, db);
  const backupService = modelBudgetService(backupConfig.endpoint, backupConfig.interface === "deepseek" ? "deepseek" : undefined);
  return !!primaryService && primaryService !== backupService;
}
export async function backupAdmission(
  capability: string,
  key: string,
  primaryKey: string,
  db: Db = sql,
  context?: PolicyFallbackContext,
  sourceIds: readonly string[] = [],
): Promise<BackupAdmission | null> {
  const id = registeredModelId(key),
    cap = CAPABILITIES[capability as keyof typeof CAPABILITIES];
  if (!id || !cap || key === primaryKey) return null;
  const row = await connectionRow(id, db),
    cfg = modelConfigurationHash(row.config);
  if (!(await differentModelServices(primaryKey, row.config, db))) return null;
  if (!row.enabled || row.passed_revision !== row.revision || ("vision" in cap && cap.vision && !row.config.vision)) return null;
  const [probe] = await db<
    { receiptId: number; attemptId: string; reported: string; fingerprint: string | null }[]
  >`SELECT r.id AS "receiptId",a.id::text AS "attemptId",a.response->>'model' AS reported,a.response->>'system_fingerprint' AS fingerprint
 FROM ai.model_connection_tests t JOIN receipts r ON r.id=t.receipt_id JOIN receipt_attempts a ON a.id=t.attempt_id AND a.receipt_id=r.id
 JOIN ai.model_attempt_snapshots s ON s.attempt_id=a.id
 WHERE t.connection_id=${id} AND t.revision=${row.revision} AND t.status='passed' AND a.status='received' AND a.response IS NOT NULL
 AND s.connection_id=${id} AND s.connection_revision=${row.revision} AND s.configuration_hash=${cfg}
 AND a.service=${key} AND a.model=${row.config.model} ORDER BY t.finished_at DESC LIMIT 1`;
  if (!probe?.reported?.trim()) return null;
  const base = {
    configurationHash: cfg,
    connectionRevision: row.revision,
    reportedModels: [probe.reported],
    fingerprints: [probe.fingerprint],
    contracts: null,
    vision: row.config.vision,
    name: row.config.name,
    modelName: row.config.model,
  };
  if (capability.startsWith("policy_")) {
    const model = policyModelQualificationKey({
      receiptId: probe.receiptId,
      attemptId: probe.attemptId,
      service: key,
      requestedModel: row.config.model,
      reportedModel: probe.reported,
      configurationHash: cfg,
      connectionId: id,
      connectionRevision: row.revision,
    });
    if (!model) return null;
    const release = await policyFallbackQuality(model, context, sourceIds, db);
    return release ? { ...base, kind: "policy", id: model, sourceIds: release.source_ids } : null;
  }
  if (capability === "score") {
    const { readApprovedSelectionCalibration } = await import("../admin/selectbench.ts");
    const primary = await modelConfigurationIdentity(primaryKey, db);
    if (!primary.configuration_hash) return null;
    const a = await readApprovedSelectionCalibration({ modelKey: key, configurationHash: cfg }, db),
      b = await readApprovedSelectionCalibration({ modelKey: primaryKey, configurationHash: primary.configuration_hash }, db);
    if (
      !a ||
      !b ||
      ["datasetId", "datasetVersion", "standardVersion", "prefilterVersion", "thresholdVersion"].some((k) => a[k as keyof typeof a] !== b[k as keyof typeof b])
    )
      return null;
    return { ...base, kind: "selection", id: a.recordId, sourceIds: a.sourceIds.filter((s) => b.sourceIds.includes(s)) };
  }
  const approved = await readModelRouteApproval(capability, key, cfg, db);
  return approved
    ? {
        ...base,
        kind: "capability",
        id: approved.id,
        sourceIds: approved.sourceIds,
        contracts: approved.contracts,
        reportedModels: approved.reportedModels,
        fingerprints: approved.fingerprints,
      }
    : null;
}
