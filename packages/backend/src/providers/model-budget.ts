import { modelConfigurationHash, type ConnectionConfig } from "./model-registry.ts";
import { sql, type Db } from "../db.ts";

/** Connections share the service behind their API origin; model name, key and URL path do not split its quota. */
export function modelBudgetService(endpoint: string, environmentService?: string): string {
  const url = new URL(endpoint),
    host = url.hostname.toLowerCase();
  const known: Record<string, string> = {
    "api.deepseek.com": "deepseek",
    "api.xiaomimimo.com": "mimo",
    "open.bigmodel.cn": "zhipu",
    "dashscope.aliyuncs.com": "dashscope",
    "dashscope-intl.aliyuncs.com": "dashscope",
    "dashscope-us.aliyuncs.com": "dashscope",
  };
  return known[host] ?? environmentService ?? `model:${url.host.toLowerCase()}`;
}
/** Explicit operator settings always win over initial values. Creating a connection makes its quota editable before testing it. */
export async function ensureModelBudget(service: string, db: Db = sql) {
  await db`INSERT INTO budgets(service,per_minute,per_hour,per_day,note) VALUES(${service},100,2000,20000,'模型服务共享请求次数；重试也计入') ON CONFLICT(service) DO NOTHING`;
}

/** Persist quota attribution even when the following send is held; old costs and logical keys remain untouched. */
export async function prepareModelQuota(
  service: string,
  billingService: string,
  snapshot?: { connection_id: string | null; configuration_hash: string },
  aliases: ModelQuotaAlias[] = [],
) {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"budget:" + service}))`;
    await ensureModelBudget(service, tx);
    const proven = [...aliases, ...(snapshot ? [{ service: billingService, ...snapshot }] : [])];
    for (const alias of proven)
      await tx`UPDATE receipt_attempts a SET quota_service=${service} FROM ai.model_attempt_snapshots s
      WHERE s.attempt_id=a.id AND s.connection_id IS NOT DISTINCT FROM ${alias.connection_id}::uuid
        AND s.configuration_hash=${alias.configuration_hash} AND a.service=${alias.service} AND a.quota_service IS NULL AND a.started_at>now()-interval '1 day'`;
  });
}

export type ModelQuotaAlias = { service: string; connection_id: string | null; configuration_hash: string };
/** Current non-secret connection metadata can prove which old request snapshots share a quota. */
export async function registeredQuotaAliases(service: string): Promise<ModelQuotaAlias[]> {
  const rows = await sql<{ id: string; config: ConnectionConfig }[]>`SELECT id,config FROM ai.model_connections`;
  return rows
    .filter((row) => modelBudgetService(row.config.endpoint, row.config.interface === "deepseek" ? "deepseek" : undefined) === service)
    .map((row) => ({ service: `registered:${row.id}`, connection_id: row.id, configuration_hash: modelConfigurationHash(row.config) }));
}
