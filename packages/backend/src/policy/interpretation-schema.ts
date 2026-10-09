import { z } from "zod";
import * as cheerio from "cheerio";
import { PolicyLegalState, PolicyImpact, Policy } from "@amp/contracts/http/public";
import type { TimeAssertion, SourceDateParseInput } from "@amp/contracts/time-assertion";
import { parseSourceDate } from "@amp/backend/admin/sources";
import { explicitPolicyReference } from "./references.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import type { PolicyFulltextPlan, PolicyPart } from "./processing-plan.ts";

const text = z
  .string()
  .min(1)
  .refine((value) => !!value.trim() && !value.includes("\0") && !value.includes("\uFFFD") && value.isWellFormed());
const id = text.max(80),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
export const Quote = z.strictObject({ part_id: id, quote: text.max(200) });
const envelope = { id: hash, input_hash: hash, input_ids: z.array(id).min(1) };
export const MergeReply = z.strictObject({ ...envelope, summary: text, quotes: z.array(Quote).min(1) });
export const GroupReply = MergeReply.extend({
  consistent: z.boolean(),
  roles: z.array(
    z.strictObject({
      part_id: id,
      roles: z.array(z.enum(["obligation", "definition", "scope", "exception", "commencement", "status", "reference", "other"])).min(1),
    }),
  ),
});
export const CandidateReply = z.strictObject({
  ...envelope,
  document_title: text,
  title_zh: text.max(250),
  instrument_number: text.nullable(),
  relevance: z.enum(["relevant", "excluded", "uncertain"]),
  relevance_evidence_ids: z.array(id),
  legal_state: PolicyLegalState,
  main_points: Policy.shape.main_points.max(16),
  impacts: z.array(PolicyImpact).max(12),
  relationships: Policy.shape.relationships.max(20),
  dynamic_zh: text.max(2000),
  gaps: z.array(text).max(5),
  comparisons: z.array(z.unknown()).max(0),
  evidence: z
    .array(z.strictObject({ id, part_id: id, quote: text.max(200) }))
    .min(1)
    .max(64),
});
export const VerifyReply = z.strictObject({
  id: hash,
  input_hash: hash,
  group_id: hash,
  candidate_hash: hash,
  judgments: z.array(
    z.strictObject({ claim_id: id, verdict: z.enum(["supports", "limits", "vetoes", "not_applicable"]), quotes: z.array(Quote), reason: text }),
  ),
  publication_authorized: z.literal(false),
});
export type Quote = z.infer<typeof Quote>;
export type Candidate = z.infer<typeof CandidateReply>;
export type Group = z.infer<typeof GroupReply>;
export type Merge = z.infer<typeof MergeReply>;
export type Verification = z.infer<typeof VerifyReply>;
export type Claim = { id: string; path: string; value: unknown; requiresSupport: boolean };
export type RelatedPolicy = { id: string; citation: string; url: string; jurisdiction: string; qualified: boolean };
export const originalText = (part: PolicyPart) => (part.format === "html" ? cheerio.load(part.source, null, false).root().text() : part.source);
export function sameIds(actual: string[], expected: string[]) {
  if (new Set(actual).size !== actual.length || stableJson([...actual].sort()) !== stableJson([...expected].sort())) throw new Error("coverage_mismatch");
}
export function checkQuotes(quotes: Quote[], parts: PolicyPart[], allowed?: Quote[]) {
  for (const quote of quotes) {
    const part = parts.find((p) => p.partId === quote.part_id);
    if (!part || !originalText(part).includes(quote.quote) || (allowed && !allowed.some((q) => q.part_id === quote.part_id && q.quote.includes(quote.quote))))
      throw new Error("quote_outside_actual_input");
  }
}
export function checkEnvelope(value: { id: string; input_hash: string; input_ids: string[] }, expected: { id: string; inputHash: string; inputIds: string[] }) {
  if (value.id !== expected.id || value.input_hash !== expected.inputHash) throw new Error("stage_binding_mismatch");
  sameIds(value.input_ids, expected.inputIds);
}

/** Compare source components, never infer a zone or numeric day/month ambiguity.
 * The parser envelope is discarded; it is not an acquisition receipt or a stored source-date observation. */
function checkDate(time: z.infer<typeof TimeAssertion>, evidence: Candidate["evidence"], plan: PolicyFulltextPlan, sequence: number) {
  const quote = evidence.find((q) => time.raw.trim() && q.quote.includes(time.raw));
  if (!quote) throw new Error("date_has_no_source_literal");
  if (time.precision === "unknown") return;
  const part = plan.parts.find((p) => p.partId === quote.part_id)!;
  const base: SourceDateParseInput = {
    binding: {
      articleId: sha256(stableJson([plan.context.expressionId, part.resourceUrl])),
      sourceId: plan.context.sourceId,
      revision: sequence,
      configHash: plan.manifestHash,
    },
    observationId: `validation:${part.partId}`,
    observedAt: new Date().toISOString(),
    url: part.resourceUrl,
    locator: part.nodePath,
    excerpt: quote.quote,
    origin: "source",
    format: "unknown",
    formatPattern: null,
    language: plan.context.language,
    publicationBasis: "other",
    timezoneEvidence: null,
    timezone: null,
    raw: time.raw,
    meaning: time.meaning,
    basis: time.basis,
    condition_text: time.condition_text,
  };
  const parses = [null, "D MMMM YYYY", "MMMM D, YYYY", "D MMM YYYY", "DD-MMM-YYYY"].map((pattern) =>
    parseSourceDate({ ...base, format: pattern ? "declared" : "unknown", formatPattern: pattern }),
  );
  const matches = parses.filter((p) => p.reason === null && p.evidence.time.raw === time.raw).map((p) => p.evidence.time);
  const fields = (value: z.infer<typeof TimeAssertion>) => [
    value.local_date,
    value.local_time,
    value.utc,
    value.timezone,
    value.precision,
    value.beijing_date,
    value.meaning_label,
    value.label,
  ];
  if (!matches.length || new Set(matches.map((match) => stableJson(fields(match)))).size !== 1 || stableJson(fields(matches[0]!)) !== stableJson(fields(time)))
    throw new Error("date_components_unproved");
}
export function checkCandidate(
  candidate: Candidate,
  plan: PolicyFulltextPlan,
  identity: { title: string; number: string | null; jurisdiction: string; sequence: number },
  related: RelatedPolicy[],
) {
  const corrupt = (value: unknown): boolean =>
    typeof value === "string"
      ? !value.isWellFormed() || value.includes("\0") || value.includes("\uFFFD")
      : Array.isArray(value)
        ? value.some(corrupt)
        : value && typeof value === "object"
          ? Object.values(value).some(corrupt)
          : false;
  if (corrupt(candidate)) throw new Error("candidate_character_integrity");
  if (candidate.document_title !== identity.title || candidate.instrument_number !== identity.number) throw new Error("official_identity_changed");
  if (new Set(candidate.evidence.map((e) => e.id)).size !== candidate.evidence.length) throw new Error("duplicate_evidence_id");
  checkQuotes(candidate.evidence, plan.parts);
  const ids = new Set(candidate.evidence.map((e) => e.id));
  const evidenceFor = (refs: string[]) => {
    if (refs.some((ref) => !ids.has(ref))) throw new Error("unknown_evidence_reference");
    return candidate.evidence.filter((e) => refs.includes(e.id));
  };
  if (candidate.relevance === "relevant" && !candidate.impacts.length) throw new Error("relevant_requires_impact");
  if (new Set(candidate.impacts.map((impact) => impact.id)).size !== candidate.impacts.length) throw new Error("duplicate_impact_id");
  if (candidate.relevance !== "uncertain" && !candidate.relevance_evidence_ids.length) throw new Error("relevance_requires_evidence");
  evidenceFor(candidate.relevance_evidence_ids);
  for (const item of [...candidate.main_points, ...candidate.impacts]) evidenceFor(item.evidence_ids);
  const states = [
    candidate.legal_state.nature,
    candidate.legal_state.legislative_stage,
    candidate.legal_state.publication,
    candidate.legal_state.enforcement,
    candidate.legal_state.repeal,
  ];
  for (const state of states) {
    evidenceFor(state.evidence_ids);
    if (state.value !== "unknown" && !state.evidence_ids.length) throw new Error("legal_state_requires_evidence");
  }
  if (candidate.legal_state.publication.time)
    checkDate(candidate.legal_state.publication.time, evidenceFor(candidate.legal_state.publication.evidence_ids), plan, identity.sequence);
  for (const item of [...candidate.legal_state.enforcement.arrangements, ...candidate.legal_state.applicability, ...candidate.legal_state.deadlines]) {
    const evidence = evidenceFor(item.evidence_ids);
    if (!evidence.length) throw new Error("date_arrangement_requires_evidence");
    if (item.time) checkDate(item.time, evidence, plan, identity.sequence);
  }
  for (const item of candidate.impacts) if (item.deadline) checkDate(item.deadline, evidenceFor(item.evidence_ids), plan, identity.sequence);
  for (const relation of candidate.relationships) {
    const evidence = evidenceFor(relation.evidence_ids);
    if (!evidence.some((e) => e.quote.includes(relation.target_citation))) throw new Error("relationship_citation_unproved");
    if (relation.target_policy_id) {
      const target = related.find((r) => r.id === relation.target_policy_id && r.citation === relation.target_citation && r.qualified);
      if (
        !target ||
        !evidence.some((e) => {
          const part = plan.parts.find((p) => p.partId === e.part_id);
          return part && explicitPolicyReference(part, target.citation, target.url, e.quote);
        }) ||
        (["updates", "corrects", "repeals"].includes(relation.relation) && target.jurisdiction !== identity.jurisdiction)
      )
        throw new Error("relationship_target_unproved");
    }
  }
}
export function candidateClaims(candidate: Candidate): Claim[] {
  const claims: Claim[] = [];
  const add = (path: string, value: unknown, requiresSupport = true) => claims.push({ id: sha256(stableJson([path, value])), path, value, requiresSupport });
  for (const key of ["document_title", "title_zh", "instrument_number", "dynamic_zh"] as const) add(key, candidate[key], candidate[key] !== null);
  add("relevance", { value: candidate.relevance, evidence_ids: candidate.relevance_evidence_ids }, candidate.relevance !== "uncertain");
  for (const key of ["nature", "legislative_stage", "publication", "enforcement", "repeal"] as const)
    add(`legal_state.${key}`, candidate.legal_state[key], candidate.legal_state[key].value !== "unknown");
  for (const [path, entries] of Object.entries({
    main_points: candidate.main_points,
    impacts: candidate.impacts,
    relationships: candidate.relationships,
    "legal_state.enforcement.arrangements": candidate.legal_state.enforcement.arrangements,
    "legal_state.applicability": candidate.legal_state.applicability,
    "legal_state.deadlines": candidate.legal_state.deadlines,
  }))
    entries.forEach((value, index) => {
      add(`${path}.${index}`, value);
    });
  candidate.gaps.forEach((value, index) => {
    add(`gaps.${index}`, value, false);
  });
  return claims;
}
export function checkVerification(
  value: Verification,
  expected: { id: string; inputHash: string; groupId: string; candidateHash: string; claims: Claim[]; parts: PolicyPart[] },
) {
  if (
    value.id !== expected.id ||
    value.input_hash !== expected.inputHash ||
    value.group_id !== expected.groupId ||
    value.candidate_hash !== expected.candidateHash
  )
    throw new Error("verification_binding_mismatch");
  sameIds(
    value.judgments.map((j) => j.claim_id),
    expected.claims.map((c) => c.id),
  );
  for (const judgment of value.judgments) {
    if (judgment.verdict === "not_applicable" ? judgment.quotes.length > 0 : !judgment.quotes.length) throw new Error("verification_quote_required");
    checkQuotes(judgment.quotes, expected.parts);
  }
}
export function aggregateVerification(claims: Claim[], matrix: Verification[]) {
  return claims.map((claim) => {
    const judgments = matrix.flatMap((group) => group.judgments.filter((j) => j.claim_id === claim.id));
    const verdict = judgments.some((j) => j.verdict === "vetoes")
      ? "vetoes"
      : judgments.some((j) => j.verdict === "limits")
        ? "limits"
        : claim.requiresSupport && !judgments.some((j) => j.verdict === "supports")
          ? "unsupported"
          : "passes";
    return { claimId: claim.id, verdict };
  });
}
