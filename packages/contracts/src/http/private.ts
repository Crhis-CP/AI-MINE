import { z } from "zod";
import { Problem, ProblemResponse } from "./common.ts";

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
export const ReceiptReconciliationResponse = z.looseObject({
  receipts: z.strictObject({ counts: z.record(z.string(), z.number().int().nonnegative()), issues: z.array(ReceiptIssue) }),
  deliveries: z.array(DeliveryIssue),
});

export const schemas = {
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
