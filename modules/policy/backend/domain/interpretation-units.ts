/**
 * Deterministic grouping, change detection, carry-forward and verification for policy interpretation
 * (法规线成本设计 steps 2–4). Pure code: no database, model or network.
 *
 * - Grouping: a revision's plan parts are grouped into its provisions (第X条 / Artículo N / Article N, per resource)
 *   with the same splitter as the clause comparison; parts that hold no provision (preamble, headings) are their own
 *   unit. This replaces the old model group-check and merge calls.
 * - Changes: against the last interpreted revision of the same document and language, provisions are aligned with
 *   compareProvisions; added and modified provisions (and new non-provision text) are the only input of the paid
 *   interpret call, removed provisions are listed as context.
 * - Carry-forward: main points and impacts whose every evidence quote lies in an unchanged provision are kept, with
 *   their evidence rebound to this revision's parts; nothing is re-asked.
 * - Verification: code decides every claim it can (verbatim quotes, clause references, numbers and dates present in
 *   the cited source); only the rest goes to the model verifier.
 */
import { sha256, stableJson } from "@amp/backend/lib/ids";
import type { PolicyFulltextPlan, PolicyPart } from "./processing-plan.ts";
import { chineseNumber, compareProvisions, locateProvisionBlocks, normalizeProvisionText, type Provision } from "./provisions.ts";
import { candidateClaims, originalText, type Candidate, type Claim } from "./interpretation-schema.ts";

export type PolicyUnit = {
  /** Unique inside one revision: resource URL plus provision key, or the first part of an unnumbered block. */
  id: string;
  resourceUrl: string;
  label: string | null;
  /** Provision hash, or the hash of the normalized text of an unnumbered block. */
  hash: string;
  provision: Provision | null;
  partIds: string[];
};
export type RevisionUnits = { units: PolicyUnit[]; partUnits: Map<string, string[]>; provisionNumbers: Set<number> | null };

/** Group a plan's parts into provisions (per resource, in document order) and unnumbered blocks. */
export function policyUnits(plan: Pick<PolicyFulltextPlan, "parts" | "context">): RevisionUnits {
  const units: PolicyUnit[] = [],
    partUnits = new Map<string, string[]>();
  let numbers: Set<number> | null = null;
  const resources = [...new Set(plan.parts.map((part) => part.resourceUrl))];
  for (const url of resources) {
    const parts = plan.parts.filter((part) => part.resourceUrl === url);
    const located = locateProvisionBlocks(
      parts.map((part) => originalText(part)),
      { language: plan.context.language },
    );
    if (located.split.numbering) {
      numbers ??= new Set();
      for (const provision of located.split.provisions) if (!provision.key.includes("/")) numbers.add(Number.parseInt(provision.key, 10));
    }
    const byOrdinal = new Map<number, PolicyUnit>();
    parts.forEach((part, index) => {
      const owned = located.blocks[index]!;
      if (!owned.length) {
        const unit: PolicyUnit = {
          id: `${url}#part:${part.partId}`,
          resourceUrl: url,
          label: null,
          hash: sha256(normalizeProvisionText(originalText(part))),
          provision: null,
          partIds: [part.partId],
        };
        units.push(unit);
        partUnits.set(part.partId, [unit.id]);
        return;
      }
      const ids: string[] = [];
      for (const ordinal of owned) {
        let unit = byOrdinal.get(ordinal);
        if (!unit) {
          const provision = located.split.provisions[ordinal]!;
          unit = { id: `${url}#${provision.key}`, resourceUrl: url, label: provision.label, hash: provision.hash, provision, partIds: [] };
          byOrdinal.set(ordinal, unit);
          units.push(unit);
        }
        unit.partIds.push(part.partId);
        ids.push(unit.id);
      }
      partUnits.set(part.partId, ids);
    });
  }
  return { units, partUnits, provisionNumbers: numbers };
}

export type UnitChange = { unit: PolicyUnit; change: "added" | "modified" | "unchanged"; before: PolicyUnit | null };
export type RevisionChanges = { entries: UnitChange[]; removed: PolicyUnit[]; previousToCurrent: Map<string, string> };

/** Align the previous interpreted revision's units with the current ones. No previous revision: everything is new. */
export function revisionChanges(previous: RevisionUnits | null, current: RevisionUnits): RevisionChanges {
  if (!previous) return { entries: current.units.map((unit) => ({ unit, change: "added", before: null })), removed: [], previousToCurrent: new Map() };
  const entries = new Map<string, UnitChange>(),
    removed: PolicyUnit[] = [],
    previousToCurrent = new Map<string, string>();
  const resources = [...new Set([...previous.units, ...current.units].map((unit) => unit.resourceUrl))];
  for (const url of resources) {
    const before = previous.units.filter((unit) => unit.resourceUrl === url),
      after = current.units.filter((unit) => unit.resourceUrl === url);
    const numbered = (units: PolicyUnit[]) => units.filter((unit) => unit.provision);
    const comparison = compareProvisions(
      numbered(before).map((unit) => unit.provision!),
      numbered(after).map((unit) => unit.provision!),
    );
    const unitOf = (units: PolicyUnit[], provision: Provision | null) => units.find((unit) => unit.provision === provision) ?? null;
    for (const entry of comparison.entries) {
      const from = unitOf(numbered(before), entry.from),
        to = unitOf(numbered(after), entry.to);
      if (entry.change === "removed") removed.push(from!);
      else {
        entries.set(to!.id, { unit: to!, change: entry.change === "unchanged" ? "unchanged" : entry.change, before: from });
        if (entry.change === "unchanged") previousToCurrent.set(from!.id, to!.id);
      }
    }
    // Unnumbered blocks (preamble, headings, notes) match by normalized text.
    const plain = before.filter((unit) => !unit.provision);
    for (const unit of after.filter((u) => !u.provision)) {
      const match = plain.find((old) => old.hash === unit.hash && !previousToCurrent.has(old.id));
      if (match) previousToCurrent.set(match.id, unit.id);
      entries.set(unit.id, { unit, change: match ? "unchanged" : "added", before: match ?? null });
    }
  }
  return { entries: current.units.map((unit) => entries.get(unit.id)!), removed, previousToCurrent };
}

type Evidence = Candidate["evidence"][number];
/**
 * Rebind one previous evidence quote to this revision: its old part must lie only in unchanged units, and the same
 * quote must be found in a part of the matching current unit. Returns the rebound evidence or null.
 */
function rebind(
  evidence: Evidence,
  previous: { plan: Pick<PolicyFulltextPlan, "parts">; units: RevisionUnits },
  current: { plan: Pick<PolicyFulltextPlan, "parts">; units: RevisionUnits },
  changes: RevisionChanges,
): Evidence | null {
  const oldUnits = previous.units.partUnits.get(evidence.part_id) ?? [];
  if (!oldUnits.length || oldUnits.some((id) => !changes.previousToCurrent.has(id))) return null;
  const targets = new Set(oldUnits.map((id) => changes.previousToCurrent.get(id)!));
  const candidates = current.plan.parts.filter((part) => (current.units.partUnits.get(part.partId) ?? []).some((id) => targets.has(id)));
  const oldPart = previous.plan.parts.find((part) => part.partId === evidence.part_id);
  const holds = (part: PolicyPart) =>
    evidence.annotation_id
      ? part.annotations?.find((a) => a.annotation_id === evidence.annotation_id)?.value ===
          oldPart?.annotations?.find((a) => a.annotation_id === evidence.annotation_id)?.value && !!oldPart
      : originalText(part).includes(evidence.quote);
  const part = candidates.find(holds);
  return part ? { ...evidence, part_id: part.partId } : null;
}

/** Whole-document fields of a candidate; main points and impacts are per provision and merged separately. */
export const DOCUMENT_FIELDS = [
  "title_zh",
  "relevance",
  "relevance_evidence_ids",
  "legal_state",
  "publication_events",
  "relationships",
  "dynamic_zh",
  "gaps",
] as const;
export type Accumulated = Pick<Candidate, (typeof DOCUMENT_FIELDS)[number] | "main_points" | "impacts" | "evidence">;
const referencedIds = (value: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) for (const item of value) referencedIds(item, out);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value))
      if (key === "evidence_ids" || key === "relevance_evidence_ids") for (const ref of item as string[]) out.add(ref);
      else referencedIds(item, out);
  return out;
};
export const evidenceReferences = referencedIds;
/** Drop evidence nobody references. */
export function pruneEvidence<T extends Accumulated>(value: T): T {
  const used = referencedIds([...DOCUMENT_FIELDS.map((key): unknown => value[key]), value.main_points, value.impacts]);
  return { ...value, evidence: value.evidence.filter((e) => used.has(e.id)) };
}

/**
 * The previous candidate carried into this revision. Main points and impacts survive only when every evidence item
 * they cite was rebound. Document fields are returned with their evidence ids filtered to the rebound ones, as
 * context for the model; `complete` says whether everything survived (then no call is needed at all).
 */
export function carryForward(
  previous: { plan: Pick<PolicyFulltextPlan, "parts">; units: RevisionUnits; candidate: Candidate },
  current: { plan: Pick<PolicyFulltextPlan, "parts">; units: RevisionUnits },
  changes: RevisionChanges,
) {
  const evidence = new Map<string, Evidence>();
  for (const item of previous.candidate.evidence) {
    const bound = rebind(item, previous, current, changes);
    if (bound) evidence.set(item.id, bound);
  }
  const kept = <T extends { evidence_ids: string[] }>(items: T[]) => items.filter((item) => item.evidence_ids.every((ref) => evidence.has(ref)));
  const main_points = kept(previous.candidate.main_points),
    impacts = kept(previous.candidate.impacts);
  const complete =
    evidence.size === previous.candidate.evidence.length &&
    main_points.length === previous.candidate.main_points.length &&
    impacts.length === previous.candidate.impacts.length;
  const filterRefs = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(filterRefs)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).map(([key, item]) =>
              key === "evidence_ids" || key === "relevance_evidence_ids"
                ? [key, (item as string[]).filter((ref) => evidence.has(ref))]
                : [key, filterRefs(item)],
            ),
          )
        : value;
  const document = Object.fromEntries(DOCUMENT_FIELDS.map((key) => [key, filterRefs(previous.candidate[key])])) as Pick<
    Candidate,
    (typeof DOCUMENT_FIELDS)[number]
  >;
  const carried: Accumulated = { ...document, main_points, impacts, evidence: [...evidence.values()] };
  return { carried: complete ? carried : pruneEvidence(carried), complete };
}

/** Numbers, normalized: full-width digits, thousands separators and leading zeros do not matter. */
export function numbersIn(value: string): Set<string> {
  const out = new Set<string>();
  const ascii = value.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  for (const match of ascii.matchAll(/\d+(?:[.,]\d+)*/g)) out.add(match[0].replace(/[.,]/g, "").replace(/^0+(?=\d)/, ""));
  for (const match of value.matchAll(/[零〇一二两三四五六七八九十百千]+/g)) {
    const number = chineseNumber(match[0]);
    if (number !== null) out.add(String(number));
  }
  return out;
}
/** Article numbers a text refers to (第X条, Artículo N, Art. N, Article N, Section N). */
export function clauseNumbers(value: string): number[] {
  const out: number[] = [];
  for (const match of value.matchAll(/第\s*([零〇一二两三四五六七八九十百千0-9０-９]+)\s*条/g)) {
    const number = chineseNumber(match[1]!);
    if (number !== null) out.push(number);
  }
  for (const match of value.matchAll(/(?:Art[íi]culo|ART[ÍI]CULO|Art\.|Article|ARTICLE|Section|SECTION|Sec\.)\s*(\d+)/gu)) out.push(Number(match[1]));
  return out;
}

const CLAUSE_MENTION =
  /第\s*([零〇一二两三四五六七八九十百千0-9０-９]+)\s*条|(?:Art[íi]culo|ART[ÍI]CULO|Art\.|Article|ARTICLE|Section|SECTION|Sec\.)\s*(\d+)/gu;
/** Remove mentions of articles that exist in this revision, so their numbers are not read as stated quantities. */
function withoutOwnClauses(value: string, numbers: Set<number> | null) {
  if (!numbers) return value;
  return value.replace(CLAUSE_MENTION, (mention, zh: string | undefined, latin: string | undefined) => {
    const number = zh ? chineseNumber(zh) : Number(latin);
    return number !== null && numbers.has(number) ? " " : mention;
  });
}
export type ClaimDecision = { claimId: string; path: string; verdict: "passes" | "undecided" | "fails"; reason: string };
const textOf = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map(textOf).join("\n")
      : value && typeof value === "object"
        ? Object.entries(value)
            .filter(
              ([key]) =>
                !["evidence_ids", "relevance_evidence_ids", "id", "theme", "effect_mode", "time", "deadline", "occurrence", "clause_ref"].includes(key),
            )
            .map(([, item]) => textOf(item))
            .join("\n")
        : "";

/**
 * Decide each claim by code where possible (checkCandidate has already proved quotes, evidence references, dates
 * and relationship citations). A claim passes when every number it states appears in the source it cites (the
 * whole revision for uncited summaries) and every article it names exists; a named article that does not exist
 * fails it. Everything else, and every relevance=excluded, is undecided and goes to the model verifier.
 */
export function deterministicDecisions(
  candidate: Candidate,
  plan: Pick<PolicyFulltextPlan, "parts">,
  units: RevisionUnits,
  verifiedBefore: ReadonlySet<string> = new Set(),
): { claims: Claim[]; decisions: ClaimDecision[] } {
  const claims = candidateClaims(candidate);
  const quotes = new Map(candidate.evidence.map((e) => [e.id, e.quote]));
  const whole = plan.parts.map((part) => originalText(part)).join("\n");
  const decide = (claim: Claim): Omit<ClaimDecision, "claimId" | "path"> => {
    if (!claim.requiresSupport) return { verdict: "passes", reason: "not_a_factual_claim" };
    if (["document_title", "instrument_number"].includes(claim.path)) return { verdict: "passes", reason: "official_identity_set_by_code" };
    if (verifiedBefore.has(sha256(stableJson([claim.path.replace(/\.\d+$/, ""), claim.value]))))
      return { verdict: "passes", reason: "carried_from_verified_revision" };
    if (claim.path === "relevance") {
      const value = claim.value as { value: string };
      return value.value === "excluded" ? { verdict: "undecided", reason: "exclusion_hides_policy" } : { verdict: "passes", reason: "evidence_quoted" };
    }
    if (claim.path.startsWith("main_points.")) {
      const point = claim.value as Candidate["main_points"][number];
      if (units.provisionNumbers && clauseNumbers(point.clause_ref).some((n) => !units.provisionNumbers!.has(n)))
        return { verdict: "fails", reason: "clause_ref_not_in_revision" };
    }
    const refs = [...evidenceReferences(claim.value)];
    const cited = refs.length ? refs.map((ref) => quotes.get(ref) ?? "").join("\n") : whole;
    const allowed = numbersIn(cited);
    // Article numbers of this revision were checked as references above, not as quantities.
    const stated = [...numbersIn(withoutOwnClauses(textOf(claim.value), units.provisionNumbers))];
    if (stated.every((n) => allowed.has(n))) return { verdict: "passes", reason: refs.length ? "numbers_in_cited_quotes" : "numbers_in_revision" };
    return { verdict: "undecided", reason: "number_not_in_cited_source" };
  };
  return { claims, decisions: claims.map((claim) => ({ claimId: claim.id, path: claim.path, ...decide(claim) })) };
}
/** Value-level keys of verified claims, so the same item carried into a later revision is not re-verified. */
export const verifiedClaimKeys = (claims: Claim[], passed: ReadonlySet<string>) =>
  claims.filter((claim) => passed.has(claim.id)).map((claim) => sha256(stableJson([claim.path.replace(/\.\d+$/, ""), claim.value])));
/** Items whose failure removes only themselves; any other failed claim fails the interpretation. */
export const REMOVABLE_CLAIMS =
  /^(main_points|impacts|publication_events|relationships|legal_state\.enforcement\.arrangements|legal_state\.applicability|legal_state\.deadlines)\.(\d+)$/;
