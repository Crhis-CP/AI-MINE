import { z } from "zod";
import { ProblemResponse } from "./common.ts";
export const ModelFallbackChoice = z.strictObject({
  model: z.string(),
  name: z.string(),
  modelName: z.string(),
  sourceIds: z.array(z.string()),
  approvalKind: z.enum(["selection", "policy", "capability"]).nullable(),
  eligible: z.boolean(),
  reason: z.string().nullable(),
});
export const ModelFallbackRoute = z.strictObject({
  capability: z.string(),
  label: z.string(),
  revision: z.number().int().nonnegative(),
  primaryModel: z.string(),
  backupModel: z.string().nullable(),
  sourceIds: z.array(z.string()),
  state: z.enum(["none", "ready", "stale", "blocked"]),
  detail: z.string().nullable(),
  choices: z.array(ModelFallbackChoice),
});
export const ModelFallbackOverview = z.strictObject({
  routes: z.array(ModelFallbackRoute),
  sources: z.array(z.strictObject({ id: z.string(), name: z.string(), lane: z.enum(["news", "policy"]) })),
});
export const ModelFallbackChange = z
  .strictObject({
    expected_revision: z.number().int().nonnegative(),
    backup_model: z.string().nullable(),
    source_ids: z.array(z.string().min(1)).max(1000),
    reason: z.string().trim().min(1).max(1000),
  })
  .superRefine((value, ctx) => {
    if (value.backup_model === null ? value.source_ids.length > 0 : value.source_ids.length === 0)
      ctx.addIssue({ code: "custom", message: "请为备用接入明确选择允许的来源；停用备用时清空来源名单" });
    if (new Set(value.source_ids).size !== value.source_ids.length) ctx.addIssue({ code: "custom", message: "来源不能重复" });
  });
export const modelFallbackSchemas = { ModelFallbackChoice, ModelFallbackRoute, ModelFallbackOverview, ModelFallbackChange };
const errors = { 400: ProblemResponse, 401: ProblemResponse, 403: ProblemResponse, 409: ProblemResponse, 503: ProblemResponse };
export const modelFallbackRoutes = {
  modelFallbacks: {
    method: "GET" as const,
    url: "/api/admin/model-fallbacks",
    schema: { operationId: "modelFallbacks", response: { 200: ModelFallbackOverview, ...errors } },
  },
  changeModelFallback: {
    method: "PUT" as const,
    url: "/api/admin/model-fallbacks/:capability",
    schema: {
      operationId: "changeModelFallback",
      params: z.strictObject({ capability: z.string().min(1) }),
      body: ModelFallbackChange,
      response: { 200: ModelFallbackRoute, ...errors },
    },
  },
};
