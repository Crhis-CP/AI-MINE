import { z } from "zod";
import { isValidDate } from "../time.ts";
import { TimeAssertion } from "../time-assertion.ts";
import { ProblemResponse } from "./common.ts";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const reason = z.string().trim().min(1).max(2000);
const article = z.strictObject({ id: z.string().min(1).max(80) });
const feedback = z.strictObject({ id: z.string().regex(/^[1-9]\d*$/) });
const date = z.union([z.iso.date(), z.iso.datetime({ offset: true })]).refine((value) => isValidDate(value.slice(0, 10)));
const errors = { 400: ProblemResponse, 401: ProblemResponse, 403: ProblemResponse, 404: ProblemResponse, 409: ProblemResponse, 503: ProblemResponse };
export const AdminActionHeaders = z.looseObject({ "idempotency-key": z.string().regex(/^[\w-]{8,80}$/) });
export const AdminContentRerun = z.strictObject({
  step: z.enum(["extract", "analyze", "group", "presentation"]),
  preview: z.boolean().optional(),
  version: hash.optional(),
  reason: reason.optional(),
});
export const AdminPresentationRefresh = z.strictObject({
  revision: z.number().int().positive(),
  version: hash,
  ready: z.boolean(),
  applied: z.boolean(),
  changed: z.boolean(),
  reason: z.string().nullable(),
  images: z.strictObject({ before: z.number().int().nonnegative(), after: z.number().int().nonnegative() }),
  links: z.strictObject({ before: z.number().int().nonnegative(), after: z.number().int().nonnegative() }),
  translation: z.enum(["absent", "reused", "source", "manual", "blocked"]),
});
export const AdminRerunResult = z.union([z.strictObject({ jobId: z.string().nullable() }), AdminPresentationRefresh]);
/** Null explicitly retracts an untrusted date; a calendar date never implies midnight. */
export const AdminDateIntent = z.strictObject({ publishedAt: date.nullable(), evidence: reason });
const dated = z.strictObject({
  publishedAt: date.nullable(),
  sourceTime: TimeAssertion.nullable(),
  timelineAt: z.iso.datetime({ offset: true }),
  backfill: z.boolean(),
  backfillReason: z.string().nullable(),
});
export const AdminDatePlan = z.strictObject({
  articleId: z.string(),
  version: z.number().int().positive(),
  hash,
  before: dated,
  after: dated,
  mode: z.enum(["history", "live"]),
  archive: z.boolean(),
  changed: z.boolean(),
  ready: z.boolean(),
  reason: z.string().nullable(),
});
export const AdminDateCorrection = AdminDateIntent.extend({ version: z.number().int().positive(), hash, reason });
export const AdminDateResult = z.strictObject({
  articleId: z.string(),
  revision: z.number().int().positive(),
  status: z.enum(["corrected", "unchanged"]),
  publishedAt: date.nullable(),
  archived: z.boolean(),
});
export const AdminFeedbackBan = z.strictObject({
  sourceHash: z.string().trim().min(1).max(200),
  reason,
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
export const AdminFeedbackEmailBan = z.strictObject({ reason });
export const AdminFeedbackEmailBanResult = z.strictObject({ key: z.string(), expiresAt: z.iso.datetime({ offset: true }) });
export const adminMaintenanceSchemas = {
  AdminContentRerun,
  AdminPresentationRefresh,
  AdminRerunResult,
  AdminDateIntent,
  AdminDatePlan,
  AdminDateCorrection,
  AdminDateResult,
  AdminFeedbackBan,
  AdminFeedbackEmailBan,
  AdminFeedbackEmailBanResult,
};
export const adminMaintenanceRoutes = {
  adminContentRerun: {
    method: "POST" as const,
    url: "/api/admin/content/:id/rerun",
    schema: {
      operationId: "adminContentRerun",
      params: article,
      headers: AdminActionHeaders,
      body: AdminContentRerun,
      response: { 200: AdminRerunResult, ...errors },
    },
  },
  adminDatePreview: {
    method: "POST" as const,
    url: "/api/admin/content/:id/date-preview",
    schema: { operationId: "adminDatePreview", params: article, body: AdminDateIntent, response: { 200: AdminDatePlan, ...errors } },
  },
  adminDateCorrection: {
    method: "POST" as const,
    url: "/api/admin/content/:id/date",
    schema: {
      operationId: "adminDateCorrection",
      params: article,
      headers: AdminActionHeaders,
      body: AdminDateCorrection,
      response: { 200: AdminDateResult, ...errors },
    },
  },
  adminFeedbackBan: {
    method: "POST" as const,
    url: "/api/admin/feedback-bans",
    schema: { operationId: "adminFeedbackBan", body: AdminFeedbackBan, response: { 204: z.undefined(), ...errors } },
  },
  adminFeedbackEmailBan: {
    method: "POST" as const,
    url: "/api/admin/feedback/:id/ban-email",
    schema: { operationId: "adminFeedbackEmailBan", params: feedback, body: AdminFeedbackEmailBan, response: { 200: AdminFeedbackEmailBanResult, ...errors } },
  },
};
