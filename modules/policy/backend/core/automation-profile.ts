import { z } from "zod";
import { normalizeSourceLanguage } from "@amp/backend/sources/config-keys";
import { sha256, stableJson } from "@amp/backend/lib/ids";
import type { SourceRow } from "@amp/backend/admin/sources";
const text = z.string().trim().min(1),
  https = z.url({ protocol: /^https$/ });
const evidence = z.strictObject({ value: text, evidenceUrl: https, basis: text });
/** No generic government-page profile. Every source names its official responsibility and field evidence. */
export const PolicyAutomationProfile = z
  .strictObject({
    version: z.literal(1),
    officialRole: z.strictObject({ kind: z.literal("official_original"), evidenceUrl: https, basis: text, singleObjectPattern: text }),
    identityMarker: z.strictObject({ selector: text, pattern: text }),
    titleSelector: text,
    numberSelector: text.nullable(),
    originalLinkSelector: text.nullable(),
    officialLanguageLinksSelector: text.optional(),
    versionSelector: text.nullable(),
    /**
     * Optional, per field: a regular expression with one capturing group that takes the stable value (an instrument
     * number, a revision line) out of a longer official element. Whitespace inside the captured value is collapsed.
     */
    fieldPatterns: z.strictObject({ title: text.max(300).optional(), number: text.max(300).optional(), version: text.max(300).optional() }).optional(),
    identity: z.strictObject({ jurisdiction: evidence, authority: evidence, documentType: evidence.nullable() }),
    language: text.refine((value) => normalizeSourceLanguage(value) === value, "A supported explicit source language is required"),
    kind: z.enum(["original", "official_translation"]),
    recheckMinutes: z.number().int().positive(),
    extraction: z.strictObject({
      bodySelector: text.nullable(),
      attachmentSelector: text.nullable(),
      attachmentReferencePattern: text.max(300).optional(),
      maxBytes: z.number().int().positive(),
      maxResources: z.number().int().positive(),
      maxPages: z.number().int().positive(),
      maxTextBytes: z.number().int().positive(),
    }),
  })
  .superRefine((value, ctx) => {
    for (const pattern of [value.officialRole.singleObjectPattern, value.identityMarker.pattern]) {
      try {
        if (!pattern.startsWith("^") || !pattern.endsWith("$")) throw new Error();
        new RegExp(pattern, "u");
      } catch {
        ctx.addIssue({ code: "custom", message: "Identity patterns must be valid, anchored expressions" });
      }
    }
    for (const [field, pattern] of Object.entries(value.fieldPatterns ?? {})) {
      if (field === "number" && !value.numberSelector) ctx.addIssue({ code: "custom", message: "A number pattern needs a number selector" });
      if (field === "version" && !value.versionSelector) ctx.addIssue({ code: "custom", message: "A version pattern needs a version selector" });
      try {
        if (new RegExp(`${pattern}|`, "u").exec("")!.length !== 2) throw new Error();
      } catch {
        ctx.addIssue({ code: "custom", message: "Field patterns must be valid expressions with exactly one capturing group" });
      }
    }
  });
export type PolicyAutomationProfile = z.infer<typeof PolicyAutomationProfile>;
export function policyProfile(source: Pick<SourceRow, "kind" | "config">) {
  const parsed = PolicyAutomationProfile.safeParse(source.config.policyProfile);
  if (!parsed.success) return null;
  const profile = parsed.data,
    profileHash = sha256(stableJson(profile));
  return {
    profile,
    profileHash,
    sourceConfigHash: sha256(
      stableJson({ kind: source.kind, url: source.config.url ?? source.config.feedUrl ?? null, baseUrl: source.config.baseUrl ?? null, profileHash }),
    ),
  };
}
