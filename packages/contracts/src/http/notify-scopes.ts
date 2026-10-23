import { z } from "zod";
import { ProblemResponse } from "./common.ts";
import { AdminActionHeaders } from "./admin-maintenance.ts";

/** null keeps the general channel; concrete countries use the same selected publications as the site. */
export const NotifyCountry = z
  .string()
  .regex(/^[A-Z]{2}$/)
  .nullable();
export const NotifyTargetScope = z.strictObject({
  key: z.string().min(1).max(100),
  jurisdiction: NotifyCountry,
  version: z.string().min(1).max(80),
  enabled: z.boolean(),
  enabledAt: z.iso.datetime({ offset: true }).nullable(),
});
export const NotifyTargetScopes = z.strictObject({ items: z.array(NotifyTargetScope) });
export const NotifyTargetScopeUpdate = z.strictObject({
  jurisdiction: NotifyCountry,
  version: z.string().min(1).max(80),
  reason: z.string().trim().min(1).max(500),
});
export const notifyScopeSchemas = { NotifyCountry, NotifyTargetScope, NotifyTargetScopes, NotifyTargetScopeUpdate };
const errors = { 400: ProblemResponse, 401: ProblemResponse, 403: ProblemResponse, 404: ProblemResponse, 409: ProblemResponse, 503: ProblemResponse };
export const notifyScopeRoutes = {
  notifyTargetScopes: {
    method: "GET" as const,
    url: "/api/admin/notify-target-scopes",
    schema: { operationId: "notifyTargetScopes", response: { 200: NotifyTargetScopes, ...errors } },
  },
  notifyTargetScopeUpdate: {
    method: "PUT" as const,
    url: "/api/admin/notify-targets/:key/scope",
    schema: {
      operationId: "notifyTargetScopeUpdate",
      headers: AdminActionHeaders,
      params: z.strictObject({ key: z.string().min(1).max(100) }),
      body: NotifyTargetScopeUpdate,
      response: { 200: NotifyTargetScope, ...errors },
    },
  },
};
