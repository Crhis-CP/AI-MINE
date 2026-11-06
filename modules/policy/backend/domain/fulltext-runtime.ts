import { isModelRouteWaiting } from "@amp/backend/providers/model-fallback";
import { currentInterpretationQualification } from "./fallback-quality.ts";
import { RuntimeControlPaused, RuntimeControlStale } from "@amp/backend/operations/lane-controls";
import { z } from "zod";
import { promptText, promptVersion } from "@amp/backend/editorial/prompts";
import { createPolicyGateway, PolicyInputChangedError, type PreparedPolicyInput } from "../provider.ts";
import { ModelOutputError } from "@amp/backend/providers/llm";
import { readPolicyPartResponses, ReceiptBusyError, ReceiptUnknownError, PolicyPartLimitError, ProviderRejectedError } from "@amp/backend/providers/receipts";
import { normalizeSourceLanguage } from "@amp/backend/sources/config-keys";
import { readPolicyOriginal } from "./originals.ts";
import { extractPolicyOriginal, type ExtractionProfile } from "./extraction.ts";
import { buildPolicyFulltextPlan, POLICY_PLAN_LIMITS, type PolicyPart } from "./processing-plan.ts";
import {
  candidateFromReply,
  FULLTEXT_CANDIDATE_RECIPE,
  originalReadingCandidates,
  validatePolicyFulltextCandidate,
  PolicyPartCandidateSchema,
} from "./fulltext-candidate.ts";
import {
  assertPolicyRunCurrent,
  beginPolicyFulltext,
  finishPolicyFulltext,
  saveFulltextResponse,
  PolicyRunStaleError,
  type FulltextRun,
} from "./fulltext-store.ts";
import { fulltextReplyParts, provenFulltextCandidates, requestedSource, reuseRememberedTranslations } from "./translation-memory.ts";
import { sha256, stableJson } from "@amp/backend/lib/ids";

const PROMPT = "policy-fulltext";
export const policyFulltextRecipeVersion = (vision?: string) => `${promptVersion(PROMPT)}/${FULLTEXT_CANDIDATE_RECIPE}${vision ? `/vision:${vision}` : ""}`;
/**
 * Memory key of a run: language and recipe only. No document identity, so byte-identical text translated under the
 * same prompt is reusable across revisions and documents (法规线成本设计 step 1).
 */
const recipeFor = (plan: FulltextRun["plan"]) =>
  sha256(stableJson(["policy-fulltext-memory-1", normalizeSourceLanguage(plan.context.language) ?? plan.context.language, plan.context.recipeVersion]));
/** Unique sources (first occurrence order) packed under the plan's per-request limits. */
function batches(parts: PolicyPart[]) {
  const unique = [...new Map(parts.map((part) => [part.sourceHash, part])).values()],
    out: PolicyPart[][] = [];
  let group: PolicyPart[] = [],
    bytes = 0;
  for (const part of unique) {
    if (group.length && (group.length === POLICY_PLAN_LIMITS.requestParts || bytes + part.byteLength > POLICY_PLAN_LIMITS.requestBytes)) {
      out.push(group);
      group = [];
      bytes = 0;
    }
    group.push(part);
    bytes += part.byteLength;
  }
  if (group.length) out.push(group);
  return out;
}

/** An explicit worker invocation, not a scheduler: bounded new sends resume from real paid receipts and checkpoints. */
export async function runPolicyFulltext(expressionId: string, profileValue: ExtractionProfile, options: { root: AbortSignal; maxRequests?: number }) {
  const profile = { ...profileValue },
    max = options.maxRequests ?? 2;
  if (!Number.isSafeInteger(max) || max < 1) throw new Error("maxRequests must be a positive fairness limit");
  const snapshot = await readPolicyOriginal(expressionId);
  if (!snapshot) throw new Error("Policy original missing");
  const extraction = await extractPolicyOriginal(expressionId, profile);
  const recipeVersion = policyFulltextRecipeVersion(extraction.visualProof?.recipe);
  const plan = buildPolicyFulltextPlan(extraction, {
    sourceId: snapshot.sourceId,
    expressionId,
    language: snapshot.language,
    identityHash: sha256(stableJson([snapshot.manifest.officialTitle, snapshot.manifest.identity])),
    recipeVersion,
    ...(extraction.visualProof ? { visualRunId: extraction.visualProof.runId, visualContentHash: extraction.visualProof.contentHash } : {}),
  });
  if (plan.status !== "planned") return plan;
  if (plan.revisionId !== snapshot.revisionId) return { status: "stale" as const };
  const run = await beginPolicyFulltext(snapshot, plan, recipeFor(plan));
  if (!run) return { status: "paused" as const };
  let requests = 0;
  const requestParts = new Map<string, PolicyPart[]>();
  const load = async (parts: PolicyPart[]): Promise<PreparedPolicyInput> => {
    await assertPolicyRunCurrent(run);
    const original = await readPolicyOriginal(expressionId);
    if (!original || original.revisionId !== snapshot.revisionId || original.sequence !== snapshot.sequence) throw new PolicyRunStaleError("Original changed");
    const resources = [...new Set(parts.map((p) => p.resourceUrl))].map((url) => {
      const resource = original.resources.find((r) => r.url === url);
      if (!resource?.sha256 || parts.some((p) => p.resourceUrl === url && p.resourceHash !== resource.sha256))
        throw new PolicyRunStaleError("Resource hash changed");
      return {
        source_id: original.sourceId,
        material_id: sha256(stableJson([expressionId, url])),
        revision: original.sequence,
        content_hash: resource.sha256,
        resource: { url, document_type: original.manifest.identity.documentType, attachment: resource.attachment },
      };
    });
    return {
      manifest: {
        schema_version: 1,
        kind: "source_materials",
        lane: "policy",
        materials: resources,
        upstream_artifacts: parts.map((p) => ({
          kind: "policy_part",
          id: p.partId,
          version: run.recipeHash,
          content_hash: p.sourceHash,
          manifest_id: plan.manifestHash,
        })),
      },
      usageObject: { kind: "policy", id: original.versionId },
      system: promptText(PROMPT),
      // Only the language and the unique sources: no title, identity, part or node identifiers, so identical text
      // yields byte-identical requests in every document (and a stable prefix for the provider's input cache).
      user: stableJson({
        language: normalizeSourceLanguage(plan.context.language) ?? plan.context.language,
        parts: [...new Map(parts.map((p) => [p.sourceHash, { sourceHash: p.sourceHash, format: p.format, source: p.source }])).values()],
      }),
      promptVersion: promptVersion(PROMPT),
      recipeVersion,
      controlRevision: String(run.controlVersion),
      processingAllowed: true,
    };
  };
  const gateway = createPolicyGateway({
    fallbackPolicy: { language: plan.context.language, fulltextRecipe: plan.context.recipeVersion, interpretationRecipe: currentInterpretationQualification() },
    runtimeControl: run!.runtimeControl,
    root: options.root,
    resolve: async (ref, purpose) => {
      const parts = requestParts.get(ref.id);
      return purpose === "policy_fulltext" && ref.version === run.id && parts ? load(parts) : null;
    },
  });
  const recover = async () => {
    const original = originalReadingCandidates(plan);
    if (original) return validatePolicyFulltextCandidate(plan, original);
    const responses = await readPolicyPartResponses(
      plan.parts.map((p) => p.partId),
      run.recipeHash,
    );
    for (const response of responses) {
      const artifacts = (response.request.manifest?.upstream_artifacts ?? []).filter((a) => a.kind === "policy_part" && a.version === run.recipeHash);
      const requested = plan.parts.filter((p) => artifacts.some((a) => a.id === p.partId && a.content_hash === p.sourceHash));
      const replies = fulltextReplyParts(response.response);
      const candidates = requested.flatMap((part) => {
        const reply = replies.find((r) => r.sourceHash === part.sourceHash);
        const parsed = reply && PolicyPartCandidateSchema.safeParse(candidateFromReply(reply, part.partId));
        return parsed?.success && requestedSource(response.request, part.sourceHash, run.recipeHash) ? [parsed.data] : [];
      });
      const checked = validatePolicyFulltextCandidate(plan, candidates);
      const accepted = checked.accepted.map((p) => ({ partId: p.partId, sourceHash: p.sourceHash, candidate: candidates.find((c) => c.partId === p.partId)! }));
      const samePlan = response.request.manifest?.upstream_artifacts?.every((a) => a.manifest_id === plan.manifestHash);
      await saveFulltextResponse(
        run,
        response,
        accepted,
        samePlan ? requested.length > 0 && requested.every((p) => accepted.some((a) => a.partId === p.partId)) : null,
      );
    }
    // A stored candidate still needs both its immutable source binding and the actual paid response.
    return validatePolicyFulltextCandidate(plan, (await provenFulltextCandidates(run)).candidates);
  };
  try {
    let checked = await recover();
    const missing = () => plan.parts.filter((p) => !checked.accepted.some((done) => done.partId === p.partId));
    // Translation memory first: byte-identical sources already paid for in any revision or document cost nothing.
    if (missing().length && (await reuseRememberedTranslations(run, missing()))) checked = await recover();
    while (missing().length && requests < max) {
      const sources = new Set(batches(missing())[0]!.map((p) => p.sourceHash)),
        parts = missing().filter((p) => sources.has(p.sourceHash));
      const id = sha256(stableJson([plan.context, parts.map((p) => p.partId)]));
      requestParts.set(id, parts);
      requests++;
      try {
        await gateway.chat({
          input: { id, version: run.id },
          purpose: "policy_fulltext",
          schema: z.object({ parts: z.array(z.unknown()) }),
          maxTokens: 4096,
        });
      } catch (error) {
        if (!(error instanceof ModelOutputError)) throw error;
      }
      checked = await recover();
    }
    await finishPolicyFulltext(run, checked, checked.status === "program_validated");
    return { ...checked, runId: run.id, requestsAttempted: requests, acceptedParts: checked.accepted.length, totalParts: plan.parts.length };
  } catch (error) {
    const status =
      error instanceof RuntimeControlPaused
        ? "paused"
        : error instanceof RuntimeControlStale
          ? "waiting_control"
          : error instanceof PolicyPartLimitError
            ? "blocked_retry_limit"
            : error instanceof ReceiptUnknownError
              ? "blocked_unknown"
              : error instanceof ReceiptBusyError
                ? "waiting_receipt"
                : error instanceof ProviderRejectedError || isModelRouteWaiting(error)
                  ? "provider_unavailable"
                  : error instanceof PolicyRunStaleError || error instanceof PolicyInputChangedError
                    ? "stale"
                    : null;
    if (!status) throw error;
    return { status, runId: run.id, requestsAttempted: requests, semantic_verified: false as const, runtime_authorization: "none" as const };
  }
}

export { setPolicyProcessingPaused, readPolicyFulltextRun, withCurrentPolicyRun, type FulltextRun } from "./fulltext-store.ts";
