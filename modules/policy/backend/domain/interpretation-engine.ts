import type { z } from "zod";
import { sha256, stableJson } from "@amp/backend/lib/ids";
import type { PolicyPurpose } from "../provider.ts";
import type { PolicyFulltextPlan, PolicyPart } from "./processing-plan.ts";
import type { PolicyFulltextValidation } from "./fulltext-candidate.ts";
import {
  CandidateReply,
  InterpretDelta,
  VerifyDelta,
  checkCandidate,
  checkQuotes,
  originalText,
  type Candidate,
  type Claim,
  type RelatedPolicy,
} from "./interpretation-schema.ts";
import {
  carryForward,
  deterministicDecisions,
  DOCUMENT_FIELDS,
  evidenceReferences,
  policyUnits,
  pruneEvidence,
  REMOVABLE_CLAIMS,
  revisionChanges,
  verifiedClaimKeys,
  type Accumulated,
  type ClaimDecision,
  type PolicyUnit,
  type UnitChange,
} from "./interpretation-units.ts";

export type StageReference = { id: string; hash: string };
export type InterpretationStage = {
  id: string;
  inputHash: string;
  purpose: PolicyPurpose;
  prompt: string;
  payload: Record<string, unknown>;
  parts: PolicyPart[];
  upstream: StageReference[];
  validate(value: unknown): unknown;
};
/** The last interpreted revision of the same document and language: its plan and verified candidate. */
export type PreviousInterpretation = { fulltextRunId: string; plan: PolicyFulltextPlan; candidate: Candidate; verifiedClaims: string[] };
export type InterpretationInput = {
  plan: PolicyFulltextPlan;
  fulltext: PolicyFulltextValidation;
  recipeVersion: string;
  identity: { title: string; number: string | null; jurisdiction: string; sequence: number };
  /** Minimal document context sent with the changed provisions. */
  context?: { authority: string | null; documentType: string | null };
  related: RelatedPolicy[];
  previous?: PreviousInterpretation | null;
};
export type StageCaller = (stage: InterpretationStage) => Promise<unknown>;
export type InterpretationOutput = Awaited<ReturnType<typeof executePolicyInterpretation>>;
export class InterpretationCapacityError extends Error {}

/** Bytes of provision text per interpret call; the rest of the 26 kB stage input is context and known evidence. */
export const INTERPRET_CHUNK_BYTES = 16_000;
const STAGE_LIMIT = 26_000;
const MAX = { main_points: 16, impacts: 12, evidence: 64 } as const;

/** Merge one call's delta into the accumulated interpretation; document fields come from the newer call. */
function merge(base: Accumulated, delta: InterpretDelta, prefix: string, prefer: "delta" | "base"): Accumulated {
  const own = new Map(delta.evidence.map((e) => [e.id, `${prefix}-${e.id}`]));
  const rename = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(rename)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).map(([key, item]) =>
              key === "evidence_ids" || key === "relevance_evidence_ids" ? [key, (item as string[]).map((ref) => own.get(ref) ?? ref)] : [key, rename(item)],
            ),
          )
        : value;
  const renamed = rename(delta) as InterpretDelta;
  const taken = new Set(base.impacts.map((impact) => impact.id));
  const impacts = renamed.impacts.map((impact) => (taken.has(impact.id) ? { ...impact, id: `${prefix}-${impact.id}` } : impact));
  const order = <T>(older: T[], newer: T[]) => (prefer === "delta" ? [...newer, ...older] : [...older, ...newer]);
  const value: Accumulated = {
    ...(Object.fromEntries(DOCUMENT_FIELDS.map((key) => [key, renamed[key]])) as Pick<Candidate, (typeof DOCUMENT_FIELDS)[number]>),
    main_points: order(base.main_points, renamed.main_points).slice(0, MAX.main_points),
    impacts: order(base.impacts, impacts).slice(0, MAX.impacts),
    evidence: [...base.evidence, ...renamed.evidence.map((e) => ({ ...e, id: own.get(e.id)! }))],
  };
  const pruned = pruneEvidence(value);
  while (pruned.evidence.length > MAX.evidence && (pruned.main_points.length > 1 || pruned.impacts.length > 1)) {
    if (pruned.main_points.length > 1) pruned.main_points.pop();
    else pruned.impacts.pop();
    Object.assign(pruned, pruneEvidence(pruned));
  }
  return pruned;
}

/**
 * Interpretation by change (法规线成本设计): deterministic provision grouping, interpret calls only for added and
 * modified provisions (all provisions, chunk-bounded, for a first version), carry-forward of unchanged main points
 * and impacts, deterministic verification, and one model verification only for claims code cannot decide.
 * The caller supplies the existing gateway and durable checkpoints, never a new scheduler.
 */
export async function executePolicyInterpretation(input: InterpretationInput, call: StageCaller) {
  const { plan, fulltext } = input;
  if (
    fulltext.status !== "program_validated" ||
    fulltext.manifestHash !== plan.manifestHash ||
    fulltext.revisionId !== plan.revisionId ||
    fulltext.semantic_verified !== false ||
    fulltext.runtime_authorization !== "none"
  )
    throw new Error("fulltext_not_program_validated");
  const refs = new Map(plan.parts.map((part, index) => [part.partId, `p${index + 1}`])),
    byRef = new Map(plan.parts.map((part, index) => [`p${index + 1}`, part]));
  const toPart = (ref: string) => {
    const part = byRef.get(ref);
    if (!part) throw new Error("unknown_part_reference");
    return part.partId;
  };
  const units = policyUnits(plan);
  const previous = input.previous ? { ...input.previous, units: policyUnits(input.previous.plan) } : null;
  const changes = revisionChanges(previous?.units ?? null, units);
  const changed = changes.entries.filter((entry) => entry.change !== "unchanged");
  const carry = previous ? carryForward(previous, { plan, units }, changes) : null;
  const stats = {
    mode: previous ? ("amendment" as const) : ("first_version" as const),
    basis: previous?.fulltextRunId ?? null,
    units: units.units.length,
    changed: changed.length,
    removed: changes.removed.length,
    carriedMainPoints: carry?.carried.main_points.length ?? 0,
    carriedImpacts: carry?.carried.impacts.length ?? 0,
    interpretStages: 0,
    verifyStages: 0,
  };
  const stage = async <S extends z.ZodType>(
    purpose: PolicyPurpose,
    prompt: string,
    body: Record<string, unknown>,
    partIds: string[],
    upstream: StageReference[],
    check: (value: unknown) => z.infer<S>,
  ): Promise<z.infer<S>> => {
    const inputHash = sha256(stableJson([input.recipeVersion, plan.manifestHash, purpose, prompt, body, upstream]));
    const id = sha256(stableJson(["policy-stage", inputHash]));
    if (Buffer.byteLength(stableJson(body)) > STAGE_LIMIT) throw new InterpretationCapacityError("stage_input_exceeds_capacity");
    const parts = plan.parts.filter((part) => partIds.includes(part.partId));
    // The caller validates the actual reply (fresh or checkpointed) with `check` and returns that validated value.
    return (await call({ id, inputHash, purpose, prompt, payload: body, parts, upstream: [...upstream], validate: check })) as z.infer<S>;
  };
  const envelope = (accumulated: Accumulated, inputHash: string) =>
    CandidateReply.parse({
      id: sha256(stableJson(["policy-candidate", inputHash])),
      input_hash: inputHash,
      input_ids: [plan.manifestHash],
      document_title: input.identity.title,
      instrument_number: input.identity.number,
      comparisons: [],
      ...accumulated,
    });

  // 1. Interpret only what changed (everything, chunk-bounded, for a first version).
  let accumulated: Accumulated | null = carry?.complete && !changed.length ? carry.carried : null;
  const upstream: StageReference[] = previous ? [{ id: previous.fulltextRunId, hash: sha256(stableJson(previous.candidate)) }] : [];
  if (!accumulated) {
    const chunks = chunkUnits(changed.length ? changed : units.units.map((unit) => ({ unit, change: "added" as const, before: null })), plan);
    let base: Accumulated | null = carry?.carried ?? null;
    for (const [index, chunk] of chunks.entries()) {
      const knownIds = base ? evidenceReferences(DOCUMENT_FIELDS.map((key) => base![key])) : new Set<string>();
      const known = (base?.evidence ?? []).filter((e) => knownIds.has(e.id));
      const chunkParts = new Set(chunk.flatMap((entry) => entry.unit.partIds));
      const body = {
        phase: "interpret",
        mode: stats.mode,
        chunk: { index: index + 1, count: chunks.length },
        document: {
          title: input.identity.title,
          number: input.identity.number,
          jurisdiction: input.identity.jurisdiction,
          authority: input.context?.authority ?? null,
          document_type: input.context?.documentType ?? null,
          language: plan.context.language,
        },
        so_far: base
          ? {
              ...Object.fromEntries(DOCUMENT_FIELDS.map((key) => [key, base![key]])),
              main_points: base.main_points.map((point) => point.text),
            }
          : null,
        known_evidence: known.map((e) => ({ id: e.id, part: refs.get(e.part_id)!, quote: e.quote })),
        provisions: chunk.map((entry) => ({
          label: entry.unit.label,
          change: entry.change,
          ...(entry.change === "modified" && entry.before?.provision ? { before: beforeText(entry.before) } : {}),
          parts: entry.unit.partIds
            .filter((id) => chunkParts.has(id))
            .map((id) => ({ ref: refs.get(id)!, text: originalText(plan.parts.find((p) => p.partId === id)!) })),
        })),
        ...(index === 0 && changes.removed.length ? { removed: changes.removed.map((unit) => ({ label: unit.label, before: beforeText(unit) })) } : {}),
        related: input.related,
      };
      const prior = base;
      const inputIds = [...chunkParts];
      const delta = await stage<typeof InterpretDelta>("policy_interpret", "policy-interpret", body, inputIds, upstream, (value) => {
        const parsed = InterpretDelta.parse(value);
        const mapped: InterpretDelta = { ...parsed, evidence: parsed.evidence.map((e) => ({ ...e, part_id: toPart(e.part_id) })) };
        // A quote must come from a part this call actually saw; reused evidence must be one of the known ids.
        if (mapped.evidence.some((e) => !chunkParts.has(e.part_id))) throw new Error("quote_outside_actual_input");
        if (mapped.evidence.some((e) => knownIds.has(e.id))) throw new Error("evidence_id_reused");
        checkQuotes(mapped.evidence, plan.parts);
        const merged = merge(
          prior ?? { ...mapped, main_points: [], impacts: [], evidence: [] },
          mapped,
          sha256(stableJson([index, body])).slice(0, 8),
          stats.mode === "amendment" ? "delta" : "base",
        );
        checkCandidate(envelope(merged, plan.manifestHash), plan, input.identity, input.related);
        return mapped;
      });
      stats.interpretStages++;
      base = merge(
        base ?? { ...delta, main_points: [], impacts: [], evidence: [] },
        delta,
        sha256(stableJson([index, body])).slice(0, 8),
        stats.mode === "amendment" ? "delta" : "base",
      );
      upstream.push({ id: sha256(stableJson(body)), hash: sha256(stableJson(delta)) });
    }
    accumulated = base!;
  }
  let candidate = envelope(accumulated, sha256(stableJson([plan.manifestHash, upstream])));
  checkCandidate(candidate, plan, input.identity, input.related);
  const claimsOf = () => deterministicDecisions(candidate, plan, units, new Set(previous?.verifiedClaims ?? []));
  let { claims, decisions } = claimsOf();
  const result = (status: "semantic_verified" | "semantic_failed" | "excluded" | "uncertain", reason?: string) => {
    const passed = new Set(decisions.filter((d) => d.verdict === "passes").map((d) => d.claimId));
    return {
      status,
      candidate,
      claims,
      decisions,
      verifiedClaims: status === "semantic_verified" || status === "excluded" ? verifiedClaimKeys(claims, passed) : [],
      changes: stats,
      ...(reason ? { reason } : {}),
      semantic_verified: status === "semantic_verified" || status === "excluded",
      publication_authorized: false as const,
    };
  };
  if (candidate.relevance === "uncertain") return result("uncertain");

  // 2. Model verification only for claims code could not decide (one bounded call per chunk of claims).
  const undecided = decisions.filter((d) => d.verdict === "undecided");
  if (undecided.length) {
    const verdicts = new Map<string, string>();
    for (const batch of claimBatches(undecided, claims, candidate, plan, refs)) {
      const body = {
        phase: "verify",
        candidate_hash: sha256(stableJson(candidate)),
        claims: batch.claims.map((claim) => ({ id: claim.id, path: claim.path, value: claim.value })),
        evidence: batch.evidence.map((e) => ({ id: e.id, part: refs.get(e.part_id)!, quote: e.quote })),
        parts: batch.parts.map((part) => ({ ref: refs.get(part.partId)!, text: originalText(part) })),
      };
      const reply = await stage<typeof VerifyDelta>(
        "policy_verify",
        "policy-verify",
        body,
        batch.parts.map((part) => part.partId),
        [{ id: candidate.id, hash: sha256(stableJson(candidate)) }],
        (value) => {
          const parsed = VerifyDelta.parse(value);
          const ids = parsed.judgments.map((j) => j.claim_id),
            expected = batch.claims.map((claim) => claim.id);
          if (new Set(ids).size !== ids.length || stableJson([...ids].sort()) !== stableJson([...expected].sort())) throw new Error("coverage_mismatch");
          for (const judgment of parsed.judgments) {
            if (judgment.verdict === "not_applicable" ? judgment.quotes.length > 0 : !judgment.quotes.length) throw new Error("verification_quote_required");
            checkQuotes(
              judgment.quotes.map((q) => ({ ...q, part_id: toPart(q.part_id) })),
              batch.parts,
            );
          }
          return parsed;
        },
      );
      stats.verifyStages++;
      for (const judgment of reply.judgments) verdicts.set(judgment.claim_id, judgment.verdict);
    }
    decisions = decisions.map((d) =>
      d.verdict === "undecided"
        ? { ...d, verdict: verdicts.get(d.claimId) === "supports" ? "passes" : "fails", reason: `model_${verdicts.get(d.claimId)}` }
        : d,
    ) as ClaimDecision[];
  }

  // 3. A failed removable item is dropped (no rewrite call); any other failed claim fails the interpretation.
  const failed = decisions.filter((d) => d.verdict === "fails");
  if (failed.some((d) => !REMOVABLE_CLAIMS.test(d.path))) return result("semantic_failed", "document_claim_failed");
  if (failed.length) {
    const drop = (path: string, list: unknown[]) => list.filter((_, index) => !failed.some((d) => d.path === `${path}.${index}`));
    const next = structuredClone(candidate) as Candidate;
    next.main_points = drop("main_points", next.main_points) as Candidate["main_points"];
    next.impacts = drop("impacts", next.impacts) as Candidate["impacts"];
    next.relationships = drop("relationships", next.relationships) as Candidate["relationships"];
    if (next.publication_events) next.publication_events = drop("publication_events", next.publication_events) as Candidate["publication_events"];
    next.legal_state.enforcement.arrangements = drop("legal_state.enforcement.arrangements", next.legal_state.enforcement.arrangements) as never;
    next.legal_state.applicability = drop("legal_state.applicability", next.legal_state.applicability) as never;
    next.legal_state.deadlines = drop("legal_state.deadlines", next.legal_state.deadlines) as never;
    const pruned = pruneEvidence(next);
    if (!pruned.evidence.length || (pruned.relevance === "relevant" && !pruned.impacts.length)) return result("semantic_failed", "nothing_left_after_removal");
    candidate = CandidateReply.parse(pruned);
    checkCandidate(candidate, plan, input.identity, input.related);
    // Every remaining claim must already have passed (same value), or pass by code on the reduced candidate.
    const passed = new Set(decisions.filter((d) => d.verdict === "passes").map((d) => d.claimId));
    ({ claims, decisions } = deterministicDecisions(
      candidate,
      plan,
      units,
      new Set([...(previous?.verifiedClaims ?? []), ...verifiedClaimKeys(claims, passed)]),
    ));
    if (decisions.some((d) => d.verdict !== "passes")) return result("semantic_failed", "removal_changed_claims");
  }
  return result(candidate.relevance === "excluded" ? "excluded" : "semantic_verified");
}

const beforeText = (unit: PolicyUnit) => (unit.provision ? `${unit.provision.heading ? `${unit.provision.heading}\n` : ""}${unit.provision.text}` : "");
/** Serialized size of one part or provision as sent (JSON escaping and field names included). */
const partBytes = (id: string, plan: PolicyFulltextPlan) =>
  Buffer.byteLength(JSON.stringify({ ref: `p${plan.parts.length}`, text: originalText(plan.parts.find((p) => p.partId === id)!) })) + 1;
const unitBytes = (entry: UnitChange, plan: PolicyFulltextPlan) =>
  entry.unit.partIds.reduce((sum, id) => sum + partBytes(id, plan), 0) +
  Buffer.byteLength(JSON.stringify({ label: entry.unit.label, change: entry.change, parts: [] })) +
  (entry.change === "modified" && entry.before ? Buffer.byteLength(JSON.stringify(beforeText(entry.before))) + 10 : 0);

/** Changed units in document order, packed into calls of at most INTERPRET_CHUNK_BYTES of provision text. */
function chunkUnits(entries: UnitChange[], plan: PolicyFulltextPlan) {
  const chunks: UnitChange[][] = [];
  let current: UnitChange[] = [],
    bytes = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    // A part holding several provisions is sent once, with the first of them.
    const fresh = { ...entry, unit: { ...entry.unit, partIds: entry.unit.partIds.filter((id) => !seen.has(id)) } };
    for (const id of fresh.unit.partIds) seen.add(id);
    if (!fresh.unit.partIds.length) continue;
    const size = unitBytes(fresh, plan);
    if (size > INTERPRET_CHUNK_BYTES) {
      // One very long provision: split by its parts; every part is far below the chunk size.
      if (current.length) chunks.push(current);
      current = [];
      bytes = 0;
      let piece: string[] = [],
        pieceBytes = 0;
      for (const id of fresh.unit.partIds) {
        const size = partBytes(id, plan);
        if (piece.length && pieceBytes + size > INTERPRET_CHUNK_BYTES) {
          chunks.push([{ ...fresh, before: null, unit: { ...fresh.unit, partIds: piece } }]);
          piece = [];
          pieceBytes = 0;
        }
        piece.push(id);
        pieceBytes += size;
      }
      if (piece.length) chunks.push([{ ...fresh, before: null, unit: { ...fresh.unit, partIds: piece } }]);
      continue;
    }
    if (current.length && bytes + size > INTERPRET_CHUNK_BYTES) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(fresh);
    bytes += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/** Undecided claims with the evidence they cite and the parts holding it, packed under the stage limit. */
function claimBatches(undecided: ClaimDecision[], claims: Claim[], candidate: Candidate, plan: PolicyFulltextPlan, refs: Map<string, string>) {
  const batches: { claims: Claim[]; evidence: Candidate["evidence"]; parts: PolicyPart[] }[] = [];
  let current: (typeof batches)[number] = { claims: [], evidence: [], parts: [] };
  const size = (batch: typeof current) =>
    Buffer.byteLength(
      stableJson([batch.claims.map((c) => c.value), batch.evidence.map((e) => [e.id, refs.get(e.part_id), e.quote]), batch.parts.map((p) => originalText(p))]),
    );
  for (const decision of undecided) {
    const claim = claims.find((c) => c.id === decision.claimId)!;
    const cited = [...evidenceReferences(claim.value)];
    const evidence = cited.length ? candidate.evidence.filter((e) => cited.includes(e.id)) : candidate.evidence;
    const parts = plan.parts.filter((part) => evidence.some((e) => e.part_id === part.partId));
    const next = {
      claims: [...current.claims, claim],
      evidence: [...new Map([...current.evidence, ...evidence].map((e) => [e.id, e])).values()],
      parts: [...new Map([...current.parts, ...parts].map((p) => [p.partId, p])).values()],
    };
    if (current.claims.length && size(next) > INTERPRET_CHUNK_BYTES) {
      batches.push(current);
      current = { claims: [claim], evidence, parts };
    } else current = next;
    if (size(current) > STAGE_LIMIT - 2_000) throw new InterpretationCapacityError("verification_input_exceeds_capacity");
  }
  if (current.claims.length) batches.push(current);
  return batches;
}
