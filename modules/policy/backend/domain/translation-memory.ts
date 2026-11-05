/**
 * Translation memory and checkpoint proof for the policy fulltext stage (法规线成本设计 step 1).
 *
 * A request names each source only by its hash ({sourceHash, format, source}); the fulltext recipe hash binds the
 * language, prompt and candidate recipe but no document identity. So identical text produces identical request
 * bytes and an identical reply wherever it appears, and a checked translation is remembered under
 * (recipe hash, exact source hash) in policy.fulltext_parts together with the real paid receipt that produced it.
 * A new revision of a document, or another document with a byte-identical paragraph, reuses it and only new or
 * modified parts are sent. Reuse is proved, not trusted: the receipt must have sent exactly this source hash under
 * this recipe and its reply must contain exactly this candidate apart from the part identity. Every reused
 * candidate is still validated against the new part by the fulltext validator before it counts.
 */
import { extractJson } from "@amp/backend/providers/llm";
import { readPolicyResponse } from "@amp/backend/providers/receipts";
import { stableJson } from "@amp/backend/lib/ids";
import { candidateFromReply, originalReadingCandidates } from "./fulltext-candidate.ts";
import { fulltextCheckpoints, withCurrentPolicyRun, type FulltextRun } from "./fulltext-store.ts";
import type { PolicyPart } from "./processing-plan.ts";

export type PolicyResponseProof = NonNullable<Awaited<ReturnType<typeof readPolicyResponse>>>;
type Artifact = { kind: string; id: string; version: string; content_hash: string };
type Checkpoint = { partId: string; sourceHash: string; candidate: unknown; receiptId: number; attemptId: string };

/** The reply parts of one real fulltext response, or [] when it did not finish as JSON. */
export function fulltextReplyParts(response: unknown): Record<string, unknown>[] {
  const choice = (response as { choices?: { message?: { content?: unknown }; finish_reason?: string | null }[] } | null)?.choices?.[0];
  if (typeof choice?.message?.content !== "string" || (choice.finish_reason && choice.finish_reason !== "stop")) return [];
  try {
    const value = extractJson(choice.message.content) as { parts?: unknown };
    return Array.isArray(value?.parts) ? value.parts.filter((part): part is Record<string, unknown> => !!part && typeof part === "object") : [];
  } catch {
    return [];
  }
}

/** Whether a policy_fulltext receipt sent this exact source under this recipe. */
export function requestedSource(request: { manifest?: unknown }, sourceHash: string, recipeHash: string) {
  const artifacts = (request.manifest as { upstream_artifacts?: Artifact[] } | undefined)?.upstream_artifacts ?? [];
  return artifacts.some((a) => a.kind === "policy_part" && a.content_hash === sourceHash && a.version === recipeHash);
}

/** One stored checkpoint is backed by the actual paid reply it names (directly or through translation memory). */
export function checkpointProven(
  point: Pick<Checkpoint, "partId" | "sourceHash" | "candidate">,
  proof: Pick<PolicyResponseProof, "purpose" | "request" | "response">,
  recipeHash: string,
) {
  return (
    proof.purpose === "policy_fulltext" &&
    requestedSource(proof.request, point.sourceHash, recipeHash) &&
    fulltextReplyParts(proof.response).some(
      (reply) => reply.sourceHash === point.sourceHash && stableJson(candidateFromReply(reply, point.partId)) === stableJson(point.candidate),
    )
  );
}

/**
 * The run's candidates with the receipts that prove them. A Chinese original needs no receipt: code accepts every
 * part as its own reading text. `unproven` counts stored checkpoints whose receipt is missing or does not match.
 */
export async function provenFulltextCandidates(run: FulltextRun) {
  const original = originalReadingCandidates(run.plan);
  if (original) return { candidates: original as unknown[], proofs: [] as PolicyResponseProof[], unknown: 0, unproven: 0 };
  const candidates: unknown[] = [],
    proofs = new Map<string, PolicyResponseProof | null>();
  let unknown = 0,
    unproven = 0;
  for (const point of await fulltextCheckpoints(run)) {
    const key = `${point.receiptId}:${point.attemptId}`;
    if (!proofs.has(key)) proofs.set(key, await readPolicyResponse({ receiptId: Number(point.receiptId), attemptId: point.attemptId }));
    const proof = proofs.get(key);
    if (!proof) unknown++;
    else if (!checkpointProven(point, proof, run.recipeHash)) unproven++;
    else candidates.push(point.candidate);
  }
  return { candidates, proofs: [...proofs.values()].filter((p): p is PolicyResponseProof => p !== null), unknown, unproven };
}

/**
 * Translation memory: bind already-paid translations of byte-identical sources (any earlier revision or document of
 * the same language and recipe) to these parts. No model call; returns how many parts were bound.
 */
export async function reuseRememberedTranslations(run: FulltextRun, parts: PolicyPart[]) {
  if (!parts.length) return 0;
  const hashes = [...new Set(parts.map((part) => part.sourceHash))];
  const rows = await withCurrentPolicyRun(
    run,
    (tx) => tx<
      Checkpoint[]
    >`SELECT DISTINCT ON (source_hash) part_id AS "partId",source_hash AS "sourceHash",candidate,receipt_id AS "receiptId",attempt_id AS "attemptId"
      FROM policy.fulltext_parts WHERE recipe_hash=${run.recipeHash} AND source_hash IN ${tx(hashes)} ORDER BY source_hash,created_at,part_id`,
  );
  const bound: Checkpoint[] = [];
  const proofs = new Map<string, PolicyResponseProof | null>();
  for (const part of parts) {
    const row = rows.find((r) => r.sourceHash === part.sourceHash);
    if (!row) continue;
    const key = `${row.receiptId}:${row.attemptId}`;
    if (!proofs.has(key)) proofs.set(key, await readPolicyResponse({ receiptId: Number(row.receiptId), attemptId: row.attemptId }));
    const proof = proofs.get(key),
      point = { partId: part.partId, sourceHash: part.sourceHash, candidate: { ...(row.candidate as Record<string, unknown>), partId: part.partId } };
    if (proof && checkpointProven(point, proof, run.recipeHash)) bound.push({ ...point, receiptId: Number(row.receiptId), attemptId: row.attemptId });
  }
  if (bound.length)
    await withCurrentPolicyRun(run, async (tx) => {
      for (const point of bound)
        await tx`INSERT INTO policy.fulltext_parts(part_id,recipe_hash,source_hash,candidate,receipt_id,attempt_id)
          VALUES(${point.partId},${run.recipeHash},${point.sourceHash},${tx.json(point.candidate as never)},${point.receiptId},${point.attemptId}) ON CONFLICT DO NOTHING`;
    });
  return bound.length;
}
