import { z } from "zod";
import { isValidDate, isoWeekRange } from "../time.ts";
import { ProblemResponse } from "./common.ts";

export const NewsReportPeriod = z.strictObject({ kind: z.enum(["daily", "weekly", "monthly"]), key: z.string().min(7).max(10) }).refine(({ kind, key }) => {
  if (kind === "daily") return /^\d{4}-\d{2}-\d{2}$/.test(key) && isValidDate(key);
  if (kind === "weekly") return /^\d{4}-W\d{2}$/.test(key) && isoWeekRange(key) !== null;
  return /^\d{4}-\d{2}$/.test(key) && isValidDate(`${key}-01`);
}, "Report period must be a real date, ISO week or calendar month matching its kind");

export const ReportReconcileRequest = z.strictObject({
  expectedRevision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(2000),
});
export const ReportReconcileResponse = z.strictObject({
  kind: z.enum(["daily", "weekly", "monthly"]),
  key: z.string(),
  revision: z.number().int().positive(),
  status: z.enum(["queued", "already_pending", "preserved_manual", "withdrawn"]),
});
export const reportRevisionSchemas = { ReportReconcileRequest, ReportReconcileResponse };
export const reportRevisionRoutes = {
  reconcileNewsReport: {
    method: "POST" as const,
    url: "/api/admin/reports/:kind/:key/reconcile",
    schema: {
      operationId: "reconcileNewsReport",
      params: NewsReportPeriod,
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
