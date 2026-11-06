import { isModelRouteWaiting } from "@amp/backend/providers/model-fallback";
import { currentInterpretationQualification, currentInterpretationRecipe } from "./fallback-quality.ts";
import { RuntimeControlPaused, RuntimeControlStale } from "@amp/backend/operations/lane-controls";
import { z } from "zod";
import { createPolicyGateway, PolicyInputChangedError, type PreparedPolicyInput } from "../provider.ts";
import { extractJson, ModelOutputError } from "@amp/backend/providers/llm";
import {
  readPolicyResponse,
  readPolicyResponseForReceipt,
  readPolicyStageResponses,
  ReceiptBusyError,
  ReceiptUnknownError,
  ProviderRejectedError,
} from "@amp/backend/providers/receipts";
import { SourcePolicyConflict } from "@amp/backend/admin/sources";
import { promptText, promptVersion } from "@amp/backend/editorial/prompts";
import { readPolicyFulltextRun, assertPolicyRunCurrent, PolicyRunStaleError, type FulltextRun } from "./fulltext-store.ts";
import { validatePolicyFulltextCandidate } from "./fulltext-candidate.ts";
import { provenFulltextCandidates } from "./translation-memory.ts";
import {
  executePolicyInterpretation,
  InterpretationCapacityError,
  type InterpretationStage,
  type InterpretationOutput,
  type PreviousInterpretation,
} from "./interpretation-engine.ts";
import { CandidateReply, type RelatedPolicy } from "./interpretation-schema.ts";
import {
  beginInterpretation,
  interpretationStages,
  saveInterpretationStage,
  finishInterpretation,
  previousInterpretation,
  storedInterpretation,
  type StageCheckpoint,
} from "./interpretation-store.ts";
import { sha256, stableJson } from "@amp/backend/lib/ids";

export const interpretationRecipe = currentInterpretationRecipe;
type Proof = NonNullable<Awaited<ReturnType<typeof readPolicyResponse>>>;
import { policyModelEvidence, policyModelQualification, type ModelEvidence } from "./model-evidence.ts";
export type { ModelEvidence } from "./model-evidence.ts";
type BlockedStatus =
  | "paused"
  | "waiting_control"
  | "partial"
  | "blocked_unknown"
  | "invalid_output"
  | "invalid_fulltext_proof"
  | "fulltext_incomplete"
  | "stale"
  | "invalid_checkpoint"
  | "invalid_receipt_proof"
  | "blocked_capacity"
  | "waiting_receipt"
  | "provider_unavailable";
export type FinishedInterpretation = InterpretationOutput & {
  runId: string;
  interpretationRunId: string;
  recipeVersion: string;
  manifestHash: string;
  modelEvidence: ModelEvidence[];
  models: string[];
  modelEvidenceComplete: boolean;
  related: RelatedPolicy[];
  contentHash: string;
  requestsAttempted: number;
};
export type PolicyInterpretationResult =
  | FinishedInterpretation
  | { status: BlockedStatus; runId: string; requestsAttempted: number; semantic_verified: false; publication_authorized: false };
class StageBlocked extends Error {
  readonly status: BlockedStatus;
  constructor(status: BlockedStatus) {
    super(status);
    this.status = status;
  }
}
function decoded(proof: Proof) {
  const response = proof.response as { choices?: { message?: { content?: string }; finish_reason?: string }[] };
  const choice = response?.choices?.[0];
  if (!choice?.message?.content || (choice.finish_reason && choice.finish_reason !== "stop")) throw new StageBlocked("invalid_output");
  return extractJson(choice.message.content);
}
async function currentFulltext(runId: string) {
  const loaded = await readPolicyFulltextRun(runId);
  if (!loaded) return null;
  // Direct checkpoints and translation-memory reuse are proved by their real receipts; a Chinese original needs none.
  const proven = await provenFulltextCandidates(loaded.run);
  if (proven.unknown) throw new StageBlocked("blocked_unknown");
  if (proven.unproven) throw new StageBlocked("invalid_fulltext_proof");
  const models: ModelEvidence[] = proven.proofs.map((proof) => policyModelEvidence(proof));
  if (loaded.run.plan.context.visualRunId) {
    const { loadPolicyVisionProof } = await import("./vision-runtime.ts"),
      visual = await loadPolicyVisionProof(loaded.run.plan.context.visualRunId);
    if (
      !visual ||
      visual.revisionId !== loaded.run.snapshot.revisionId ||
      visual.contentHash !== loaded.run.plan.context.visualContentHash ||
      !loaded.run.plan.context.recipeVersion.endsWith(`/vision:${visual.recipe}`)
    )
      throw new StageBlocked("invalid_fulltext_proof");
    models.push(...visual.modelEvidence);
  }
  const fulltext = validatePolicyFulltextCandidate(loaded.run.plan, proven.candidates);
  if (fulltext.status !== "program_validated") throw new StageBlocked("fulltext_incomplete");
  return { run: loaded.run, fulltext, models };
}
/** The basis interpretation and the physical model evidence behind what it carries into this revision. */
async function basisFor(run: FulltextRun, recipeVersion: string, pinned?: string) {
  const found = await previousInterpretation(run.plan.context.expressionId, run.id, recipeVersion, pinned);
  if (!found) {
    if (pinned) throw new StageBlocked("invalid_checkpoint");
    return null;
  }
  const candidate = CandidateReply.safeParse(found.output.candidate);
  if (!candidate.success) return null;
  const previous: PreviousInterpretation = {
    fulltextRunId: found.fulltextRunId,
    plan: found.plan,
    candidate: candidate.data,
    verifiedClaims: Array.isArray(found.output.verifiedClaims) ? (found.output.verifiedClaims as string[]) : [],
  };
  const models: ModelEvidence[] = [];
  for (const item of (found.output.modelEvidence ?? []) as ModelEvidence[]) {
    const proof = await readPolicyResponse({ receiptId: item.receiptId, attemptId: item.attemptId });
    models.push(proof ? policyModelEvidence(proof) : { ...item, configurationHash: null });
  }
  return { previous, models };
}
function prepared(run: FulltextRun, recipeVersion: string, stage: InterpretationStage): PreparedPolicyInput {
  const resources = [...new Set(stage.parts.map((part) => part.resourceUrl))].map((url) => {
    const original = run.snapshot.resources.find((r) => r.url === url);
    if (!original?.sha256 || stage.parts.some((part) => part.resourceUrl === url && part.resourceHash !== original.sha256))
      throw new PolicyRunStaleError("Resource changed");
    return {
      source_id: run.snapshot.sourceId,
      material_id: sha256(stableJson([run.plan.context.expressionId, url])),
      revision: run.snapshot.sequence,
      content_hash: original.sha256,
      resource: { url, document_type: run.snapshot.manifest.identity.documentType, attachment: original.attachment },
    };
  });
  return {
    usageObject: { kind: "policy", id: run.snapshot.versionId },
    manifest: {
      schema_version: 1,
      kind: "source_materials",
      lane: "policy",
      materials: resources,
      upstream_artifacts: [
        { kind: "policy_stage_input", id: stage.id, version: recipeVersion, content_hash: stage.inputHash, manifest_id: run.plan.manifestHash },
        ...stage.upstream.map((ref) => ({
          kind: "policy_stage",
          id: ref.id,
          version: recipeVersion,
          content_hash: ref.hash,
          manifest_id: run.plan.manifestHash,
        })),
      ],
    },
    system: promptText(stage.prompt),
    user: stableJson(stage.payload),
    promptVersion: promptVersion(stage.prompt),
    recipeVersion,
    controlRevision: String(run.controlVersion),
    processingAllowed: true,
  };
}
function proofMatches(proof: Proof, stage: InterpretationStage, input: PreparedPolicyInput) {
  return (
    proof.purpose === stage.purpose &&
    proof.request.promptVersion === input.promptVersion &&
    proof.request.systemHash === sha256(input.system) &&
    proof.request.userHash === sha256(input.user) &&
    stableJson(proof.request.manifest) === stableJson(input.manifest)
  );
}

/** Same durable worker run/CAS and gateway as AI-17. No automatic queue registration or paid retry loop. */
async function runInterpretation(
  fulltextRunId: string,
  options: { root: AbortSignal; maxRequests?: number; related?: RelatedPolicy[]; readOnly?: boolean },
): Promise<PolicyInterpretationResult> {
  const max = options.maxRequests ?? 2;
  if (!Number.isSafeInteger(max) || max < 0) throw new Error("maxRequests must be a nonnegative fairness bound");
  let requestsAttempted = 0;
  const recipeVersion = interpretationRecipe(),
    related = structuredClone(options.related ?? []);
  if (related.length > 5)
    return { status: "blocked_capacity" as const, runId: fulltextRunId, requestsAttempted, semantic_verified: false, publication_authorized: false as const };
  const loaded = await currentFulltext(fulltextRunId);
  if (!loaded)
    return {
      status: "fulltext_incomplete" as const,
      runId: fulltextRunId,
      requestsAttempted,
      semantic_verified: false,
      publication_authorized: false as const,
    };
  const { run, fulltext } = loaded;
  const storage = options.readOnly
    ? { id: sha256(stableJson([run.id, recipeVersion])), fulltext: run, recipeVersion }
    : await beginInterpretation(run, recipeVersion);
  const saved = new Map((await interpretationStages(storage)).map((row) => [row.stage_id, row]));
  // A stored result pins the basis it was computed from, so a replay rebuilds the very same stage inputs.
  const stored = await storedInterpretation(storage);
  const pinned = (stored?.output?.changes as { basis?: string | null } | undefined)?.basis ?? undefined;
  const basis = await basisFor(run, recipeVersion, pinned);
  const models = [...loaded.models, ...(basis?.models ?? [])],
    inflight = new Map<string, InterpretationStage>();
  const gateway = createPolicyGateway({
    fallbackPolicy: {
      language: run.plan.context.language,
      fulltextRecipe: run.plan.context.recipeVersion,
      interpretationRecipe: currentInterpretationQualification(),
    },
    runtimeControl: run!.runtimeControl,
    root: options.root,
    resolve: async (ref, purpose) => {
      const stage = inflight.get(ref.id);
      if (!stage || stage.purpose !== purpose || ref.version !== storage.id) return null;
      await assertPolicyRunCurrent(run);
      return prepared(run, recipeVersion, stage);
    },
  });
  const call = async (stage: InterpretationStage) => {
    if (options.root.aborted) throw new StageBlocked("stale");
    const input = prepared(run, recipeVersion, stage),
      checkpoint = saved.get(stage.id);
    let proof: Proof | null = null;
    if (checkpoint) {
      proof = await readPolicyResponse({ receiptId: checkpoint.receipt_id, attemptId: checkpoint.attempt_id });
      if (!proof) throw new StageBlocked("blocked_unknown");
      if (checkpoint.input_hash !== stage.inputHash || !proofMatches(proof, stage, input)) throw new StageBlocked("invalid_checkpoint");
      if (checkpoint.status !== "accepted") throw new StageBlocked("invalid_output");
    } else {
      proof = (await readPolicyStageResponses(stage.id)).find((response) => proofMatches(response, stage, input)) ?? null;
      if (!proof) {
        if (options.readOnly || requestsAttempted >= max) throw new StageBlocked("partial");
        inflight.set(stage.id, stage);
        requestsAttempted++;
        try {
          const reply = await gateway.chat({ input: { id: stage.id, version: storage.id }, purpose: stage.purpose, schema: z.unknown(), maxTokens: 4096 });
          if (!reply.attemptId) throw new StageBlocked("blocked_unknown");
          proof = await readPolicyResponse({ receiptId: reply.receiptId, attemptId: reply.attemptId });
        } catch (error) {
          if (!(error instanceof ModelOutputError) || error.receiptId === null) throw error;
          proof = await readPolicyResponseForReceipt(error.receiptId);
        }
        if (!proof || !proofMatches(proof, stage, input)) throw new StageBlocked("invalid_receipt_proof");
      }
    }
    models.push(policyModelEvidence(proof));
    let result: unknown,
      accepted = false;
    try {
      result = stage.validate(decoded(proof));
      accepted = true;
    } catch {
      result = null;
    }
    if (!checkpoint && !options.readOnly) {
      const row: StageCheckpoint = {
        stage_id: stage.id,
        input_hash: stage.inputHash,
        purpose: stage.purpose,
        status: accepted ? "accepted" : "rejected",
        result,
        receipt_id: proof.receiptId,
        attempt_id: proof.attemptId,
      };
      const known = await saveInterpretationStage(storage, row, accepted);
      saved.set(stage.id, row);
      if (!known) throw new StageBlocked("blocked_unknown");
    }
    if (!accepted) throw new StageBlocked("invalid_output");
    if (checkpoint && stableJson(result) !== stableJson(checkpoint.result)) throw new StageBlocked("invalid_checkpoint");
    return result;
  };
  try {
    const output = await executePolicyInterpretation(
      {
        plan: run.plan,
        fulltext,
        recipeVersion,
        identity: {
          title: run.snapshot.manifest.officialTitle,
          number: run.snapshot.manifest.identity.documentNumber,
          jurisdiction: run.snapshot.manifest.identity.jurisdiction,
          sequence: run.snapshot.sequence,
        },
        context: { authority: run.snapshot.manifest.identity.authority ?? null, documentType: run.snapshot.manifest.identity.documentType ?? null },
        related,
        previous: basis?.previous ?? null,
      },
      call,
    );
    const uniqueModels = [...new Map(models.map((value) => [value.attemptId, value])).values()].sort(
      (a, b) => a.receiptId - b.receiptId || a.attemptId.localeCompare(b.attemptId),
    );
    const result = {
      ...output,
      runId: fulltextRunId,
      interpretationRunId: storage.id,
      recipeVersion,
      manifestHash: run.plan.manifestHash,
      modelEvidence: uniqueModels,
      ...policyModelQualification(uniqueModels),
      related,
    };
    await assertPolicyRunCurrent(run);
    const contentHash = options.readOnly ? sha256(stableJson(result)) : await finishInterpretation(storage, output.status, result);
    return { ...result, contentHash, requestsAttempted };
  } catch (error) {
    const status: BlockedStatus | null =
      error instanceof RuntimeControlPaused
        ? "paused"
        : error instanceof RuntimeControlStale
          ? "waiting_control"
          : error instanceof StageBlocked
            ? error.status
            : error instanceof ReceiptUnknownError
              ? "blocked_unknown"
              : error instanceof ReceiptBusyError
                ? "waiting_receipt"
                : error instanceof ProviderRejectedError || isModelRouteWaiting(error)
                  ? "provider_unavailable"
                  : error instanceof ModelOutputError
                    ? "invalid_output"
                    : error instanceof RuntimeControlPaused ||
                        error instanceof RuntimeControlStale ||
                        error instanceof PolicyRunStaleError ||
                        error instanceof PolicyInputChangedError ||
                        error instanceof SourcePolicyConflict
                      ? "stale"
                      : error instanceof InterpretationCapacityError
                        ? "blocked_capacity"
                        : null;
    if (!status) throw error;
    return { status, runId: fulltextRunId, requestsAttempted, semantic_verified: false, publication_authorized: false as const };
  }
}

export async function runPolicyInterpretation(
  fulltextRunId: string,
  options: { root: AbortSignal; maxRequests?: number; related?: RelatedPolicy[]; readOnly?: boolean },
): Promise<PolicyInterpretationResult> {
  try {
    return await runInterpretation(fulltextRunId, options);
  } catch (error) {
    const status: BlockedStatus | null =
      error instanceof RuntimeControlPaused
        ? "paused"
        : error instanceof RuntimeControlStale
          ? "waiting_control"
          : error instanceof StageBlocked
            ? error.status
            : error instanceof PolicyRunStaleError || error instanceof SourcePolicyConflict
              ? "stale"
              : null;
    if (!status) throw error;
    return { status, runId: fulltextRunId, requestsAttempted: 0, semantic_verified: false, publication_authorized: false as const };
  }
}

/** Replays real saved responses through current validators without new sends or writes. */
export async function loadPolicyInterpretation(fulltextRunId: string) {
  const loaded = await currentFulltext(fulltextRunId);
  if (!loaded) return null;
  const recipeVersion = interpretationRecipe(),
    storage = { id: sha256(stableJson([loaded.run.id, recipeVersion])), fulltext: loaded.run, recipeVersion };
  const stored = await storedInterpretation(storage);
  if (!stored?.output) return null;
  const result = await runPolicyInterpretation(fulltextRunId, {
    root: new AbortController().signal,
    maxRequests: 0,
    readOnly: true,
    related: (stored.output.related ?? []) as RelatedPolicy[],
  });
  return "candidate" in result ? { run: loaded.run, ...result } : null;
}
