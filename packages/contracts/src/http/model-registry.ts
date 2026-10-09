import { z } from "zod";
import { ProblemResponse } from "./common.ts";
const HttpsUrl = z
  .url()
  .max(2048)
  .refine((v) => {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash;
  }, "必须填写不含凭据和查询参数的 HTTPS 地址");
const Price = z.string().regex(/^(0|[1-9]\d{0,7})(\.\d{1,8})?$/);
const Reason = z.string().trim().min(1).max(500);
export const ModelConnectionConfig = z.strictObject({
  name: z.string().trim().min(1).max(80),
  interface: z.enum(["deepseek", "openai-compatible"]),
  endpoint: HttpsUrl,
  model: z.string().trim().min(1).max(128),
  input_cny_per_million: Price,
  output_cny_per_million: Price,
  billing_basis: z.url().max(2048),
  vision: z.boolean(),
  json_mode: z.boolean(),
});
export const ModelConnectionCreate = ModelConnectionConfig.extend({
  secret: z.string().min(1).max(8192),
  reason: Reason,
  owner_confirmed: z.literal(true),
  supplier_basis: z.url().max(2048),
});
export const ModelConnectionUpdate = ModelConnectionConfig.extend({
  expected_revision: z.number().int().positive(),
  enabled: z.boolean().optional(),
  secret: z.string().max(8192).optional(),
  reason: Reason,
  owner_confirmed: z.boolean().optional(),
  supplier_basis: z.url().max(2048).optional(),
});
export const ModelConnectionDisable = z.strictObject({ expected_revision: z.number().int().positive(), reason: Reason });
export const ModelConnectionProbe = z.strictObject({ expected_revision: z.number().int().positive(), lane: z.enum(["news", "policy"]) });
export const ModelProbeRecord = z.strictObject({
  id: z.uuid(),
  connection_id: z.uuid(),
  revision: z.number().int().positive(),
  lane: z.enum(["news", "policy"]),
  status: z.enum(["queued", "running", "passed", "failed", "unknown", "paused"]),
  detail: z.string().nullable(),
  receipt_id: z.string().nullable(),
  created_at: z.iso.datetime(),
  finished_at: z.iso.datetime().nullable(),
});
export const ModelConnectionRecord = ModelConnectionConfig.extend({
  id: z.uuid(),
  key: z.string(),
  revision: z.number().int().positive(),
  enabled: z.boolean(),
  fingerprint: z.string(),
  configuration_hash: z.string().regex(/^[a-f0-9]{64}$/),
  test_status: z.enum(["untested", "passed", "failed", "unknown", "running", "queued", "paused"]),
  tested_at: z.iso.datetime().nullable(),
  updated_at: z.iso.datetime(),
});
export const ModelRegistryResponse = z.strictObject({
  storage: z.enum(["ready", "storage_unavailable"]),
  connections: z.array(ModelConnectionRecord),
});
export const ModelRouteChange = z.strictObject({
  model: z.string().min(1),
  expected_revision: z.number().int().nonnegative(),
  reason: Reason,
  evaluation_id: z.string().min(1).max(128).nullable(),
  emergency_confirmed: z.boolean(),
});
export const ModelRouteRecord = z.strictObject({ capability: z.string(), model: z.string(), revision: z.number().int().positive(), unevaluated: z.boolean() });
const errors = { 400: ProblemResponse, 401: ProblemResponse, 403: ProblemResponse, 409: ProblemResponse, 500: ProblemResponse, 503: ProblemResponse };
const params = z.strictObject({ id: z.uuid() });
export const modelRegistrySchemas = {
  ModelConnectionCreate,
  ModelConnectionUpdate,
  ModelConnectionDisable,
  ModelConnectionProbe,
  ModelConnectionRecord,
  ModelRegistryResponse,
  ModelProbeRecord,
  ModelRouteChange,
  ModelRouteRecord,
};
export const modelRegistryRoutes = {
  modelRegistry: {
    method: "GET" as const,
    url: "/api/admin/model-connections",
    schema: { operationId: "modelRegistry", response: { 200: ModelRegistryResponse, ...errors } },
  },
  createModelConnection: {
    method: "POST" as const,
    url: "/api/admin/model-connections",
    schema: { operationId: "createModelConnection", body: ModelConnectionCreate, response: { 200: ModelConnectionRecord, ...errors } },
  },
  updateModelConnection: {
    method: "PUT" as const,
    url: "/api/admin/model-connections/:id",
    schema: { operationId: "updateModelConnection", params, body: ModelConnectionUpdate, response: { 200: ModelConnectionRecord, ...errors } },
  },
  disableModelConnection: {
    method: "POST" as const,
    url: "/api/admin/model-connections/:id/disable",
    schema: { operationId: "disableModelConnection", params, body: ModelConnectionDisable, response: { 200: ModelConnectionRecord, ...errors } },
  },
  probeModelConnection: {
    method: "POST" as const,
    url: "/api/admin/model-connections/:id/test",
    schema: { operationId: "probeModelConnection", params, body: ModelConnectionProbe, response: { 200: ModelProbeRecord, ...errors } },
  },
  modelConnectionProbe: {
    method: "GET" as const,
    url: "/api/admin/model-connection-tests/:id",
    schema: { operationId: "modelConnectionProbe", params, response: { 200: ModelProbeRecord, ...errors } },
  },
  assignRegisteredModel: {
    method: "POST" as const,
    url: "/api/admin/model-routes/:capability",
    schema: {
      operationId: "assignRegisteredModel",
      params: z.strictObject({ capability: z.string() }),
      body: ModelRouteChange,
      response: { 200: ModelRouteRecord, ...errors },
    },
  },
};
