import { runtimeControlSchemas, runtimeControlRoutes } from "./runtime-controls.ts";
export { LaneControl, LaneControlsResponse, LaneControlActionRequest } from "./runtime-controls.ts";
export { MonthlyUsageReport, MonthlyUsageEntry, MonthlyUsageList, UsageMonth, UsageTotals } from "./usage-monthly.ts";
import { usageMonthlySchemas, usageMonthlyRoutes } from "./usage-monthly.ts";
import { z } from "zod";
import { Problem, ProblemResponse } from "./common.ts";
import { PermissionScopeSchema, SourcePolicySchema } from "../source-policy.ts";

export const LoginOptions = z.strictObject({ password: z.boolean(), feishu: z.boolean() });

/** Optimistic concurrency precondition; this is not an authentication credential. */
export const ReceiptObservedVersion = z
  .string()
  .length(68)
  .regex(/^rv1:[a-f0-9]{64}$/);
export const ReceiptVersionInput = z.strictObject({
  receiptId: z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .refine((value) => value === value.trim(), "receiptId must be canonical decimal text"),
  attempts: z.number().int().positive(),
  updatedAtUtc: z.iso.datetime({ precision: 6 }).length(27),
});
export type ReceiptVersionFields = z.infer<typeof ReceiptVersionInput>;

export const ReceiptReleaseRequest = z.strictObject({
  billed: z.boolean(),
  note: z.string().trim().min(1),
  version: ReceiptObservedVersion,
});
export const ReceiptReleaseResponse = z.strictObject({
  id: z.number().int().positive(),
  status: z.literal("failed"),
  subject: z.string().nullable(),
  purpose: z.string(),
  requeued: z.boolean(),
});

/** Wire fields used by reconciliation; loose rows preserve existing private diagnostics. */
export const ReceiptIssue = z.looseObject({
  id: z.number().int().positive(),
  status: z.enum(["pending", "received", "completed", "failed", "unknown"]),
  service: z.string(),
  model: z.string().nullable(),
  purpose: z.string(),
  subject: z.string().nullable(),
  error: z.string().nullable(),
  attempts: z.number().int().positive(),
  updated_at: z.iso.datetime({ offset: true }),
  version: ReceiptObservedVersion,
});
export const DeliveryIssue = z.looseObject({
  id: z.number().int().positive(),
  target_key: z.string(),
  status: z.string(),
  subject_kind: z.string(),
  subject_id: z.string(),
  updated_at: z.iso.datetime({ offset: true }),
});
const ReceiptReconciliationResponseCore = z.looseObject({
  receipts: z.strictObject({ counts: z.record(z.string(), z.number().int().nonnegative()), issues: z.array(ReceiptIssue) }),
  deliveries: z.array(DeliveryIssue),
});

const SourceKind = z.enum(["rss", "web_list", "json_list", "mp_account", "external"]);
const SourceTier = z.enum(["T1", "T1_5", "T2", "EXCLUDE_MP"]);
const SourceMode = z.enum(["editorial", "hot_signal", "isolated"]);
const JsonObject = z.record(z.string(), z.unknown());
const Time = z.iso.datetime({ offset: true });
export const SourceCreateRequest = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,79}$/),
  name: z.string().min(1).max(200),
  kind: SourceKind,
  config: JsonObject,
  tier: SourceTier.default("T2"),
  participation_mode: SourceMode.default("editorial"),
  interval_minutes: z.number().int().min(1).max(1440).default(30),
  first_party: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  site_fulltext: z.boolean().default(true),
  syndicate_fulltext: z.boolean().default(false),
  permission_scope: PermissionScopeSchema,
  attachments_in_scope: z.boolean(),
});
export const SourceRecord = z.strictObject({
  id: z.string(),
  name: z.string(),
  kind: SourceKind,
  config: JsonObject,
  tags: z.array(z.string()),
  first_party: z.boolean(),
  owner_entity_id: z.string().nullable(),
  tier: SourceTier,
  participation_mode: SourceMode,
  interval_minutes: z.number().int(),
  site_fulltext: z.boolean(),
  syndicate_fulltext: z.boolean(),
  enabled: z.boolean(),
  health: z.string(),
  fail_count: z.number().int(),
  last_fetch_at: Time.nullable(),
  last_ok_at: Time.nullable(),
  last_error: z.string().nullable(),
  cursor: JsonObject.nullable(),
  next_fetch_at: Time.nullable(),
  imported_from: z.string().nullable(),
  created_at: Time,
  updated_at: Time,
});
export const SourceCreateResponse = z.discriminatedUnion("created", [
  z.strictObject({ created: z.literal(true), source: SourceRecord }),
  z.strictObject({ created: z.literal(false), duplicate: SourceRecord.pick({ id: true, name: true, kind: true, config: true }) }),
]);
export const SourceDetailResponse = z.strictObject({
  source: SourceRecord,
  permission: SourcePolicySchema.nullable(),
  runs: z.array(
    z.strictObject({
      id: z.number().int(),
      started_at: Time,
      finished_at: Time.nullable(),
      status: z.string(),
      found_count: z.number().nullable(),
      new_count: z.number().nullable(),
      error: z.string().nullable(),
      detail: z.looseObject({ pages: z.number().optional(), backlog: z.number().optional(), dropped: z.number().optional() }).nullable(),
    }),
  ),
  items: z.array(
    z.strictObject({
      id: z.string(),
      title: z.string(),
      url: z.string(),
      discovered_at: Time,
      published_at: Time.nullable(),
      processing_state: z.string(),
      selected: z.boolean().nullable(),
      visibility: z.string().nullable(),
      title_zh: z.string().nullable(),
    }),
  ),
  stats: z.strictObject({ total: z.number(), last7d: z.number(), selected: z.number() }),
  history: z.array(
    z.strictObject({ created_at: Time, actor: z.string(), action: z.string(), reason: z.string().nullable(), before: z.unknown(), after: z.unknown() }),
  ),
  republish: JsonObject.nullable(),
});

/** TASK-0022 future private diagnostic fields, not registered on the running route yet. */
export const SourceDateQueue = z.strictObject({
  alertAfterDays: z.number().int().positive().nullable(),
  items: z.array(
    z.strictObject({
      articleId: z.string(),
      sourceId: z.string(),
      waitingSince: z.iso.datetime(),
      reason: z.string(),
      attempts: z.number().int().nonnegative(),
      retryAt: z.iso.datetime().nullable(),
      overdue: z.boolean(),
    }),
  ),
});
export const SourceDatedReceiptReconciliationResponse = ReceiptReconciliationResponseCore.extend({ sourceDates: SourceDateQueue });

export const ReceiptReconciliationResponse = ReceiptReconciliationResponseCore;

export const schemas = {
  ...usageMonthlySchemas,
  ...runtimeControlSchemas,
  SourcePolicy: SourcePolicySchema,
  SourceCreateRequest,
  SourceCreateResponse,
  SourceRecord,
  SourceDetailResponse,
  LoginOptions,
  ReceiptObservedVersion,
  ReceiptReleaseRequest,
  ReceiptReleaseResponse,
  ReceiptIssue,
  DeliveryIssue,
  ReceiptReconciliationResponse,
  Problem,
};
export const routes = {
  ...usageMonthlyRoutes,
  ...runtimeControlRoutes,
  createSource: {
    method: "POST" as const,
    url: "/api/admin/sources",
    schema: {
      operationId: "createSource",
      body: SourceCreateRequest,
      response: {
        200: SourceCreateResponse,
        400: ProblemResponse,
        401: ProblemResponse,
        403: ProblemResponse,
        404: ProblemResponse,
        409: ProblemResponse,
        500: ProblemResponse,
      },
    },
  },
  sourceDetail: {
    method: "GET" as const,
    url: "/api/admin/sources/:id",
    schema: {
      operationId: "sourceDetail",
      params: z.strictObject({ id: z.string() }),
      response: { 200: SourceDetailResponse, 401: ProblemResponse, 404: ProblemResponse, 500: ProblemResponse },
    },
  },
  loginOptions: {
    method: "GET" as const,
    url: "/api/auth/options",
    schema: { operationId: "loginOptions", response: { 200: LoginOptions, 404: ProblemResponse, 503: ProblemResponse } },
  },
  receiptReview: {
    method: "GET" as const,
    url: "/api/admin/runs",
    schema: {
      operationId: "receiptReview",
      response: { 200: ReceiptReconciliationResponse, 401: ProblemResponse, 404: ProblemResponse, 500: ProblemResponse, 503: ProblemResponse },
    },
  },
  releaseReceipt: {
    method: "POST" as const,
    url: "/api/admin/receipts/:id/release",
    schema: {
      operationId: "releaseReceipt",
      params: z.object({ id: z.string() }),
      body: ReceiptReleaseRequest,
      response: {
        200: ReceiptReleaseResponse,
        400: ProblemResponse,
        401: ProblemResponse,
        403: ProblemResponse,
        404: ProblemResponse,
        409: ProblemResponse,
        500: ProblemResponse,
        503: ProblemResponse,
      },
    },
  },
};
