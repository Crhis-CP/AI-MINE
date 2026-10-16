import { z } from "zod";

/** Rule-arranged report references. Omission means legacy/unknown, never an inferred grouping decision. */
export const ReportReadingEntry = z.strictObject({
  item_id: z.string().min(1),
  fact_id: z.string().min(1).nullable(),
  source_count: z.number().int().positive().optional(),
  follow_up_issue: z.iso.date().nullable().optional(),
  fill_in: z.boolean().optional(),
  related_item_ids: z.array(z.string().min(1)).optional(),
});
export const ReportReading = z
  .strictObject({
    lead_item_id: z.string().min(1).nullable(),
    entries: z.array(ReportReadingEntry),
  })
  .refine((value) => {
    const ids = value.entries.map((entry) => entry.item_id);
    return new Set(ids).size === ids.length && (value.lead_item_id === null || ids.includes(value.lead_item_id));
  }, "A report lead must reference a listed entry and each main entry appears once");
