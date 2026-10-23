import { registeredModelId, registeredModelSpec, connectionRow, modelConfigurationHash, modelRegistryLock } from "../providers/model-registry.ts";
import { audit, modelSwitchHistory } from "./auth.ts";
// Admin "模型与评测": the model each capability uses and where that choice comes from,
// the prompt versions in use, quality / latency / cost of the last days per model, the switch history
// and the SelectBench runs that compare models on the same batch. A switch is audited and applies to
// new work only.
import { sql, type Db } from "../db.ts";
import { CAPABILITIES, invalidateModelCache, modelSources, type Capability, type CapabilityKey } from "../editorial/models.ts";
import { BUILTIN_MODEL_FAMILIES, MODELS, environmentModelMetadata, modelPresetReady } from "../providers/llm.ts";

import { modelRouteRevisions } from "./model-registry.ts";

interface UsageRow {
  service: string;
  estimated_cost: string | null;
  unpriced_calls: number;
  purpose: string;
  model: string | null;
  prompt_version: string | null;
  calls: number;
  ok: number;
  failed: number;
  unknown: number;
  p50: number | null;
  p95: number | null;
  tokens_in: string | null;
  tokens_out: string | null;
  actual_cost: string | null;
  currency: string | null;
}

export async function modelsOverview(days = 7) {
  const since = new Date(Date.now() - days * 86400_000);
  const [sources, usage, history, benches, connections] = await Promise.all([
    modelSources(),
    sql<UsageRow[]>`
      SELECT r.purpose, a.model, r.request->>'promptVersion' AS prompt_version,a.service, count(*)::int AS calls,
             count(*) FILTER (WHERE a.status = 'received')::int AS ok,
             count(*) FILTER (WHERE a.status = 'failed')::int AS failed,
             count(*) FILTER (WHERE a.status = 'unknown')::int AS unknown,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY a.latency_ms) AS p50,
             percentile_disc(0.95) WITHIN GROUP (ORDER BY a.latency_ms) AS p95,
             sum((a.usage->>'prompt_tokens')::bigint) AS tokens_in, sum((a.usage->>'completion_tokens')::bigint) AS tokens_out,
             sum(a.cost) FILTER (WHERE a.cost_basis = 'actual' AND a.currency IS NOT NULL AND trim(a.currency)<>'') AS actual_cost,
             sum(a.cost) FILTER (WHERE a.cost_basis = 'estimated' AND a.currency IS NOT NULL AND trim(a.currency)<>'') AS estimated_cost,
             count(*) FILTER (WHERE a.cost IS NULL OR a.currency IS NULL OR trim(a.currency)=''
               OR coalesce(a.cost_basis,'') NOT IN ('actual','estimated'))::int AS unpriced_calls,a.currency
      FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id
      WHERE a.started_at >= ${since} AND a.origin = 'live' AND a.model IS NOT NULL
      GROUP BY 1, 2, 3, 4,a.currency ORDER BY 1,calls DESC`,
    modelSwitchHistory(),
    sql<{ id: string; label: string; sample_size: number; prompt_version: string | null; models: string[]; summary: unknown; created_at: Date }[]>`
      SELECT id, label, sample_size, prompt_version, models,
             (SELECT coalesce(jsonb_object_agg(key, value - 'sweep'), '{}'::jsonb) FROM jsonb_each(r.summary)) AS summary,
             created_at FROM selectbench_runs r ORDER BY created_at DESC LIMIT 8`,
    sql<{ id: string; name: string }[]>`SELECT id::text,config->>'name' AS name FROM ai.model_connections`,
  ]);
  const routeRevisions = await modelRouteRevisions();
  const connectionNames = new Map(connections.map((c) => [`registered:${c.id}`, c.name]));
  const capabilities = (Object.entries(CAPABILITIES) as Array<[CapabilityKey, Capability]>).map(([key, c]) => ({
    key,
    label: c.label,
    env: c.env,
    defaultModel: c.default,
    vision: !!c.vision,
    current: sources[key]!,
    routeRevision: routeRevisions.find((r) => r.capability === key)?.revision ?? 0,
    unevaluated: routeRevisions.find((r) => r.capability === key)?.unevaluated ?? false,
    usage: usage
      .filter((u) => c.purposes.includes(u.purpose))
      .map((u) => ({
        purpose: u.purpose,
        service: u.service,
        serviceName: connectionNames.get(u.service) ?? (u.service.startsWith("registered:") ? "自定义模型接入" : u.service),
        unpricedCalls: u.unpriced_calls,
        model: u.model,
        promptVersion: u.prompt_version,
        calls: u.calls,
        ok: u.ok,
        failed: u.failed,
        unknown: u.unknown,
        p50: u.p50,
        p95: u.p95,
        tokensIn: Number(u.tokens_in ?? 0),
        tokensOut: Number(u.tokens_out ?? 0),
        actualCost: u.actual_cost === null ? null : Number(u.actual_cost),
        currency: u.currency,
        estimate: u.estimated_cost !== null && u.currency ? { amount: Number(u.estimated_cost), currency: u.currency } : null,
      })),
  }));
  const choices = Object.values(MODELS).map((m) => ({ ...environmentModelMetadata(m.key)!, ready: modelPresetReady(m.key) }));
  const families = BUILTIN_MODEL_FAMILIES.map((family) => ({
    id: family.id,
    label: family.label,
    duty: family.duty,
    presets: family.presets.map((key) => ({ ...environmentModelMetadata(key)!, ready: modelPresetReady(key) })),
  }));
  return { days, capabilities, choices, families, deploymentReady: modelPresetReady("default"), history, benches };
}

/** Select a configured model; switches apply to subsequent work and preserve existing results. */
export async function switchModel(capability: string, model: string | null, reason: string, actor: string) {
  const c = (CAPABILITIES as Record<string, Capability>)[capability];
  if (!c) throw Object.assign(new Error("没有这个处理环节"), { statusCode: 400 });
  if (!reason.trim()) throw Object.assign(new Error("请填写切换原因"), { statusCode: 400 });
  const result = await sql.begin(async (tx) => {
    await modelRegistryLock(tx, true);
    if (model !== null) {
      const spec = registeredModelId(model) ? await registeredModelSpec(model) : MODELS[model];
      if (!spec) throw Object.assign(new Error("请选择已经配置的模型"), { statusCode: 400 });
      if (c.vision && !spec.vision) throw Object.assign(new Error("这个环节需要能看图的模型"), { statusCode: 400 });
      if (!registeredModelId(model) && !modelPresetReady(model))
        throw Object.assign(new Error("这个模型当前还没有可用的接口，不能切换过去"), { statusCode: 400 });
    }
    const before = (await modelSources(tx))[capability];
    if (model === null) await tx`DELETE FROM settings WHERE key = ${`models.${capability}`}`;
    else
      await tx`INSERT INTO settings (key,value,updated_by) VALUES(${`models.${capability}`},${tx.json({ model })},${actor})
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=now()`;
    const after = (await modelSources(tx))[capability]!;
    const chosenModel = String(after.model);
    const connectionId = registeredModelId(chosenModel);
    const connectionRevision = connectionId ? (await connectionRow(connectionId, tx)).revision : 0;
    // Legacy switches advance the shared revision, so a stale registered-model form cannot undo them.
    await tx`INSERT INTO ai.model_routes(capability,revision,model_key,connection_revision,evaluation_id,unevaluated)
      VALUES(${capability},1,${chosenModel},${connectionRevision},NULL,${!!connectionId})
      ON CONFLICT(capability) DO UPDATE SET revision=ai.model_routes.revision+1,model_key=EXCLUDED.model_key,
      connection_revision=EXCLUDED.connection_revision,evaluation_id=NULL,unevaluated=EXCLUDED.unevaluated,updated_at=now()`;
    await audit(actor, "models.switch", `capability:${capability}`, reason, before ?? null, after, undefined, tx);
    return { capability, before, after };
  });
  invalidateModelCache();
  return result;
}

export {
  listModelConnections,
  createModelConnection,
  updateModelConnection,
  disableModelConnection,
  requestModelConnectionProbe,
  readModelConnectionProbe,
  assignRegisteredModel,
  modelRouteRevisions,
  type ModelRegistryGuards,
} from "./model-registry.ts";
export { queueModelConnectionProbe } from "../providers/model-probe.ts";

/** Canonical identity only; no credential, connection-test or Owner-quality assertion. */
export type ModelConfigurationIdentity = { key: string; service: string | null; requestedModel: string | null; configuration_hash: string | null };
export async function modelConfigurationIdentity(key: string, db: Db = sql): Promise<ModelConfigurationIdentity> {
  if (db === sql) return sql.begin((tx) => modelConfigurationIdentity(key, tx));
  await modelRegistryLock(db);
  const id = registeredModelId(key);
  if (id) {
    const row = await connectionRow(id, db);
    return { key, service: key, requestedModel: row.config.model, configuration_hash: modelConfigurationHash(row.config) };
  }
  const configured = environmentModelMetadata(key);
  return { key, service: configured?.service ?? null, requestedModel: configured?.model || null, configuration_hash: configured?.configuration_hash ?? null };
}
export async function currentModelConfiguration(capability: string, db: Db = sql): Promise<ModelConfigurationIdentity> {
  if (!Object.hasOwn(CAPABILITIES, capability)) throw Object.assign(new Error("unknown capability"), { statusCode: 400 });
  if (db === sql) return sql.begin((tx) => currentModelConfiguration(capability, tx));
  await modelRegistryLock(db);
  return modelConfigurationIdentity((await modelSources(db))[capability]!.model, db);
}

export async function pricingModelChoices() {
  const environment = Object.keys(MODELS)
    .map(environmentModelMetadata)
    .filter((m) => m?.configuration_hash)
    .map((m) => ({
      key: m!.key,
      label: m!.model,
      service: m!.service,
      model: m!.model,
      configuration_hash: m!.configuration_hash!,
      vision: m!.vision,
      registered: false,
      input_cny_per_million: null,
      output_cny_per_million: null,
      basis_url: null,
    }));
  const rows = await sql<{ id: string }[]>`SELECT id FROM ai.model_connections WHERE enabled ORDER BY created_at`;
  const registered = await Promise.all(
    rows.map(async (r) => {
      const row = await connectionRow(r.id);
      return {
        key: `registered:${row.id}`,
        label: row.config.name,
        service: `registered:${row.id}`,
        model: row.config.model,
        configuration_hash: modelConfigurationHash(row.config),
        vision: row.config.vision,
        registered: true,
        input_cny_per_million: row.config.input_cny_per_million,
        output_cny_per_million: row.config.output_cny_per_million,
        basis_url: row.config.billing_basis,
      };
    }),
  );
  return [...registered, ...environment];
}

export { modelFallbacks, changeModelFallback } from "./model-fallback.ts";
