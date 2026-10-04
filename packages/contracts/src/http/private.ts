import { z } from "zod";
import { Problem, ProblemResponse } from "./common.ts";

export const LoginOptions = z.strictObject({ password: z.boolean(), feishu: z.boolean() });

/** Prepared for atomic GET/POST/UI activation; not registered in schemas/routes yet. */
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

export const schemas = { LoginOptions, Problem };
export const routes = {
  loginOptions: {
    method: "GET" as const,
    url: "/api/auth/options",
    schema: { operationId: "loginOptions", response: { 200: LoginOptions, 404: ProblemResponse, 503: ProblemResponse } },
  },
};
