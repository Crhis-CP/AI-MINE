import { environmentValue } from "../config.ts";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  ModelConnectionConfig,
  ModelConnectionCreate,
  ModelConnectionUpdate,
  ModelConnectionDisable,
  ModelConnectionProbe,
  ModelProbeRecord,
  ModelRouteChange,
} from "@amp/contracts/http/private";
import { dbOf, type Db } from "../db.ts";
import { audit, actorOf, requireCapability, requireOwner, type AdminPrincipal } from "./auth.ts";
import { CAPABILITIES, invalidateModelCache, type Capability } from "../editorial/models.ts";
import {
  modelConfigurationHash,
  connectionRow,
  connectionRecord,
  modelRegistryLock,
  registeredModelKey,
  registeredModelId,
  ModelRegistryConflict,
  ModelConnectionUnavailable,
} from "../providers/model-registry.ts";
import { sealModelSecret, modelStorageReady } from "../providers/model-vault.ts";
import { requireRuntimeRunning } from "../operations/lane-controls.ts";
const sql = dbOf("ai-gateway");
export type ModelRegistryGuards = { manage(principal: AdminPrincipal, db: Db): Promise<void>; owner(principal: AdminPrincipal, db: Db): Promise<void> };
const defaultGuards: ModelRegistryGuards = { manage: (principal, db) => requireCapability(principal, "models.manage", db), owner: requireOwner };
const parse = <S extends z.ZodType>(schema: S, value: unknown): z.infer<S> => {
  const result = schema.safeParse(value);
  if (!result.success) throw Object.assign(new Error("模型接入参数不完整或格式无效"), { statusCode: 400 });
  return result.data;
};
const checkRevision = (actual: number, expected: number) => {
  if (actual !== expected) throw new ModelRegistryConflict("接入版本已变更，请刷新后再操作");
};
export async function listModelConnections(principal: AdminPrincipal, guards = defaultGuards) {
  await guards.manage(principal, sql);
  const rows = await sql<{ id: string }[]>`SELECT id FROM ai.model_connections ORDER BY created_at,id`;
  return {
    storage: modelStorageReady() ? ("ready" as const) : ("storage_unavailable" as const),
    connections: await Promise.all(rows.map(async (r) => connectionRecord(await connectionRow(r.id)))),
  };
}
export async function createModelConnection(input: unknown, principal: AdminPrincipal, guards = defaultGuards) {
  const value = parse(ModelConnectionCreate, input),
    id = randomUUID(),
    secretId = randomUUID();
  return sql.begin(async (tx) => {
    await guards.owner(principal, tx);
    await modelRegistryLock(tx, true);
    const sealed = sealModelSecret(value.secret, `${id}:${secretId}`),
      config = ModelConnectionConfig.strip().parse(value);
    await tx`INSERT INTO ai.model_connections(id,config,secret_id,sealed_secret,fingerprint) VALUES(${id},${tx.json(config)},${secretId},${tx.json(sealed)},${sealed.fingerprint})`;
    const record = await connectionRecord(await connectionRow(id, tx), tx);
    await audit(actorOf(principal), "models.connection.create", id, value.reason, null, { ...record, supplier_basis: value.supplier_basis }, undefined, tx);
    return record;
  });
}
export async function updateModelConnection(id: string, input: unknown, principal: AdminPrincipal, guards = defaultGuards) {
  const value = parse(ModelConnectionUpdate, input);
  return sql.begin(async (tx) => {
    await guards.manage(principal, tx);
    await modelRegistryLock(tx, true);
    const before = await connectionRow(id, tx);
    checkRevision(before.revision, value.expected_revision);
    const protectedChange = !!value.secret || value.endpoint !== before.config.endpoint || value.interface !== before.config.interface;
    if (protectedChange) {
      await guards.owner(principal, tx);
      if (!value.owner_confirmed || !value.supplier_basis) throw new ModelConnectionUnavailable("密钥或供应商变更须负责人确认并提供依据");
    }
    const config = ModelConnectionConfig.strip().parse(value);
    if (modelConfigurationHash(config) !== modelConfigurationHash(before.config) || value.enabled === false) {
      const [assigned] = await tx`SELECT key FROM settings WHERE key LIKE 'models.%' AND value->>'model'=${registeredModelKey(id)} LIMIT 1`;
      if (assigned || Object.values(CAPABILITIES).some((c) => environmentValue(c.env) === registeredModelKey(id)))
        throw new ModelConnectionUnavailable("请先切换使用此接入的环节，再修改运行配置或停用");
    }
    const secretId = value.secret ? randomUUID() : before.secret_id;
    const sealed = value.secret ? sealModelSecret(value.secret, `${id}:${secretId}`) : before.sealed_secret;
    await tx`UPDATE ai.model_connections SET revision=revision+1,enabled=${value.enabled ?? before.enabled},config=${tx.json(config)},secret_id=${secretId},sealed_secret=${tx.json(sealed)},fingerprint=${sealed.fingerprint},passed_revision=NULL,tested_at=NULL,updated_at=now() WHERE id=${id} AND revision=${before.revision}`;
    const record = await connectionRecord(await connectionRow(id, tx), tx);
    await audit(
      actorOf(principal),
      value.secret ? "models.connection.replace_secret" : "models.connection.edit",
      id,
      value.reason,
      await connectionRecord(before, tx),
      record,
      undefined,
      tx,
    );
    return record;
  });
}
export async function disableModelConnection(id: string, input: unknown, principal: AdminPrincipal, guards = defaultGuards) {
  const value = parse(ModelConnectionDisable, input);
  return sql.begin(async (tx) => {
    await guards.manage(principal, tx);
    await modelRegistryLock(tx, true);
    const before = await connectionRow(id, tx),
      key = registeredModelKey(id);
    checkRevision(before.revision, value.expected_revision);
    const [assigned] = await tx`SELECT key FROM settings WHERE key LIKE 'models.%' AND value->>'model'=${key} LIMIT 1`;
    const envAssigned = Object.values(CAPABILITIES).some((c) => environmentValue(c.env) === key);
    if (assigned || envAssigned) throw new ModelConnectionUnavailable("请先将使用此接入的环节切换到其他模型");
    await tx`UPDATE ai.model_connections SET enabled=false,revision=revision+1,passed_revision=NULL,updated_at=now() WHERE id=${id}`;
    const record = await connectionRecord(await connectionRow(id, tx), tx);
    await audit(actorOf(principal), "models.connection.disable", id, value.reason, await connectionRecord(before, tx), record, undefined, tx);
    return record;
  });
}
export async function modelProbeRecord(id: string, db: Db = sql) {
  const [row] = await db<
    {
      id: string;
      connection_id: string;
      revision: number;
      lane: string;
      status: string;
      detail: string | null;
      receipt_id: string | null;
      created_at: Date;
      finished_at: Date | null;
    }[]
  >`SELECT id,connection_id,revision,lane,status,detail,receipt_id::text,created_at,finished_at FROM ai.model_connection_tests WHERE id=${id}`;
  if (!row) throw new ModelConnectionUnavailable("连接测试不存在");
  return ModelProbeRecord.parse({ ...row, created_at: row.created_at.toISOString(), finished_at: row.finished_at?.toISOString() ?? null });
}
export async function readModelConnectionProbe(id: string, principal: AdminPrincipal, guards = defaultGuards) {
  await guards.manage(principal, sql);
  return modelProbeRecord(id);
}
/** A durable request only. The HTTP composition root enqueues this id; only a worker invokes the gateway. */
export async function requestModelConnectionProbe(id: string, input: unknown, principal: AdminPrincipal, guards = defaultGuards) {
  const value = parse(ModelConnectionProbe, input);
  return sql.begin(async (tx) => {
    await guards.manage(principal, tx);
    await modelRegistryLock(tx, true);
    await requireRuntimeRunning(value.lane, ["processing"], tx);
    const row = await connectionRow(id, tx);
    checkRevision(row.revision, value.expected_revision);
    if (!row.enabled || !modelStorageReady()) throw new ModelConnectionUnavailable("接入已停用或密钥保护配置不可用");
    const [pending] = await tx<{ id: string }[]>`SELECT t.id FROM ai.model_connection_tests t LEFT JOIN receipts r ON r.id=t.receipt_id
      WHERE t.connection_id=${id} AND (t.status IN ('queued','running','paused') OR (t.status='unknown' AND (r.id IS NULL OR r.status<>'failed' OR r.response IS NOT NULL))) ORDER BY t.created_at LIMIT 1`;
    if (pending) return modelProbeRecord(pending.id, tx);
    const testId = randomUUID();
    await tx`INSERT INTO ai.model_connection_tests(id,connection_id,revision,lane,status,actor) VALUES(${testId},${id},${row.revision},${value.lane},'queued',${actorOf(principal)})`;
    await audit(
      actorOf(principal),
      "models.connection.test_requested",
      id,
      "连接测试",
      null,
      { testId, revision: row.revision, lane: value.lane },
      undefined,
      tx,
    );
    return modelProbeRecord(testId, tx);
  });
}
export async function assignRegisteredModel(capability: string, input: unknown, principal: AdminPrincipal, guards = defaultGuards) {
  const value = parse(ModelRouteChange, input),
    c: Capability | undefined = (CAPABILITIES as Record<string, Capability>)[capability],
    id = registeredModelId(value.model);
  if (!c || !id) throw new ModelConnectionUnavailable("请选择已登记并通过连接测试的模型");
  const result = await sql.begin(async (tx) => {
    await guards.manage(principal, tx);
    await modelRegistryLock(tx, true);
    const row = await connectionRow(id, tx);
    if (!row.enabled || row.passed_revision !== row.revision || (!!c.vision && !row.config.vision))
      throw new ModelConnectionUnavailable("接入尚未满足本环节的可用条件");
    const [route] = await tx<{ revision: number }[]>`SELECT revision FROM ai.model_routes WHERE capability=${capability}`;
    checkRevision(route?.revision ?? 0, value.expected_revision);
    const [prior] = await tx<{ value: { model?: string } }[]>`SELECT value FROM settings WHERE key=${`models.${capability}`}`;
    const previous = prior?.value.model ?? environmentValue(c.env) ?? c.default;
    if (value.evaluation_id) {
      const [run] = await tx<
        { models: string[]; sample_size: number; summary: { model_configurations?: Record<string, string> } }[]
      >`SELECT models,sample_size,summary FROM selectbench_runs WHERE id=${value.evaluation_id}`;
      if (
        !run ||
        run.sample_size < 1 ||
        !run.models.includes(value.model) ||
        run.summary.model_configurations?.[value.model] !== modelConfigurationHash(row.config)
      )
        throw new ModelConnectionUnavailable("未找到与此模型对应的评测依据");
      if (capability === "score") {
        const previousId = registeredModelId(previous);
        if (previousId && run.summary.model_configurations?.[previous] !== modelConfigurationHash((await connectionRow(previousId, tx)).config))
          throw new ModelConnectionUnavailable("原模型的评测配置版本不匹配");
        const cases = await tx<
          { model: string; case_id: string }[]
        >`SELECT model,case_id FROM selectbench_results WHERE run_id=${value.evaluation_id} AND model IN (${previous},${value.model}) AND error IS NULL AND decision IS NOT NULL`;
        const oldCases = cases
            .filter((r) => r.model === previous)
            .map((r) => r.case_id)
            .sort(),
          newCases = cases
            .filter((r) => r.model === value.model)
            .map((r) => r.case_id)
            .sort();
        if (!run.models.includes(previous) || oldCases.length !== run.sample_size || JSON.stringify(oldCases) !== JSON.stringify(newCases))
          throw new ModelConnectionUnavailable("精选评分切换须先完成同一批校准样本的比较");
      }
    } else {
      if (!value.emergency_confirmed || capability === "score") throw new ModelConnectionUnavailable("缺少评测依据；评分不得紧急跳过校准比较");
      await guards.owner(principal, tx);
    }
    const revision = (route?.revision ?? 0) + 1;
    await tx`INSERT INTO ai.model_routes(capability,revision,model_key,connection_revision,evaluation_id,unevaluated) VALUES(${capability},${revision},${value.model},${row.revision},${value.evaluation_id},${!value.evaluation_id}) ON CONFLICT(capability) DO UPDATE SET revision=EXCLUDED.revision,model_key=EXCLUDED.model_key,connection_revision=EXCLUDED.connection_revision,evaluation_id=EXCLUDED.evaluation_id,unevaluated=EXCLUDED.unevaluated,updated_at=now()`;
    await tx`INSERT INTO settings(key,value,updated_by) VALUES(${`models.${capability}`},${tx.json({ model: value.model })},${actorOf(principal)}) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=now()`;
    const output = { capability, model: value.model, revision, unevaluated: !value.evaluation_id };
    await audit(
      actorOf(principal),
      "models.switch",
      `capability:${capability}`,
      value.reason,
      { model: previous },
      { ...output, evaluation_id: value.evaluation_id },
      undefined,
      tx,
    );
    return output;
  });
  invalidateModelCache();
  return result;
}
export async function modelRouteRevisions() {
  return sql<
    { capability: string; revision: number; model_key: string; unevaluated: boolean }[]
  >`SELECT capability,revision,model_key,unevaluated FROM ai.model_routes`;
}
