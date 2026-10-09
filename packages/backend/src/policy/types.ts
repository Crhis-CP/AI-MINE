import { z } from "zod";

const text = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0);
const url = z.url().refine((value) => {
  const parsed = new URL(value);
  return parsed.protocol === "https:" && !parsed.username && !parsed.password;
});
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const PolicyIdentity = z.strictObject({
  jurisdiction: text,
  authority: text,
  documentType: text.nullable(),
  documentNumber: text.nullable(),
  officialUrl: url,
});
export const OriginalResource = z
  .strictObject({
    url,
    mediaType: text.nullable(),
    attachment: z.boolean(),
    required: z.boolean(),
    state: z.enum(["acquired", "missing", "failed", "blocked_capacity"]),
    body: z.instanceof(Uint8Array).nullable(),
    reason: text.nullable(),
  })
  .refine((value) =>
    value.state === "acquired" ? value.body !== null && value.body.byteLength > 0 && value.reason === null : value.body === null && value.reason !== null,
  );
export const PolicyOriginalInput = z
  .strictObject({
    sourceId: text,
    permissionVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    identity: PolicyIdentity,
    versionKey: text.nullable(),
    language: text,
    kind: z.enum(["original", "official_translation"]),
    officialTitle: text,
    expectedHead: hash.nullable(),
    catalogueClosed: z.boolean(),
    resources: z.array(OriginalResource).min(1),
  })
  .superRefine((value, ctx) => {
    if (value.identity.documentNumber !== null && value.identity.documentType === null)
      ctx.addIssue({ code: "custom", message: "Numbered identity requires a source document type" });
    if (value.resources[0]?.attachment || !value.resources[0]?.required || value.resources.slice(1).some((item) => !item.attachment))
      ctx.addIssue({ code: "custom", message: "First resource is the original; all others are attachments" });
    if (new Set(value.resources.map((item) => item.url)).size !== value.resources.length)
      ctx.addIssue({ code: "custom", message: "Resource URLs must be unique" });
  });
export type PolicyOriginalInput = z.infer<typeof PolicyOriginalInput>;

/** Acquisition is separate from textual, attachment, translation and semantic completeness. */
export function acquisitionState(value: PolicyOriginalInput) {
  if (value.resources.some((item) => item.required && item.state === "blocked_capacity")) return "blocked_capacity";
  if (!value.catalogueClosed || value.resources.some((item) => item.required && item.state !== "acquired")) return "incomplete";
  return "pending_extraction";
}
