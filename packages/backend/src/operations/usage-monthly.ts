import type { z } from "zod";
import { MonthlyUsageReport, MonthlyUsageEntry, UsageMonth, type UsageTotals } from "@amp/contracts/http/private";
import { beijingDate, beijingMidnight } from "@amp/contracts/time";
import { dbOf } from "../db.ts";
import { sha256, stableJson, newUuid } from "../lib/ids.ts";
import { CAPABILITIES } from "../editorial/models.ts";
import { sendAlert } from "../notify/feishu.ts";
import { config } from "../config.ts";
import { usageConfiguration } from "../providers/usage-protection.ts";
const sql = dbOf("ai-gateway");
type Totals = z.infer<typeof UsageTotals>;
type Attempt = {
  service: string;
  model: string | null;
  purpose: string;
  subject: string | null;
  lane: string | null;
  status: string;
  cost: string | null;
  currency: string | null;
  cost_basis: string | null;
  usage: Record<string, unknown> | null;
  source_ids: unknown;
  usage_purpose: string | null;
  usage_object: unknown;
  protection_state: string | null;
  reserved_micros: string | null;
};
type Accumulator = {
  totals: Totals;
  amounts: Map<string, { actual: bigint; estimated: bigint }>;
  cacheHits: number;
  cacheTotal: number;
  held: { reserved: bigint; unknown: bigint; tracked: number };
};
const empty = (): Accumulator => ({
  totals: {
    calls: 0,
    received: 0,
    failed: 0,
    pending: 0,
    unknown: 0,
    amounts: [],
    unpriced_calls: 0,
    input_tokens: null,
    output_tokens: null,
    token_reported_calls: 0,
    provider_cache_tokens: null,
    provider_cache_reported_calls: 0,
    provider_cache_miss_tokens: null,
    provider_cache_miss_reported_calls: 0,
    cache_pair_reported_calls: 0,
    cache_hit_rate: null,
  },
  amounts: new Map(),
  cacheHits: 0,
  cacheTotal: 0,
  held: { reserved: 0n, unknown: 0n, tracked: 0 },
});
const integer = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);
const micro = (value: string | null) =>
  value && /^\d+(?:\.\d{1,6})?$/.test(value) ? BigInt(value.split(".")[0]!) * 1000000n + BigInt((value.split(".")[1] ?? "").padEnd(6, "0")) : null;
const decimal = (n: bigint) => `${n / 1000000n}.${String(n % 1000000n).padStart(6, "0")}`;
const average = (value: bigint, count: number) => decimal((value + BigInt(count) / 2n) / BigInt(count));
const cacheTokens = (usage: Record<string, unknown> | null) => {
  const details = usage?.prompt_tokens_details as { cached_tokens?: unknown } | undefined;
  const values = [usage?.prompt_cache_hit_tokens, usage?.cache_read_input_tokens, details?.cached_tokens].map(integer).filter((n): n is number => n !== null);
  return values.length && new Set(values).size === 1 ? values[0]! : null;
};
function add(acc: Accumulator, row: Attempt) {
  const t = acc.totals;
  t.calls++;
  if (row.protection_state && row.reserved_micros !== null && /^\d+$/.test(row.reserved_micros)) {
    acc.held.tracked++;
    if (row.protection_state === "reserved") acc.held.reserved += BigInt(row.reserved_micros);
    if (row.protection_state === "unknown") acc.held.unknown += BigInt(row.reserved_micros);
  }
  if (row.status in t && ["received", "failed", "pending", "unknown"].includes(row.status)) t[row.status as "received"]++;
  const cost = micro(row.cost);
  if (cost === null || !row.currency || !["actual", "estimated"].includes(row.cost_basis ?? "")) t.unpriced_calls++;
  else {
    const amounts = acc.amounts.get(row.currency) ?? { actual: 0n, estimated: 0n };
    amounts[row.cost_basis as "actual" | "estimated"] += cost;
    acc.amounts.set(row.currency, amounts);
  }
  const input = integer(row.usage?.prompt_tokens),
    output = integer(row.usage?.completion_tokens),
    cache = cacheTokens(row.usage);
  if (input !== null) t.input_tokens = (t.input_tokens ?? 0) + input;
  if (output !== null) t.output_tokens = (t.output_tokens ?? 0) + output;
  if (input !== null && output !== null) t.token_reported_calls++;
  if (cache !== null) {
    t.provider_cache_tokens = (t.provider_cache_tokens ?? 0) + cache;
    t.provider_cache_reported_calls++;
  }
  const missed = integer(row.usage?.prompt_cache_miss_tokens);
  if (missed !== null) {
    t.provider_cache_miss_tokens = (t.provider_cache_miss_tokens ?? 0) + missed;
    t.provider_cache_miss_reported_calls++;
  }
  if (cache !== null && missed !== null) {
    acc.cacheHits += cache;
    acc.cacheTotal += cache + missed;
    t.cache_pair_reported_calls++;
  }
}
const finish = (acc: Accumulator): Totals => ({
  ...acc.totals,
  protection: {
    currency: "CNY",
    reserved_amount: acc.held.tracked || !acc.totals.calls ? decimal(acc.held.reserved) : null,
    unknown_amount: acc.held.tracked || !acc.totals.calls ? decimal(acc.held.unknown) : null,
    tracked_calls: acc.held.tracked,
    untracked_calls: acc.totals.calls - acc.held.tracked,
    coverage: acc.held.tracked === acc.totals.calls ? "complete" : acc.held.tracked ? "partial" : "none",
  },
  cache_hit_rate: acc.cacheTotal ? acc.cacheHits / acc.cacheTotal : null,
  amounts: [...acc.amounts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, cost]) => ({ currency, actual: decimal(cost.actual), estimated: decimal(cost.estimated) })),
});
export function usageMonthPeriod(month: string) {
  UsageMonth.parse(month);
  const next = new Date(`${month}-01T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { start: beijingMidnight(`${month}-01`), end: beijingMidnight(next.toISOString().slice(0, 10)) };
}
/** Physical attempts only; no current price is substituted for a historical missing amount. */
export async function buildMonthlyUsage(month: string, now = new Date()) {
  const { start, end } = usageMonthPeriod(month);
  if (end.getTime() > now.getTime()) throw new Error("Usage month is still open");
  const total = empty(),
    groups = {
      lane: new Map<string, Accumulator>(),
      service: new Map<string, Accumulator>(),
      capability: new Map<string, Accumulator>(),
      source: new Map<string, Accumulator>(),
      usagePurpose: new Map<string, Accumulator>(),
    },
    objects = new Map<string, { reference: string; currency: string; amount: bigint; estimated: bigint; calls: number }>(),
    materials = new Map<string, { kind: "article" | "policy"; currency: string; objects: Set<string>; actual: bigint; estimated: bigint; calls: number }>();
  let unassigned = 0;
  for await (const rows of sql<
    Attempt[]
  >`SELECT a.service,a.model,r.purpose,r.subject,coalesce(r.request->>'lane',r.request->'manifest'->>'lane') AS lane,r.request->'sourceIds' AS source_ids,r.request->>'usage_purpose' AS usage_purpose,r.request->'usage_object' AS usage_object,a.status,a.cost::text,a.currency,a.cost_basis,a.usage,u.state AS protection_state,u.reserved_micros::text AS reserved_micros
   FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id LEFT JOIN ai.usage_attempts u ON u.attempt_id=a.id WHERE a.origin='live' AND a.started_at>=${start} AND a.started_at<${end} ORDER BY a.id`.cursor(
    500,
  )) {
    for (const row of rows) {
      add(total, row);
      const lane = ["news", "policy"].includes(row.lane ?? "") ? row.lane! : row.purpose.startsWith("policy_") ? "policy" : "unknown";
      const sources =
          Array.isArray(row.source_ids) && row.source_ids.length && row.source_ids.every((id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id))
            ? [...new Set(row.source_ids as string[])].sort().join("+")
            : "unknown",
        usagePurpose = ["production", "research", "evaluation", "experiment"].includes(row.usage_purpose ?? "") ? row.usage_purpose! : "unknown";
      for (const [group, key] of [
        [groups.lane, lane],
        [groups.service, row.service],
        [groups.capability, row.purpose],
        [groups.source, sources],
        [groups.usagePurpose, usagePurpose],
      ] as const) {
        const acc = group.get(key) ?? empty();
        add(acc, row);
        group.set(key, acc);
      }
      const cost = micro(row.cost);
      const explicit = row.usage_object as { kind?: string; id?: string } | null,
        article = /^article:([a-zA-Z0-9_-]+)(?:@|#|$)/.exec(row.subject ?? ""),
        material =
          explicit && ["article", "policy"].includes(explicit.kind ?? "") && /^[a-zA-Z0-9_-]{1,128}$/.test(explicit.id ?? "")
            ? { kind: explicit.kind as "article" | "policy", id: explicit.id! }
            : article
              ? { kind: "article" as const, id: article[1]! }
              : null;
      if (!material) unassigned++;
      if (material && cost !== null && row.currency && ["actual", "estimated"].includes(row.cost_basis ?? "")) {
        const key = `${material.kind}:${row.currency}`,
          sum = materials.get(key) ?? { kind: material.kind, currency: row.currency, objects: new Set<string>(), actual: 0n, estimated: 0n, calls: 0 };
        sum.objects.add(material.id);
        sum[row.cost_basis as "actual" | "estimated"] += cost;
        sum.calls++;
        materials.set(key, sum);
      }
      if (cost !== null && row.currency && ["actual", "estimated"].includes(row.cost_basis ?? "")) {
        const reference =
            row.subject && /^[a-z][a-z0-9_-]*:[a-zA-Z0-9_:@#.-]{1,180}$/.test(row.subject)
              ? row.subject
              : `未登记对象:${sha256(row.subject ?? row.purpose).slice(0, 12)}`,
          key = `${row.currency}:${reference}`,
          item = objects.get(key) ?? { reference, currency: row.currency, amount: 0n, estimated: 0n, calls: 0 };
        item.amount += cost;
        if (row.cost_basis === "estimated") item.estimated += cost;
        item.calls++;
        objects.set(key, item);
      }
    }
  }
  const [observation] = await sql<{ reuse_started_at: Date }[]>`SELECT reuse_started_at FROM ai.usage_observation WHERE id=true`;
  if (!observation) throw new Error("Usage observation unavailable");
  const [reuse] = await sql<
    { n: string }[]
  >`SELECT coalesce(sum(count),0)::text n FROM ai.local_reuse_daily WHERE day>=${beijingDate(start)} AND day<${beijingDate(end)}`;
  const since = observation.reuse_started_at,
    coverage = since >= end ? "none" : since > start ? "partial" : "complete";
  const grouped = (group: Map<string, Accumulator>, label: (key: string) => string) =>
    [...group].sort(([a], [b]) => a.localeCompare(b)).map(([key, acc]) => ({ key, label: label(key), totals: finish(acc) }));
  const currencies = [...new Set([...objects.values()].map((o) => o.currency))].sort();
  return MonthlyUsageReport.parse({
    month,
    period_start: start.toISOString(),
    period_end: end.toISOString(),
    generated_at: now.toISOString(),
    totals: finish(total),
    by_lane: grouped(groups.lane, (key) => ({ news: "资讯线", policy: "法规线", unknown: "历史记录未标明业务线" })[key] ?? key),
    by_service: grouped(groups.service, (key) => key),
    by_capability: grouped(groups.capability, (key) => Object.values(CAPABILITIES).find((c) => (c.purposes as readonly string[]).includes(key))?.label ?? key),
    by_source: grouped(groups.source, (key) => (key === "unknown" ? "记录未标明来源" : key.includes("+") ? `共同来源：${key}` : key)),
    by_usage_purpose: grouped(
      groups.usagePurpose,
      (key) => ({ production: "生产处理", research: "来源研究", evaluation: "质量评测", experiment: "试验", unknown: "记录未标明用途" })[key] ?? key,
    ),
    material_costs: [...materials.values()].map((m) => ({
      kind: m.kind,
      currency: m.currency,
      objects: m.objects.size,
      recorded_calls: m.calls,
      actual: decimal(m.actual),
      estimated: decimal(m.estimated),
      average_actual: average(m.actual, m.objects.size),
      average_estimated: average(m.estimated, m.objects.size),
    })),
    material_unassigned_calls: unassigned,
    top_tasks: currencies.map((currency) => ({
      currency,
      items: [...objects.values()]
        .filter((o) => o.currency === currency)
        .sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : a.reference.localeCompare(b.reference)))
        .slice(0, 10)
        .map((o) => ({ reference: o.reference, amount: decimal(o.amount), estimated: decimal(o.estimated), calls: o.calls })),
    })),
    local_reuse: { recorded_count: coverage === "none" ? null : Number(reuse?.n ?? 0), observed_since: since.toISOString(), coverage },
    limitations: [
      "按当前保留的物理调用记录汇总；实际与当时估算分列，缺金额不按当前单价回填，不跨币种合计。",
      "单篇费用只统计有明确材料归属和金额的记录；未标明对象、来源或用途的历史调用不猜测归属，缺金额不计入平均数。",
      "预留与未知占用单独列出截至本次对账仍占用的金额，不计为已花费用；没有保护记录的调用保留覆盖缺项。",
      "供应商未提供的token或缓存数据保留缺项，本地复用仅从明确记录开始时间起统计。",
    ],
  });
}
const entry = (row: { report: unknown; revision: number; notification_state: string; notification_at: Date | null }) =>
  MonthlyUsageEntry.parse({ ...row, notification_at: row.notification_at?.toISOString() ?? null, updated_after_issue: row.revision > 1 });
export async function monthlyUsageReports(month?: string) {
  if (month) UsageMonth.parse(month);
  const rows = await sql<
    { report: unknown; revision: number; notification_state: string; notification_at: Date | null }[]
  >`SELECT report,revision,notification_state,notification_at FROM ai.usage_monthly_reports WHERE (${month ?? null}::text IS NULL OR month=${month ?? null}) ORDER BY month DESC LIMIT 24`;
  return rows.map(entry);
}
export async function reconcileMonthlyUsage(month: string, now = new Date(), send = sendAlert) {
  const report = await buildMonthlyUsage(month, now),
    hash = sha256(stableJson({ ...report, generated_at: null })),
    attempt = newUuid();
  const deliver = await sql.begin(async (tx) => {
    await tx`INSERT INTO ai.usage_monthly_reports(month,content_hash,report) VALUES(${month},${hash},${tx.json(report)}) ON CONFLICT(month) DO NOTHING`;
    const [previous] = await tx`SELECT content_hash,notification_state FROM ai.usage_monthly_reports WHERE month=${month} FOR UPDATE`;
    if (previous.content_hash !== hash)
      await tx`UPDATE ai.usage_monthly_reports SET revision=revision+1,content_hash=${hash},report=${tx.json(report)},updated_at=now() WHERE month=${month}`;
    await tx`UPDATE ai.usage_monthly_reports SET checked_at=now() WHERE month=${month}`;
    if (previous.notification_state !== "pending") return false;
    await tx`UPDATE ai.usage_monthly_reports SET notification_state='sending',notification_attempt=${attempt},notification_at=now() WHERE month=${month}`;
    return true;
  });
  if (deliver) {
    let state: "sent" | "pending" | "unknown" = "unknown";
    try {
      const result = await send(`用量月报 · ${month}`, [
        `已记录${report.totals.calls}次调用，其中结果未知${report.totals.unknown}次、在途${report.totals.pending}次。`,
        ...report.totals.amounts.map((a) => `${a.currency}：实际 ${a.actual}；当时估算 ${a.estimated}`),
        `保护记录：${report.totals.protection?.tracked_calls ?? 0}次；仍预留人民币 ${report.totals.protection?.reserved_amount ?? "未记录"}，未知占用 ${report.totals.protection?.unknown_amount ?? "未记录"}；与已花费用分开。`,
        `另有${report.totals.unpriced_calls}次缺少可用费用记录。`,
        `完整明细：${config.siteUrl}/admin/usage-models/settings`,
      ]);
      state = result === "sent" ? "sent" : "pending";
    } catch {
      /* Unknown delivery is retained; do not resend blindly. */
    }
    await sql`UPDATE ai.usage_monthly_reports SET notification_state=${state},notification_at=CASE WHEN ${state}='pending' THEN NULL ELSE notification_at END WHERE month=${month} AND notification_attempt=${attempt}`;
  }
  return (await monthlyUsageReports(month))[0]!;
}
export async function usageMonthly(now = new Date(), send = sendAlert) {
  const date = beijingDate(now),
    previous = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  previous.setUTCMonth(previous.getUTCMonth() - 1);
  const month = previous.toISOString().slice(0, 7);
  const configured = await usageConfiguration();
  const [hour, minute] = (configured?.config.usage_report.push_time ?? "09:00").split(":").map(Number);
  if (now.getTime() < usageMonthPeriod(month).end.getTime() + (hour! * 60 + minute!) * 60_000) return { deferred: true };
  const existing = await sql<{ month: string }[]>`SELECT month FROM ai.usage_monthly_reports ORDER BY checked_at,month LIMIT 24`;
  for (const row of existing) if (row.month !== month) await reconcileMonthlyUsage(row.month, now, send);
  return reconcileMonthlyUsage(month, now, send);
}
