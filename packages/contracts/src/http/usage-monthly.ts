import { z } from "zod";
import { ProblemResponse } from "./common.ts";
const count = z.int().nonnegative(),
  amount = z.string().regex(/^\d+(?:\.\d+)?$/),
  time = z.iso.datetime({ offset: true });
export const UsageMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export const UsageTotals = z.strictObject({
  calls: count,
  received: count,
  failed: count,
  pending: count,
  unknown: count,
  amounts: z.array(z.strictObject({ currency: z.string(), actual: amount, estimated: amount })),
  unpriced_calls: count,
  protection: z
    .strictObject({
      currency: z.literal("CNY"),
      reserved_amount: amount.nullable(),
      unknown_amount: amount.nullable(),
      tracked_calls: count,
      untracked_calls: count,
      coverage: z.enum(["none", "partial", "complete"]),
    })
    .optional(),
  input_tokens: count.nullable(),
  output_tokens: count.nullable(),
  token_reported_calls: count,
  provider_cache_tokens: count.nullable(),
  provider_cache_reported_calls: count,
  provider_cache_miss_tokens: count.nullable(),
  provider_cache_miss_reported_calls: count,
  cache_pair_reported_calls: count,
  cache_hit_rate: z.number().min(0).max(1).nullable(),
});
const group = z.strictObject({ key: z.string(), label: z.string(), totals: UsageTotals });
export const MonthlyUsageReport = z.strictObject({
  month: UsageMonth,
  period_start: time,
  period_end: time,
  generated_at: time,
  totals: UsageTotals,
  by_lane: z.array(group),
  by_service: z.array(group),
  by_capability: z.array(group),
  by_source: z.array(group),
  by_usage_purpose: z.array(group),
  material_costs: z.array(
    z.strictObject({
      kind: z.enum(["article", "policy"]),
      currency: z.string(),
      objects: count,
      recorded_calls: count,
      actual: amount,
      estimated: amount,
      average_actual: amount,
      average_estimated: amount,
    }),
  ),
  material_unassigned_calls: count,
  top_tasks: z.array(
    z.strictObject({
      currency: z.string(),
      items: z.array(z.strictObject({ reference: z.string(), amount: amount, estimated: amount, calls: count })).max(10),
    }),
  ),
  local_reuse: z.strictObject({ recorded_count: count.nullable(), observed_since: time, coverage: z.enum(["none", "partial", "complete"]) }),
  limitations: z.array(z.string()),
});
export const MonthlyUsageEntry = z.strictObject({
  report: MonthlyUsageReport,
  revision: count,
  updated_after_issue: z.boolean(),
  notification_state: z.enum(["pending", "sending", "sent", "unknown"]),
  notification_at: time.nullable(),
});
export const MonthlyUsageList = z.strictObject({ items: z.array(MonthlyUsageEntry) });
export const usageMonthlySchemas = { MonthlyUsageReport, MonthlyUsageEntry, MonthlyUsageList };
export const usageMonthlyRoutes = {
  usageMonthlyList: {
    method: "GET" as const,
    url: "/api/admin/usage/reports",
    schema: { operationId: "usageMonthlyList", response: { 200: MonthlyUsageList, 401: ProblemResponse, 403: ProblemResponse, 503: ProblemResponse } },
  },
  usageMonthlyDetail: {
    method: "GET" as const,
    url: "/api/admin/usage/reports/:month",
    schema: {
      operationId: "usageMonthlyDetail",
      params: z.strictObject({ month: UsageMonth }),
      response: { 200: MonthlyUsageEntry, 400: ProblemResponse, 401: ProblemResponse, 403: ProblemResponse, 404: ProblemResponse, 503: ProblemResponse },
    },
  },
};
