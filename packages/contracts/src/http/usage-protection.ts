import { z } from "zod";
import { ProblemResponse } from "./common.ts";
const Micros = z.string().regex(/^(0|[1-9]\d{0,17})$/);
const UnitRate = z.string().regex(/^(0|[1-9]\d{0,17})(\.\d{1,2})?$/);
const PositiveMicros = Micros.refine((v) => BigInt(v) > 0n);
const Ratio = z
  .string()
  .regex(/^\d+(?:\.\d{1,6})?$/)
  .refine((v) => Number(v) > 0);
const Lane = z.enum(["news", "policy"]);
const Reason = z.string().trim().min(1).max(1000);
export const UsageProtectionConfig = z.strictObject({
  breaker: z.strictObject({
    repeat_count: z.number().int().positive(),
    repeat_window_seconds: z.number().int().positive(),
    news_object_micros: PositiveMicros,
    policy_object_micros: PositiveMicros,
    daily_multiple: Ratio,
    daily_floor_micros: PositiveMicros,
    daily_no_history_micros: PositiveMicros,
    lookback_days: z.number().int().positive(),
    warning_ratio: Ratio.refine((v) => Number(v) < 1),
  }),
  usage_notice: z.strictObject({ step_micros: PositiveMicros }),
  usage_report: z.strictObject({ push_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }),
  unknown_alert: z.strictObject({ amount_micros: PositiveMicros, oldest_age_seconds: z.number().int().positive() }),
});
export const UsageConfigRecord = z.strictObject({
  version: z.number().int().positive(),
  config: UsageProtectionConfig,
  effective_at: z.iso.datetime(),
  actor: z.string(),
  reason: z.string(),
});
export const UsageConfigChange = z.strictObject({
  expected_version: z.number().int().nonnegative(),
  config: UsageProtectionConfig,
  reason: Reason,
  high_risk_confirmed: z.literal(true),
});
export const UsagePrice = z
  .strictObject({
    service: z.string().min(1).max(160),
    model: z.string().max(128),
    configuration_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    currency: z.literal("CNY"),
    input_per_million_micros: UnitRate.nullable(),
    output_per_million_micros: UnitRate.nullable(),
    per_request_micros: Micros.nullable(),
    max_request_micros: Micros.nullable(),
    image_input_token_bound: z.number().int().positive().nullable(),
    protocol_input_token_allowance: z.number().int().nonnegative(),
    basis_url: z
      .url()
      .max(2048)
      .refine((v) => {
        const u = new URL(v);
        return u.protocol === "https:" && !u.username && !u.password;
      }),
    observed_on: z.iso.date(),
    valid_until: z.iso.date(),
  })
  .refine(
    (v) => v.per_request_micros !== null || v.max_request_micros !== null || (v.input_per_million_micros !== null && v.output_per_million_micros !== null),
    "需明确人民币单价或单次费用依据",
  )
  .refine((v) => {
    const days = (Date.parse(v.valid_until) - Date.parse(v.observed_on)) / 86400000;
    return days > 0 && days <= 45;
  }, "价格有效期须为观察日起45天以内");
export const UsagePriceChange = z.strictObject({
  expected_version: z.number().int().nonnegative(),
  price: UsagePrice,
  reason: Reason,
  high_risk_confirmed: z.literal(true),
});
export const UsagePriceRecord = z.strictObject({ id: z.string(), version: z.number().int().positive(), price: UsagePrice, updated_at: z.iso.datetime() });
export const UsageScope = z.strictObject({
  lane: Lane,
  kind: z.enum(["capability_source", "object", "capability"]),
  capability: z.string().nullable(),
  source_id: z.string().nullable(),
  object_kind: z.enum(["article", "policy"]).nullable(),
  object_id: z.string().nullable(),
});
export const UsageBreaker = z.strictObject({
  id: z.string(),
  revision: z.number().int().positive(),
  scope: UsageScope,
  trigger: z.enum(["repeated_input", "object_cost", "daily_total"]),
  state: z.enum(["warning", "open", "recovered"]),
  window_key: z.string(),
  config_version: z.number().int().positive(),
  current: z.record(z.string(), z.string()),
  threshold: z.record(z.string(), z.string()),
  warning_at: z.iso.datetime().nullable(),
  opened_at: z.iso.datetime().nullable(),
  created_at: z.iso.datetime(),
  recovered_at: z.iso.datetime().nullable(),
  recovered_by: z.string().nullable(),
  recovery_reason: z.string().nullable(),
  receipt_ids: z.array(z.string()),
});
export const UsageBreakerRecovery = z.strictObject({ expected_revision: z.number().int().positive(), reason: Reason });
export const UsageProtectionEvent = z.strictObject({
  id: z.string(),
  kind: z.enum(["warning", "opened", "recovered", "configuration_changed", "configuration_missing", "usage_notice", "unknown_usage"]),
  lane: Lane.nullable(),
  payload: z.record(z.string(), z.unknown()),
  created_at: z.iso.datetime(),
  delivery_status: z.enum(["pending", "sent", "disabled", "unknown"]),
  sent_at: z.iso.datetime().nullable(),
});
export const UsageProtectionOverview = z.strictObject({
  can_manage: z.boolean().default(false),
  pricing_models: z
    .array(
      z.strictObject({
        key: z.string(),
        label: z.string(),
        service: z.string(),
        model: z.string(),
        configuration_hash: z.string(),
        vision: z.boolean(),
        registered: z.boolean(),
        input_cny_per_million: z.string().nullable(),
        output_cny_per_million: z.string().nullable(),
        basis_url: z.string().nullable(),
      }),
    )
    .default([]),
  as_of: z.iso.datetime(),
  indicators: z.array(
    z.strictObject({
      trigger: z.enum(["repeated_input", "object_cost", "daily_total"]),
      scope: UsageScope.nullable(),
      current: z.record(z.string(), z.string()),
      threshold: z.record(z.string(), z.string()),
      level: z.enum(["normal", "warning", "tripped"]),
    }),
  ),
  configuration: UsageConfigRecord.nullable(),
  initial_config: UsageProtectionConfig.nullable(),
  prices: z.array(UsagePriceRecord),
  breakers: z.array(UsageBreaker),
  events: z.array(UsageProtectionEvent),
  missing: z.array(z.string()),
});
const errors = { 400: ProblemResponse, 401: ProblemResponse, 403: ProblemResponse, 409: ProblemResponse, 500: ProblemResponse, 503: ProblemResponse };
export const usageProtectionSchemas = {
  UsageProtectionConfig,
  UsageConfigRecord,
  UsageConfigChange,
  UsagePrice,
  UsagePriceRecord,
  UsagePriceChange,
  UsageScope,
  UsageBreaker,
  UsageBreakerRecovery,
  UsageProtectionEvent,
  UsageProtectionOverview,
};
export const usageProtectionRoutes = {
  usageProtection: {
    method: "GET" as const,
    url: "/api/admin/usage-protection",
    schema: { operationId: "usageProtection", response: { 200: UsageProtectionOverview, ...errors } },
  },
  changeUsageProtection: {
    method: "PUT" as const,
    url: "/api/admin/usage-config",
    schema: { operationId: "changeUsageProtection", body: UsageConfigChange, response: { 200: UsageConfigRecord, ...errors } },
  },
  changeUsagePrice: {
    method: "PUT" as const,
    url: "/api/admin/usage-prices",
    schema: { operationId: "changeUsagePrice", body: UsagePriceChange, response: { 200: UsagePriceRecord, ...errors } },
  },
  recoverUsageBreaker: {
    method: "POST" as const,
    url: "/api/admin/breakers/:id/recover",
    schema: {
      operationId: "recoverUsageBreaker",
      params: z.strictObject({ id: z.string() }),
      body: UsageBreakerRecovery,
      response: { 200: UsageBreaker, ...errors },
    },
  },
};
