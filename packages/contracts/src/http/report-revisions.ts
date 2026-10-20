import { z } from "zod";
import { isValidDate, isoWeekRange } from "../time.ts";
import { ProblemResponse } from "./common.ts";

export const NewsReportPeriod = z.strictObject({ kind: z.enum(["daily", "weekly", "monthly"]), key: z.string().min(7).max(10) }).refine(({ kind, key }) => {
  if (kind === "daily") return /^\d{4}-\d{2}-\d{2}$/.test(key) && isValidDate(key);
  if (kind === "weekly") return /^\d{4}-W\d{2}$/.test(key) && isoWeekRange(key) !== null;
  return /^\d{4}-\d{2}$/.test(key) && isValidDate(`${key}-01`);
}, "Report period must be a real date, ISO week or calendar month matching its kind");

export const ReportReconcileRequest = z.strictObject({
  // Zero observes a tracked issue that has not yet been published.
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(2000),
});
export const ReportReconcileResponse = z.strictObject({
  kind: z.enum(["daily", "weekly", "monthly"]),
  key: z.string(),
  revision: z.number().int().nonnegative(),
  status: z.enum(["queued", "already_pending", "preserved_manual", "withdrawn"]),
});
export const AdminReportEntry = z.strictObject({
  kind: z.enum(["daily", "weekly", "monthly"]),
  key: z.string(),
  title: z.string(),
  revision: z.number().int().nonnegative(),
  origin: z.enum(["rule", "model", "manual", "imported"]).nullable(),
  generationStatus: z.enum(["ready", "pending", "failed", "summary"]),
  firstPublishedAt: z.iso.datetime().nullable(),
  lastRevisedAt: z.iso.datetime().nullable(),
  reconciliation: z
    .strictObject({
      state: z.enum(["pending", "running", "retry", "done", "preserved_manual", "withdrawn"]),
      requestedAt: z.iso.datetime(),
      checkedAt: z.iso.datetime().nullable(),
      nextAttemptAt: z.iso.datetime().nullable(),
      result: z.enum(["revised", "unchanged", "waiting"]).nullable(),
      message: z.string().nullable(),
    })
    .nullable(),
});
export const AdminReportList = z.strictObject({ items: z.array(AdminReportEntry).max(50), nextKey: z.string().nullable() });
export const reportRevisionSchemas = { ReportReconcileRequest, ReportReconcileResponse, AdminReportEntry, AdminReportList };
export const reportRevisionRoutes = {
  adminReports: {
    method: "GET" as const,
    url: "/api/admin/reports",
    schema: {
      operationId: "adminReports",
      querystring: z
        .strictObject({
          kind: z.enum(["daily", "weekly", "monthly"]).default("daily"),
          before: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        })
        .refine((value) => value.before === undefined || NewsReportPeriod.safeParse({ kind: value.kind, key: value.before }).success, "Invalid report cursor"),
      response: { 200: AdminReportList, 400: ProblemResponse, 401: ProblemResponse, 403: ProblemResponse, 503: ProblemResponse },
    },
  },
  reconcileNewsReport: {
    method: "POST" as const,
    url: "/api/admin/reports/:kind/:key/reconcile",
    schema: {
      operationId: "reconcileNewsReport",
      params: NewsReportPeriod,
      // Swagger requires inline parameter objects; reusing a registered object produces an unresolved local ref.
      headers: z.looseObject({ "idempotency-key": z.string().regex(/^[\w-]{8,80}$/) }),
      body: ReportReconcileRequest,
      response: {
        200: ReportReconcileResponse,
        400: ProblemResponse,
        401: ProblemResponse,
        403: ProblemResponse,
        404: ProblemResponse,
        409: ProblemResponse,
        503: ProblemResponse,
      },
    },
  },
};
