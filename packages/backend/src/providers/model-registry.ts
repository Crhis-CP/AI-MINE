import { sha256, stableJson } from "../lib/ids.ts";
import { ModelConnectionConfig, ModelConnectionRecord } from "@amp/contracts/http/private";
import type { z } from "zod";
import { dbOf, type Db } from "../db.ts";
import { openModelSecret, type SealedModelSecret } from "./model-vault.ts";
const sql = dbOf("ai-gateway");
export const modelConfigurationHash = (config: z.infer<typeof ModelConnectionConfig>) =>
  sha256(stableJson([config.interface, config.endpoint, config.model, config.vision, config.json_mode]));
export type ConnectionConfig = z.infer<typeof ModelConnectionConfig>;
export type ConnectionRow = {
  id: string;
  revision: number;
  config: ConnectionConfig;
  enabled: boolean;
  secret_id: string;
  sealed_secret: SealedModelSecret;
  fingerprint: string;
  passed_revision: number | null;
  tested_at: Date | null;
  updated_at: Date;
};
export class ModelRegistryConflict extends Error {
  readonly code = "conflict";
}
export class ModelConnectionUnavailable extends Error {
  readonly statusCode = 409;
  readonly code = "conflict";
}
export const registeredModelId = (key: string) => /^registered:([0-9a-f-]{36})$/.exec(key)?.[1] ?? null;
export const registeredModelKey = (id: string) => `registered:${id}`;
export const modelRegistryLock = async (db: Db, exclusive = false) => {
  if (exclusive) await db`SELECT pg_advisory_xact_lock(hashtext('model-registry'))`;
  else await db`SELECT pg_advisory_xact_lock_shared(hashtext('model-registry'))`;
};
export async function connectionRow(id: string, db: Db = sql): Promise<ConnectionRow> {
  const [row] = await db<
    ConnectionRow[]
  >`SELECT id,revision,config,enabled,secret_id,sealed_secret,fingerprint,passed_revision,tested_at,updated_at FROM ai.model_connections WHERE id=${id}`;
  if (!row) throw new ModelConnectionUnavailable("模型接入不存在");
  ModelConnectionConfig.parse(row.config);
  return row;
}
export async function connectionRecord(row: ConnectionRow, db: Db = sql) {
  const [test] = await db<
    { status: string }[]
  >`SELECT status FROM ai.model_connection_tests WHERE connection_id=${row.id} AND revision=${row.revision} ORDER BY created_at DESC LIMIT 1`;
  return ModelConnectionRecord.parse({
    ...row.config,
    id: row.id,
    key: registeredModelKey(row.id),
    revision: row.revision,
    enabled: row.enabled,
    fingerprint: row.fingerprint,
    configuration_hash: modelConfigurationHash(row.config),
    test_status: row.passed_revision === row.revision ? "passed" : (test?.status ?? "untested"),
    tested_at: row.tested_at?.toISOString() ?? null,
    updated_at: row.updated_at.toISOString(),
  });
}
/** Metadata only: capability routing can inspect vision without ever opening a secret. */
export async function registeredModelSpec(key: string) {
  const id = registeredModelId(key);
  if (!id) return null;
  const row = await connectionRow(id);
  if (!row.enabled || row.passed_revision !== row.revision) throw new ModelConnectionUnavailable("模型接入已停用或当前版本尚未通过测试");
  return { key, service: `registered:${id}`, model: row.config.model, jsonMode: row.config.json_mode, vision: row.config.vision };
}
export type RegisteredAccess = { probeId: string; revision: number };
export async function resolveRegisteredModel(key: string, probe?: RegisteredAccess) {
  const id = registeredModelId(key);
  if (!id) return null;
  const row = await connectionRow(id);
  if (!row.enabled) throw new ModelConnectionUnavailable("模型接入已停用");
  if (probe) {
    const [test] =
      await sql`SELECT id FROM ai.model_connection_tests WHERE id=${probe.probeId} AND connection_id=${id} AND revision=${row.revision} AND revision=${probe.revision} AND status IN ('queued','running','paused')`;
    if (!test) throw new ModelConnectionUnavailable("连接测试版本已变化");
  } else if (row.passed_revision !== row.revision) throw new ModelConnectionUnavailable("当前模型版本尚未通过连接测试");
  const apiKey = openModelSecret(row.sealed_secret, `${row.id}:${row.secret_id}`);
  return {
    key,
    service: `registered:${id}`,
    model: row.config.model,
    jsonMode: row.config.json_mode,
    vision: row.config.vision,
    baseUrl: row.config.endpoint,
    apiKey,
    config: row.config,
    revision: row.revision,
    id,
    fingerprint: row.fingerprint,
    configuration_hash: modelConfigurationHash(row.config),
    async assertCurrent(db: Db = sql) {
      await modelRegistryLock(db);
      const current = await connectionRow(id, db);
      if (
        !current.enabled ||
        current.revision !== row.revision ||
        current.secret_id !== row.secret_id ||
        (!probe && current.passed_revision !== current.revision)
      )
        throw new ModelConnectionUnavailable("模型配置或密钥已变更，请重新取得当前任务配置");
    },
  };
}
