import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { z } from "zod";
import { sha256, stableJson } from "../lib/ids.ts";
import { shield } from "../editorial/translation-readiness.ts";
import { normalizeSourceLanguage } from "@amp/backend/sources/config-keys";
import { POLICY_PLAN_LIMITS, type PolicyFulltextPlan, type PolicyPart } from "./processing-plan.ts";

const roles = ["obligation", "definition", "scope", "exception", "commencement", "status", "reference", "other"] as const;
const text = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const PolicyPartCandidateSchema = z
  .strictObject({
    partId: hash,
    sourceHash: hash,
    classification: z.enum(["facts", "reference", "non_operative"]),
    facts: z.array(z.strictObject({ statement: text, role: z.enum(roles), quote: text })),
    zh: text.nullable(),
  })
  .refine((part) => (part.classification === "facts" ? part.facts.length > 0 : part.facts.length === 0));
export type PolicyPartCandidate = z.infer<typeof PolicyPartCandidateSchema>;
export type CandidateIssue = { partId: string | null; code: string };
export type CheckedPolicyPart = PolicyPartCandidate & { content: string; contentHash: string };
export type AssembledPolicyResource = {
  resourceUrl: string;
  resourceHash: string;
  blocks: { partId: string; nodeId: string; nodePath: string; format: PolicyPart["format"]; content: string; contentHash: string }[];
};
const badCharacters = (value: string) => !value.isWellFormed() || value.includes("\0") || value.includes("\uFFFD");
const visible = (part: PolicyPart, value: string) => (part.format === "html" ? cheerio.load(value, null, false).root().text() : value);
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const currencies = new RegExp(`(?<![A-Za-z])(?:${Intl.supportedValuesOf("currency").join("|")})(?![A-Za-z])`, "g");

/** Literal tokens only: this deliberately does not infer equivalent dates, amounts or legal meaning. */
function invariantParser(language: string) {
  const months = new Set<string>();
  for (const month of Array.from({ length: 12 }, (_, i) => i))
    for (const style of ["long", "short"] as const) {
      const parts = new Intl.DateTimeFormat(language, { day: "numeric", month: style, year: "numeric", timeZone: "UTC" }).formatToParts(
        new Date(Date.UTC(2020, month, 15)),
      );
      for (const part of parts) if (part.type === "month") months.add(part.value);
    }
  const month = [...months]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join("|");
  const dates = new RegExp(
    `(?:\\p{N}{1,2}(?:st|nd|rd|th)?\\s+(?:de\\s+)?(?:${month})\\s+(?:de\\s+)?\\p{N}{4}|(?:${month})\\s+\\p{N}{1,2}(?:st|nd|rd|th)?,?\\s+\\p{N}{4})`,
    "giu",
  );
  return (value: string) => ({
    numbers: value.match(/[+−-]?\p{N}+(?:[.,:/-]\p{N}+)*(?:[eE][+-]?\p{N}+)?/gu) ?? [],
    dates: value.match(dates) ?? [],
    links: value.match(/\b(?:https?|ftp):\/\/[^\s<>"'，。；、！？（）]+/gu) ?? [],
    currencies: (value.match(currencies) ?? []).filter(
      (code) => !["ALL", "TRY", "MAD", "TOP", "CUP"].includes(code) || new RegExp(`(?:\\p{N}\\s*${code}\\b|\\b${code}\\s*\\p{N}|^${code}$)`, "u").test(value),
    ),
    markers: value.match(/⟦[^⟧]+⟧|\{\{[^}]+\}\}|§+|\((?:[a-z]|[ivxlcdm]+)\)/gi) ?? [],
    romanClauses: [
      ...value.matchAll(
        /(?:\b(?:Article|Art\.?|Section|Sec\.?|Chapter|Part|Annex|Schedule|Artículo|Artigo|Chapitre)|第)\s*([IVXLCDM]+)(?=\b|条|章|节|部分|附件)/giu,
      ),
    ].map((match) => match[1]),
    units: value.match(/\p{Sc}|(?<![A-Za-z])(?:mg|kg|µg|μg|ppm|ppb|km|cm|mm|m²|m³|m2|m3|ha|ft|lb|oz|kWh|MWh|MW|kW|pH|°C|°F|%|‰)(?![A-Za-z])/gu) ?? [],
    quantityUnits: [...value.matchAll(/(?:\p{N}\s*(in|min|[msthg])(?![A-Za-z])|^(in|min|[msthg])$)/gu)].map((match) => match[1] ?? match[2]!),
  });
}
function htmlShape(value: string) {
  const $ = cheerio.load(value, null, false),
    leaves: string[] = [];
  const walk = (nodes: AnyNode[]): unknown[] =>
    nodes.flatMap((node): unknown[] => {
      if (node.type === "text") {
        if (node.data.trim()) {
          leaves.push(node.data);
          return ["text"];
        }
        return [];
      }
      if (node.type !== "tag") return [[node.type]];
      const element = node as Element;
      return [[element.name, Object.entries(element.attribs).sort(([a], [b]) => a.localeCompare(b)), walk(element.children)]];
    });
  return { shape: stableJson(walk($.root().contents().toArray())), leaves, active: $("script,style,iframe,object,embed,form,base,meta,link").length > 0 };
}
function translationIssue(part: PolicyPart, translated: string, invariants: ReturnType<typeof invariantParser>): string | null {
  const sourceText = visible(part, part.source),
    translatedText = visible(part, translated);
  if (badCharacters(translated) || badCharacters(translatedText)) return "translation_character_integrity";
  if (/^(?:\.\.\.|…|略|同上|待翻译|译文待补|见原文|TODO|TBD|N\/A)$/i.test(translatedText.trim())) return "translation_placeholder";
  if (part.format === "html") {
    const before = htmlShape(part.source),
      after = htmlShape(translated);
    if (before.active || after.active || before.shape !== after.shape) return "html_structure_changed";
    const a = shield(part.source),
      b = shield(translated);
    if (stableJson([a.tokens, a.links]) !== stableJson([b.tokens, b.links])) return "protected_markup_changed";
    if (before.leaves.some((leaf, index) => stableJson(invariants(leaf)) !== stableJson(invariants(after.leaves[index]!)))) return "leaf_invariants_changed";
  } else if (/<\/?[a-z][^>]*>/i.test(translated)) return "unexpected_markup";
  const whole = (value: string) => {
    const tokens = invariants(value);
    return part.format === "html" ? [tokens.dates, tokens.markers, tokens.romanClauses] : tokens;
  };
  // HTML cell/text slots already protect amounts/units/URLs; concatenating adjacent cells can invent a lexical word boundary.
  if (stableJson(whole(sourceText)) !== stableJson(whole(translatedText))) return "invariants_changed";
  let remainder = part.format === "html" ? visible(part, shield(part.source).html) : sourceText;
  for (const token of Object.values(invariants(remainder))
    .flat()
    .sort((a, b) => b.length - a.length))
    remainder = remainder.split(token).join("");
  if (remainder.replace(/[\p{P}\p{S}\s]/gu, "") && !/\p{Script=Han}/u.test(translatedText)) return "chinese_candidate_missing";
  return null;
}

function planIssues(plan: PolicyFulltextPlan): string[] {
  const errors: string[] = [];
  if (plan.status !== "planned" || plan.semantic_verified !== false || plan.runtime_authorization !== "none") errors.push("plan_not_program_only");
  if (!plan.revisionId || Object.values(plan.context).some((value) => !value.trim()) || !hash.safeParse(plan.context.identityHash).success)
    errors.push("plan_identity_invalid");
  if (plan.manifestHash !== sha256(stableJson([plan.revisionId, plan.context, plan.sourceBytes, plan.parts]))) errors.push("plan_manifest_mismatch");
  if (
    Boolean(plan.context.visualRunId) !== Boolean(plan.context.visualContentHash) ||
    (plan.context.visualRunId && (!hash.safeParse(plan.context.visualRunId).success || !hash.safeParse(plan.context.visualContentHash).success))
  )
    errors.push("invalid_visual_proof");
  if (!plan.parts.length || new Set(plan.parts.map((part) => part.partId)).size !== plan.parts.length) errors.push("plan_parts_invalid");
  const byId = new Map(plan.parts.map((part) => [part.partId, part])),
    resources = new Map<string, string>();
  for (const part of plan.parts) {
    if (!part.nodeId || !part.nodePath || !part.resourceUrl || (resources.has(part.resourceUrl) && resources.get(part.resourceUrl) !== part.resourceHash))
      errors.push("resource_binding_mismatch");
    resources.set(part.resourceUrl, part.resourceHash);
    if (!["text", "html"].includes(part.format)) errors.push("plan_format_invalid");
    if (
      !hash.safeParse(part.resourceHash).success ||
      !hash.safeParse(part.partId).success ||
      part.sourceHash !== sha256(part.source) ||
      part.byteLength !== Buffer.byteLength(part.source)
    )
      errors.push("plan_source_mismatch");
    if (badCharacters(part.source) || badCharacters(visible(part, part.source))) errors.push("source_character_integrity");
    if (part.format === "html" && htmlShape(part.source).active) errors.push("source_active_markup");
  }
  const ids = plan.requests.flatMap((request) => request.partIds),
    expected = plan.parts.map((part) => part.partId);
  if (stableJson(ids) !== stableJson(expected)) errors.push("request_coverage_mismatch");
  for (const request of plan.requests) {
    const bytes = request.partIds.reduce((sum, id) => sum + (byId.get(id)?.byteLength ?? 0), 0);
    if (
      !request.partIds.length ||
      request.partIds.length > POLICY_PLAN_LIMITS.requestParts ||
      bytes > POLICY_PLAN_LIMITS.requestBytes ||
      bytes !== request.sourceBytes ||
      request.id !== sha256(stableJson([plan.context, request.partIds]))
    )
      errors.push("request_binding_mismatch");
  }
  if (!Number.isSafeInteger(plan.sourceBytes) || plan.sourceBytes <= 0 || plan.sourceBytes > plan.parts.reduce((sum, part) => sum + part.byteLength, 0))
    errors.push("document_bytes_mismatch");
  if (
    plan.parts.length > POLICY_PLAN_LIMITS.nodes ||
    plan.sourceBytes > POLICY_PLAN_LIMITS.documentBytes ||
    Buffer.byteLength(stableJson(plan)) > POLICY_PLAN_LIMITS.planBytes
  )
    errors.push("plan_capacity_exceeded");
  return [...new Set(errors)];
}

/** No I/O, model call, persistence or permission grant. A verbatim quote is not semantic evidence validation. */
export function validatePolicyFulltextCandidate(plan: PolicyFulltextPlan, candidates: unknown) {
  const issues: CandidateIssue[] = planIssues(plan).map((code) => ({ partId: null, code }));
  const language = normalizeSourceLanguage(plan.context.language),
    accepted: CheckedPolicyPart[] = [];
  const invariants = language ? invariantParser(language) : null;
  if (!language) issues.push({ partId: null, code: "source_language_unknown" });
  const seen = new Set<string>(),
    duplicates = new Set<string>(),
    supplied = new Map<string, PolicyPartCandidate>();
  if (!Array.isArray(candidates)) issues.push({ partId: null, code: "candidate_list_required" });
  else
    for (const value of candidates) {
      const parsed = PolicyPartCandidateSchema.safeParse(value);
      if (!parsed.success) {
        const id = hash.safeParse(typeof value === "object" && value !== null ? value.partId : null);
        issues.push({ partId: id.success ? id.data : null, code: "candidate_schema_invalid" });
        continue;
      }
      const candidate = parsed.data;
      if (seen.has(candidate.partId)) {
        duplicates.add(candidate.partId);
        issues.push({ partId: candidate.partId, code: "duplicate_part" });
      }
      seen.add(candidate.partId);
      supplied.set(candidate.partId, candidate);
      if (!plan.parts.some((part) => part.partId === candidate.partId)) issues.push({ partId: candidate.partId, code: "unexpected_part" });
    }
  if (language && !issues.some((issue) => issue.partId === null && issue.code !== "candidate_schema_invalid"))
    for (const part of plan.parts) {
      const candidate = supplied.get(part.partId),
        reject = (code: string) => issues.push({ partId: part.partId, code });
      if (!candidate) {
        reject("missing_part");
        continue;
      }
      if (duplicates.has(part.partId)) continue;
      if (candidate.sourceHash !== part.sourceHash) {
        reject("source_hash_mismatch");
        continue;
      }
      const original = visible(part, part.source);
      if (candidate.facts.some((fact) => badCharacters(fact.statement) || badCharacters(fact.quote) || !original.includes(fact.quote))) {
        reject("fact_quote_invalid");
        continue;
      }
      const chinese = language.split("-")[0] === "zh";
      if (chinese ? candidate.zh !== null : candidate.zh === null) {
        reject("translation_mode_mismatch");
        continue;
      }
      const error = chinese ? null : translationIssue(part, candidate.zh!, invariants!);
      if (error) {
        reject(error);
        continue;
      }
      const content = candidate.zh ?? part.source;
      accepted.push({ ...candidate, content, contentHash: sha256(content) });
    }
  const resources = new Map<string, AssembledPolicyResource>();
  if (!issues.length && accepted.length === plan.parts.length)
    for (const [index, part] of plan.parts.entries()) {
      const checked = accepted[index]!,
        resource = resources.get(part.resourceUrl) ?? { resourceUrl: part.resourceUrl, resourceHash: part.resourceHash, blocks: [] };
      resource.blocks.push({
        partId: part.partId,
        nodeId: part.nodeId,
        nodePath: part.nodePath,
        format: part.format,
        content: checked.content,
        contentHash: checked.contentHash,
      });
      resources.set(part.resourceUrl, resource);
    }
  return {
    status: issues.length ? ("incomplete" as const) : ("program_validated" as const),
    revisionId: plan.revisionId,
    manifestHash: plan.manifestHash,
    context: { ...plan.context },
    accepted,
    assembled: issues.length ? null : [...resources.values()],
    issues,
    semantic_verified: false as const,
    runtime_authorization: "none" as const,
  };
}
export type PolicyFulltextValidation = ReturnType<typeof validatePolicyFulltextCandidate>;
