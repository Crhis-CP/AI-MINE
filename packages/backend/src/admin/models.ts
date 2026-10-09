// Admin "模型与评测": the model each capability uses and where that choice comes from,
// the prompt versions in use, quality / latency / cost of the last days per model, the switch history
// and the SelectBench runs that compare models on the same batch. A switch is audited and applies to
// new work only.
import { dbOf } from "../db.ts";
import { CAPABILITIES, modelSources, type Capability, type CapabilityKey } from "../editorial/models.ts";
import { MODELS } from "../providers/llm.ts";

const sql = dbOf("ai-gateway");

interface UsageRow {
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
  const [sources, usage, prices, history, benches] = await Promise.all([
    modelSources(),
    sql<UsageRow[]>`
      SELECT r.purpose, a.model, r.request->>'promptVersion' AS prompt_version, count(*)::int AS calls,
             count(*) FILTER (WHERE a.status = 'received')::int AS ok,
             count(*) FILTER (WHERE a.status = 'failed')::int AS failed,
             count(*) FILTER (WHERE a.status = 'unknown')::int AS unknown,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY a.latency_ms) AS p50,
             percentile_disc(0.95) WITHIN GROUP (ORDER BY a.latency_ms) AS p95,
             sum((a.usage->>'prompt_tokens')::bigint) AS tokens_in, sum((a.usage->>'completion_tokens')::bigint) AS tokens_out,
             sum(a.cost) FILTER (WHERE a.cost_basis = 'actual') AS actual_cost, max(a.currency) AS currency
      FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id
      WHERE a.started_at >= ${since} AND a.origin = 'live' AND a.model IS NOT NULL
      GROUP BY 1, 2, 3 ORDER BY 1, 4 DESC`,
    sql<{ service: string; model: string; currency: string; input_per_mtok: string | null; output_per_mtok: string | null }[]>`
      SELECT service, model, currency, input_per_mtok, output_per_mtok FROM service_prices`,
    sql<{ at: Date; actor: string; subject: string; reason: string | null; before: unknown; after: unknown }[]>`
      SELECT created_at AS at, actor, subject, reason, before, after FROM audit_log WHERE action = 'models.switch' ORDER BY created_at DESC LIMIT 30`,
    sql<{ id: string; label: string; sample_size: number; prompt_version: string | null; models: string[]; summary: unknown; created_at: Date }[]>`
      SELECT id, label, sample_size, prompt_version, models,
             (SELECT coalesce(jsonb_object_agg(key, value - 'sweep'), '{}'::jsonb) FROM jsonb_each(r.summary)) AS summary,
             created_at FROM selectbench_runs r ORDER BY created_at DESC LIMIT 8`,
  ]);
  const serviceOf = (model: string) => Object.values(MODELS).find((m) => m.model === model || m.key === model)?.service ?? null;
  const priced = (u: UsageRow) => {
    const service = u.model ? serviceOf(u.model) : null;
    const p = prices.find((x) => x.service === service && x.model === u.model) ?? prices.find((x) => x.service === service && x.model === "");
    if (!p || (!p.input_per_mtok && !p.output_per_mtok)) return null;
    return {
      amount: (Number(u.tokens_in ?? 0) / 1e6) * Number(p.input_per_mtok ?? 0) + (Number(u.tokens_out ?? 0) / 1e6) * Number(p.output_per_mtok ?? 0),
      currency: p.currency,
    };
  };
  const capabilities = (Object.entries(CAPABILITIES) as Array<[CapabilityKey, Capability]>).map(([key, c]) => ({
    key,
    label: c.label,
    env: c.env,
    defaultModel: c.default,
    vision: !!c.vision,
    current: sources[key]!,
    usage: usage
      .filter((u) => c.purposes.includes(u.purpose))
      .map((u) => ({
        purpose: u.purpose,
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
        estimate: priced(u),
      })),
  }));
  const choices = Object.values(MODELS).map((m) => ({ key: m.key, service: m.service, vision: !!m.vision }));
  return { days, capabilities, choices, history, benches };
}

/** Legacy mutation is closed; all new assignments require the OP12 CAS and permission port. */
export async function switchModel(_capability: string, _model: string | null, _reason: string, _actor: string) {
  throw Object.assign(new Error("请通过模型接入页使用权限和版本核对后的指派操作"), { statusCode: 403 });
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
