import { ModelFallbackChange, ModelFallbackOverview, ModelFallbackRoute } from "@amp/contracts/http/private";
import { sql, type Db } from "../db.ts";
import { CAPABILITIES, modelSources } from "../editorial/models.ts";
import { modelConfigurationIdentity } from "./models.ts";
import { modelFallbackSources } from "./sources.ts";
import { actorOf, audit, requireCapability, type AdminPrincipal } from "./auth.ts";
import { modelRegistryLock, connectionRow } from "../providers/model-registry.ts";
import { backupAdmission } from "../providers/model-fallback-admission.ts";

export type StoredBackup = {
  capability: string;
  revision: number;
  primary_model: string;
  primary_configuration_hash: string | null;
  backup_model: string | null;
  backup_configuration_hash: string | null;
  backup_connection_revision: number | null;
  approval_kind: "selection" | "policy" | "capability" | null;
  approval_id: string | null;
  source_ids: string[];
  blocked_reason: string | null;
};
export async function readStoredBackup(capability: string, db: Db = sql) {
  const [r] = await db<
    StoredBackup[]
  >`SELECT capability,revision,primary_model,primary_configuration_hash,backup_model,backup_configuration_hash,backup_connection_revision,approval_kind,approval_id,source_ids,coalesce(r.blocked_reason,(SELECT x.blocked_reason FROM ai.model_fallback_resolutions x WHERE x.capability=r.capability AND x.route_revision=r.revision AND x.backup_model=r.backup_model AND x.backup_configuration_hash=r.backup_configuration_hash AND x.blocked_reason IS NOT NULL ORDER BY x.updated_at DESC LIMIT 1)) AS blocked_reason FROM ai.model_fallback_routes r WHERE capability=${capability}`;
  return r ?? null;
}
async function routeView(capability: string, db: Db) {
  const cap = CAPABILITIES[capability as keyof typeof CAPABILITIES],
    primary = (await modelSources(db))[capability]!.model,
    stored = await readStoredBackup(capability, db);
  const rows = await db<{ id: string }[]>`SELECT id FROM ai.model_connections ORDER BY created_at,id`;
  const choices = await Promise.all(
    rows.map(async ({ id }) => {
      const row = await connectionRow(id, db),
        model = `registered:${id}`,
        admission = await backupAdmission(capability, model, primary, db);
      const reason = ["group", "groupReview", "digest"].includes(capability)
        ? "尚缺衍生输入的原始修订绑定，当前只保留主路由"
        : model === primary
          ? "当前主模型，不能同时作为备用"
          : !row.enabled
            ? "接入已停用"
            : row.passed_revision !== row.revision
              ? "当前接入版本尚未通过连接测试"
              : "vision" in cap && cap.vision && !row.config.vision
                ? "此环节需要图像处理能力"
                : !admission
                  ? capability === "score"
                    ? "尚无主备同样本、同标准的负责人确认校准"
                    : capability.startsWith("policy_")
                      ? "尚无此实际配置对应的当前法规质量资格"
                      : "尚无此环节当前提示与实际配置的负责人质量确认"
                  : null;
      return {
        model,
        name: row.config.name,
        modelName: row.config.model,
        sourceIds: admission?.sourceIds ?? [],
        approvalKind: admission?.kind ?? null,
        eligible: !!admission,
        reason,
      };
    }),
  );
  let state: "none" | "ready" | "stale" | "blocked" = "none",
    detail: string | null = ["group", "groupReview", "digest"].includes(capability)
      ? "备用等待新产生衍生输入的来源修订绑定；旧产物缺少证明不会借用当前材料。"
      : capability === "understand"
        ? "当前备用仅用于已有材料许可绑定的纯文本输入；图片任务继续使用主路由。"
        : null;
  if (stored?.backup_model) {
    const current = await modelConfigurationIdentity(primary, db),
      admission = await backupAdmission(capability, stored.backup_model, primary, db);
    const valid =
      current.key === stored.primary_model &&
      current.configuration_hash === stored.primary_configuration_hash &&
      admission?.configurationHash === stored.backup_configuration_hash &&
      admission?.connectionRevision === stored.backup_connection_revision &&
      admission.id === stored.approval_id &&
      stored.source_ids.every((s) => admission.sourceIds.includes(s));
    state = stored.blocked_reason ? "blocked" : valid ? "ready" : "stale";
    detail = stored.blocked_reason ?? (valid ? null : "主备配置或质量资格已变化；当前不会自动回退，请重新选择。");
  }
  return ModelFallbackRoute.parse({
    capability,
    label: cap.label,
    revision: stored?.revision ?? 0,
    primaryModel: primary,
    backupModel: stored?.backup_model ?? null,
    sourceIds: stored?.source_ids ?? [],
    state,
    detail,
    choices,
  });
}
export async function modelFallbacks(principal: AdminPrincipal) {
  return sql.begin(async (tx) => {
    await requireCapability(principal, "models.manage", tx);
    await modelRegistryLock(tx);
    return ModelFallbackOverview.parse({
      routes: await Promise.all(Object.keys(CAPABILITIES).map((c) => routeView(c, tx))),
      sources: await modelFallbackSources(tx),
    });
  });
}
export async function changeModelFallback(capability: string, input: unknown, principal: AdminPrincipal) {
  const parsed = ModelFallbackChange.safeParse(input);
  if (!parsed.success || !Object.hasOwn(CAPABILITIES, capability)) throw Object.assign(new Error("请选择有效的处理环节、备用接入和来源"), { statusCode: 400 });
  const value = parsed.data;
  return sql.begin(async (tx) => {
    await requireCapability(principal, "models.manage", tx);
    await modelRegistryLock(tx, true);
    const before = await readStoredBackup(capability, tx);
    if ((before?.revision ?? 0) !== value.expected_revision)
      throw Object.assign(new Error("主备配置已被其他操作修改，请刷新后重新选择"), { statusCode: 409, code: "conflict" });
    const primary = await modelConfigurationIdentity((await modelSources(tx))[capability]!.model, tx),
      admission = value.backup_model ? await backupAdmission(capability, value.backup_model, primary.key, tx) : null;
    if (value.backup_model && (!primary.configuration_hash || !admission || value.source_ids.some((s) => !admission.sourceIds.includes(s))))
      throw Object.assign(new Error("备用接入、当前质量资格或指定来源尚不满足此环节条件"), { statusCode: 409, code: "conflict" });
    const available = await modelFallbackSources(tx),
      lane = capability.startsWith("policy_") ? "policy" : "news";
    if (value.source_ids.some((id) => !available.some((s) => s.id === id && s.lane === lane)))
      throw Object.assign(new Error("来源不存在或不属于此业务线"), { statusCode: 400 });
    await tx`INSERT INTO ai.model_fallback_routes(capability,revision,primary_model,primary_configuration_hash,backup_model,backup_configuration_hash,backup_connection_revision,approval_kind,approval_id,source_ids)
   VALUES(${capability},${value.expected_revision + 1},${primary.key},${primary.configuration_hash},${value.backup_model},${admission?.configurationHash ?? null},${admission?.connectionRevision ?? null},${admission?.kind ?? null},${admission?.id ?? null},${value.source_ids})
   ON CONFLICT(capability) DO UPDATE SET revision=EXCLUDED.revision,primary_model=EXCLUDED.primary_model,primary_configuration_hash=EXCLUDED.primary_configuration_hash,backup_model=EXCLUDED.backup_model,backup_configuration_hash=EXCLUDED.backup_configuration_hash,backup_connection_revision=EXCLUDED.backup_connection_revision,approval_kind=EXCLUDED.approval_kind,approval_id=EXCLUDED.approval_id,source_ids=EXCLUDED.source_ids,blocked_reason=NULL,updated_at=now()`;
    await audit(actorOf(principal), "models.backup.change", capability, value.reason, before, await readStoredBackup(capability, tx), undefined, tx);
    return routeView(capability, tx);
  });
}
/** Assigned backup configurations have the same edit/disable protection as their primary counterparts. */
export async function hasAssignedBackup(key: string, db: Db = sql) {
  const [r] = await db`SELECT capability FROM ai.model_fallback_routes WHERE backup_model=${key} LIMIT 1`;
  return !!r;
}
