import type { z } from "zod";
import { sha256, stableJson } from "../lib/ids.ts";
import type { PolicyPurpose } from "../providers/policy.ts";
import type { PolicyFulltextPlan, PolicyPart } from "./processing-plan.ts";
import type { PolicyFulltextValidation } from "./fulltext-candidate.ts";
import {
  GroupReply,
  MergeReply,
  CandidateReply,
  VerifyReply,
  checkEnvelope,
  sameIds,
  checkQuotes,
  checkCandidate,
  candidateClaims,
  checkVerification,
  aggregateVerification,
  type Group,
  type Candidate,
  type Quote,
  type Verification,
  type RelatedPolicy,
} from "./interpretation-schema.ts";

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
export type InterpretationInput = {
  plan: PolicyFulltextPlan;
  fulltext: PolicyFulltextValidation;
  recipeVersion: string;
  identity: { title: string; number: string | null; jurisdiction: string; sequence: number };
  related: RelatedPolicy[];
};
export type StageCaller = (stage: InterpretationStage) => Promise<unknown>;
type Node = { id: string; hash: string; partIds: string[]; summary: string; quotes: Quote[] };
export type InterpretationOutput = Awaited<ReturnType<typeof executePolicyInterpretation>>;
export class InterpretationCapacityError extends Error {}

/** The bounded graph is deterministic. The caller supplies the existing gateway and durable checkpoints, never a new scheduler. */
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
  const byPart = new Map(plan.parts.map((part) => [part.partId, part]));
  const selected = (ids: string[]) =>
    ids.map((id) => {
      const part = byPart.get(id);
      if (!part) throw new Error("unknown_part");
      return part;
    });
  const stage = async <S extends z.ZodType>(
    purpose: PolicyPurpose,
    prompt: string,
    body: Record<string, unknown>,
    partIds: string[],
    upstream: StageReference[],
    schema: S,
    check: (result: z.infer<S>, bound: { id: string; inputHash: string }) => void,
  ): Promise<z.infer<S>> => {
    const inputHash = sha256(stableJson([input.recipeVersion, plan.manifestHash, purpose, prompt, body, upstream]));
    const id = sha256(stableJson(["policy-stage", inputHash])),
      payload = { id, input_hash: inputHash, ...body };
    if (Buffer.byteLength(stableJson(payload)) > 26_000) throw new InterpretationCapacityError("stage_input_exceeds_capacity");
    const validate = (value: unknown) => {
      const result = schema.parse(value);
      check(result, { id, inputHash });
      return result;
    };
    return validate(await call({ id, inputHash, purpose, prompt, payload, parts: selected(partIds), upstream, validate }));
  };
  const groups: (Node & { result: Group })[] = [];
  for (const request of plan.requests) {
    const parts = selected(request.partIds),
      candidates = fulltext.accepted.filter((candidate) => request.partIds.includes(candidate.partId));
    sameIds(
      candidates.map((p) => p.partId),
      request.partIds,
    );
    const result = await stage(
      "policy_group",
      "policy-group-check",
      { phase: "group", parts, candidates },
      request.partIds,
      [{ id: plan.manifestHash, hash: sha256(stableJson(candidates)) }],
      GroupReply,
      (value, bound) => {
        checkEnvelope(value, { ...bound, inputIds: request.partIds });
        sameIds(
          value.roles.map((r) => r.part_id),
          request.partIds,
        );
        checkQuotes(value.quotes, parts);
      },
    );
    const group = { id: result.id, hash: sha256(stableJson(result)), partIds: request.partIds, summary: result.summary, quotes: result.quotes, result };
    groups.push(group);
    if (!result.consistent)
      return {
        status: "semantic_failed" as const,
        candidate: null,
        groups,
        verification: [],
        claims: [],
        reason: "group_inconsistent",
        semantic_verified: false,
        publication_authorized: false as const,
      };
  }
  let nodes: Node[] = groups;
  while (nodes.length > 1) {
    const parents: Node[] = [];
    for (let at = 0; at < nodes.length; ) {
      const children = [nodes[at++]!];
      while (
        at < nodes.length &&
        children.length < 6 &&
        Buffer.byteLength(stableJson([...children, nodes[at]!].map(({ id, hash, summary, quotes }) => ({ id, hash, summary, quotes })))) < 24_000
      )
        children.push(nodes[at++]!);
      if (children.length === 1) {
        if (parents.length === 0 && at < nodes.length) throw new InterpretationCapacityError("two_merge_children_exceed_capacity");
        parents.push(children[0]!);
        continue;
      }
      const partIds = children.flatMap((c) => c.partIds),
        quotes = children.flatMap((c) => c.quotes);
      sameIds(partIds, [...new Set(partIds)]);
      const result = await stage(
        "policy_group",
        "policy-group-merge",
        { phase: "merge", children: children.map(({ id, hash, summary, quotes }) => ({ id, hash, summary, quotes })) },
        partIds,
        children.map(({ id, hash }) => ({ id, hash })),
        MergeReply,
        (value, bound) => {
          checkEnvelope(value, { ...bound, inputIds: children.map((c) => c.id) });
          checkQuotes(value.quotes, selected(partIds), quotes);
        },
      );
      parents.push({ id: result.id, hash: sha256(stableJson(result)), partIds, summary: result.summary, quotes: result.quotes });
    }
    nodes = parents;
  }
  const merged = nodes[0]!;
  sameIds(
    merged.partIds,
    plan.parts.map((p) => p.partId),
  );
  const verification: { candidateHash: string; matrix: Verification[]; decisions: ReturnType<typeof aggregateVerification> }[] = [];
  let previous: Candidate | null = null,
    feedback: unknown[] = [];
  for (let round = 0; round < 2; round++) {
    const candidate: Candidate = await stage(
      "policy_interpret",
      "policy-interpret",
      {
        phase: "candidate",
        identity: input.identity,
        root: {
          id: merged.id,
          hash: merged.hash,
          summary: merged.summary,
          quotes: merged.quotes.map((quote) => ({ ...quote, node_path: byPart.get(quote.part_id)!.nodePath })),
        },
        related: input.related,
        ...(previous ? { previous_candidate: previous, revision_feedback: feedback } : {}),
      },
      merged.partIds,
      [{ id: merged.id, hash: merged.hash }],
      CandidateReply,
      (value, bound) => {
        checkEnvelope(value, { ...bound, inputIds: [merged.id] });
        checkQuotes(value.evidence, plan.parts, merged.quotes);
        checkCandidate(value, plan, input.identity, input.related);
      },
    );
    const claims = candidateClaims(candidate),
      candidateHash = sha256(stableJson(candidate));
    if (candidate.relevance !== "relevant")
      return {
        status: candidate.relevance,
        candidate,
        groups,
        root: merged,
        verification,
        claims,
        semantic_verified: false,
        publication_authorized: false as const,
      };
    const matrix: Verification[] = [];
    for (const group of groups) {
      const parts = selected(group.partIds);
      matrix.push(
        await stage(
          "policy_verify",
          "policy-verify",
          { phase: "verify", group_id: group.id, candidate_hash: candidateHash, claims, parts },
          group.partIds,
          [
            { id: group.id, hash: group.hash },
            { id: candidate.id, hash: candidateHash },
          ],
          VerifyReply,
          (value, bound) => checkVerification(value, { ...bound, groupId: group.id, candidateHash, claims, parts }),
        ),
      );
    }
    sameIds(
      matrix.map((v) => v.group_id),
      groups.map((g) => g.id),
    );
    const decisions = aggregateVerification(claims, matrix);
    verification.push({ candidateHash, matrix, decisions });
    if (decisions.every((d) => d.verdict === "passes"))
      return {
        status: "semantic_verified" as const,
        candidate,
        groups,
        root: merged,
        verification,
        claims,
        semantic_verified: true,
        publication_authorized: false as const,
      };
    if (round || decisions.some((d) => ["vetoes", "unsupported"].includes(d.verdict)))
      return {
        status: "semantic_failed" as const,
        candidate,
        groups,
        root: merged,
        verification,
        claims,
        semantic_verified: false,
        publication_authorized: false as const,
      };
    previous = candidate;
    feedback = matrix.flatMap((group) => group.judgments.filter((j) => j.verdict === "limits").map((j) => ({ group_id: group.group_id, ...j })));
  }
  throw new Error("unreachable_verification_round");
}
