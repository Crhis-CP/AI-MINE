import { z } from "zod";

/** A scoring nomination is separate from a completed current-material identity/value decision. */
export const NewsGroupingDiagnostic = z
  .strictObject({
    materialRevision: z.number().int().positive(),
    inputRevision: z.number().int().positive().nullable(),
    status: z.enum(["pending", "complete", "failed"]),
    selectionCandidate: z.boolean().nullable(),
    addsValue: z.boolean().nullable(),
    reason: z.string().nullable(),
    receiptId: z.number().int().positive().nullable(),
    error: z.string().nullable(),
  })
  .refine(
    (value) => value.status !== "complete" || (value.inputRevision === value.materialRevision && value.addsValue !== null && !!value.reason?.trim()),
    "A completed grouping decision requires current material identity and an explicit value judgement",
  );

export const GroupingQueueItem = z
  .strictObject({
    articleId: z.string().min(1),
    title: z.string(),
    since: z.iso.datetime({ offset: true }),
    failed: z.boolean(),
    recovery: z.enum(["automatic", "receipt", "manual"]),
    receiptId: z.number().int().positive().nullable(),
    error: z.string().nullable(),
  })
  .refine((value) => value.recovery !== "receipt" || value.receiptId !== null, "Receipt recovery requires a receipt identifier");
export const GroupingOverview = z
  .strictObject({
    waiting: z.number().int().nonnegative(),
    needsAttention: z.number().int().nonnegative(),
    items: z.array(GroupingQueueItem).max(100),
  })
  .refine(
    (value) => value.needsAttention <= value.waiting && value.items.length <= value.waiting,
    "Displayed and attention-needed items are subsets of waiting work",
  );

export type NewsGroupingDiagnostic = z.infer<typeof NewsGroupingDiagnostic>;
export type GroupingOverview = z.infer<typeof GroupingOverview>;
export const schemas = { NewsGroupingDiagnostic, GroupingQueueItem, GroupingOverview };
