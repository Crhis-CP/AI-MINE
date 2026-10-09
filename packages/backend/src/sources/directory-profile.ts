import { z } from "zod";
import { sha256, stableJson } from "../lib/ids.ts";
import type { SourceRow } from "./types.ts";
const text = z.string().trim().min(1);
export const DirectoryField = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("html"), selector: text, attribute: text.optional(), pattern: z.string().min(1).max(300).optional() }),
  z.strictObject({ kind: z.literal("json"), path: text, pattern: z.string().min(1).max(300).optional() }),
  z.strictObject({ kind: z.literal("header"), name: text, pattern: z.string().min(1).max(300).optional() }),
]);
const count = z.strictObject({ field: DirectoryField, adjust: z.number().int().min(-1).max(1).default(0), groupSeparator: z.enum([",", ".", " "]).optional() });
export type DirectoryCount = z.infer<typeof count>;
export const DirectoryProfile = z
  .strictObject({
    version: z.literal(1),
    idNamespace: text,
    scope: z.strictObject({ description: text, basis: text, evidenceUrl: z.url(), includesHistory: z.boolean() }),
    request: z.strictObject({ location: z.enum(["query", "json_body"]), parameter: text, firstPage: z.number().int().min(0).max(1) }),
    pageNumber: z.union([count, z.strictObject({ kind: z.literal("link_neighbors"), header: z.literal("link"), parameter: text })]),
    totalRecords: count,
    totalPages: count,
    recordScope: z.strictObject({ field: DirectoryField, anyOf: z.array(z.union([text, z.number().int().safe()])).min(1) }).optional(),
    recordId: z.union([z.strictObject({ kind: z.literal("url") }), DirectoryField]),
    documentId: DirectoryField.optional(),
    language: DirectoryField.optional(),
    revisionMarker: DirectoryField.optional(),
    role: z.discriminatedUnion("mode", [
      z.strictObject({ mode: z.literal("current_only"), basis: text }),
      z.strictObject({ mode: z.literal("field"), field: DirectoryField, currentValues: z.array(text).min(1), historyValues: z.array(text).min(1) }),
    ]),
    historyLinks: DirectoryField.optional(),
    maxPagesPerTurn: z.number().int().min(1).max(50).default(2),
    maxPages: z.number().int().positive().default(10000),
    maxRecords: z.number().int().positive().default(100000),
  })
  .superRefine((p, ctx) => {
    if ("kind" in p.pageNumber && (p.request.location !== "query" || p.pageNumber.parameter !== p.request.parameter || p.request.firstPage !== 1))
      ctx.addIssue({ code: "custom", message: "Link pagination requires matching one-based query pages" });
    if (p.scope.includesHistory && p.role.mode === "current_only" && !p.historyLinks)
      ctx.addIssue({ code: "custom", message: "Revision-chain scope requires explicit history links or record roles" });
    if (p.role.mode === "field" && p.role.currentValues.some((v) => p.role.mode === "field" && p.role.historyValues.includes(v)))
      ctx.addIssue({ code: "custom", message: "Current and history roles must not overlap" });
  });
export type DirectoryProfile = z.infer<typeof DirectoryProfile>;
export type DirectoryField = z.infer<typeof DirectoryField>;
export function directoryContract(source: Pick<SourceRow, "kind" | "config">) {
  const parsed = DirectoryProfile.safeParse(source.config.directoryProfile);
  if (
    !parsed.success ||
    !["web_list", "json_list"].includes(source.kind) ||
    String(source.config.url ?? "").startsWith("https://r.jina.ai/") ||
    source.config.parseMode === "markdown"
  )
    return null;
  const config = Object.fromEntries(Object.entries(source.config).filter(([key]) => !["crawlProfile", "policyProfile", "detail", "_amp"].includes(key)));
  return { profile: parsed.data, hash: sha256(stableJson(["directory-v2", source.kind, config, parsed.data])) };
}
