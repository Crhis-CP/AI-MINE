import { z } from "zod";
import { createPolicyGateway, PolicyInputChangedError, type PreparedPolicyInput } from "../providers/policy.ts";
import { extractJson, ModelOutputError } from "@amp/backend/providers/llm";
import {
  readPolicyResponse,
  readPolicyResponseForReceipt,
  readPolicyStageResponses,
  ReceiptBusyError,
  ReceiptUnknownError,
  ProviderRejectedError,
} from "@amp/backend/providers/receipts";
import { SourcePolicyConflict } from "../sources/permission-store.ts";
import { promptText, promptVersion } from "@amp/backend/editorial/prompts";
import { readPolicyFulltextRun, fulltextCheckpoints, assertPolicyRunCurrent, PolicyRunStaleError, type FulltextRun } from "./fulltext-store.ts";
import { validatePolicyFulltextCandidate } from "./fulltext-candidate.ts";
import { executePolicyInterpretation, InterpretationCapacityError, type InterpretationStage, type InterpretationOutput } from "./interpretation-engine.ts";
import type { RelatedPolicy } from "./interpretation-schema.ts";
import {
  beginInterpretation,
  interpretationStages,
  saveInterpretationStage,
  finishInterpretation,
  storedInterpretation,
  type StageCheckpoint,
} from "./interpretation-store.ts";
import { sha256, stableJson } from "../lib/ids.ts";

const PROMPTS = ["policy-group-check", "policy-group-merge", "policy-interpret", "policy-verify"] as const;
export const interpretationRecipe = () => sha256(stableJson(["policy-interpretation-1", ...PROMPTS.map((name) => promptVersion(name))]));
type Proof = NonNullable<Awaited<ReturnType<typeof readPolicyResponse>>>;
export type ModelEvidence = { receiptId: number; attemptId: string; service: string; requestedModel: string | null; reportedModel: string | null };
type BlockedStatus =
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
function modelEvidence(proof: Proof): ModelEvidence {
  const model = (proof.response as { model?: unknown })?.model;
  return {
    receiptId: proof.receiptId,
    attemptId: proof.attemptId,
    service: proof.service,
    requestedModel: proof.model,
    reportedModel: typeof model === "string" && model.trim() ? model : null,
  };
}
async function currentFulltext(runId: string) {
  const loaded = await readPolicyFulltextRun(runId);
  if (!loaded) return null;
  const checkpoints = await fulltextCheckpoints(loaded.run),
    candidates: unknown[] = [],
    models: ModelEvidence[] = [];
  const proofs = new Map<number, Proof>();
  for (const point of checkpoints) {
    const proof = proofs.get(point.receiptId) ?? (await readPolicyResponse({ receiptId: point.receiptId, attemptId: point.attemptId }));
    if (!proof || proof.attemptId !== point.attemptId || proof.purpose !== "policy_fulltext" || !proof.knownUsage) throw new StageBlocked("blocked_unknown");
    proofs.set(point.receiptId, proof);
    const artifacts = (proof.request.manifest as { upstream_artifacts?: { kind: string; id: string; version: string; content_hash: string }[] })
      ?.upstream_artifacts;
    if (
      !artifacts?.some(
        (artifact) =>
          artifact.kind === "policy_part" &&
          artifact.id === point.partId &&
          artifact.content_hash === point.sourceHash &&
          artifact.version === loaded.run.recipeHash,
      )
    )
      throw new StageBlocked("invalid_fulltext_proof");
    const raw = decoded(proof) as { parts?: unknown[] };
    if (!raw.parts?.some((part) => stableJson(part) === stableJson(point.candidate))) throw new StageBlocked("invalid_fulltext_proof");
    candidates.push(point.candidate);
  }
  for (const proof of proofs.values()) models.push(modelEvidence(proof));
  const fulltext = validatePolicyFulltextCandidate(loaded.run.plan, candidates);
  if (fulltext.status !== "program_validated") throw new StageBlocked("fulltext_incomplete");
  return { run: loaded.run, fulltext, models };
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
  const models = [...loaded.models],
    inflight = new Map<string, InterpretationStage>();
  const gateway = createPolicyGateway({
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
      if (!proof?.knownUsage) throw new StageBlocked("blocked_unknown");
      if (checkpoint.input_hash !== stage.inputHash || !proofMatches(proof, stage, input)) throw new StageBlocked("invalid_checkpoint");
      if (checkpoint.status !== "accepted") throw new StageBlocked("invalid_output");
    } else {
      proof = (await readPolicyStageResponses(stage.id)).find((response) => proofMatches(response, stage, input)) ?? null;
      if (proof && !proof.knownUsage) throw new StageBlocked("blocked_unknown");
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
    models.push(modelEvidence(proof));
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
        related,
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
      models: [...new Set(uniqueModels.flatMap((m) => (m.reportedModel ? [m.reportedModel] : [])))].sort(),
      modelEvidenceComplete: uniqueModels.every((m) => !!m.reportedModel),
      related,
    };
    await assertPolicyRunCurrent(run);
    const contentHash = options.readOnly ? sha256(stableJson(result)) : await finishInterpretation(storage, output.status, result);
    return { ...result, contentHash, requestsAttempted };
  } catch (error) {
    const status: BlockedStatus | null =
      error instanceof StageBlocked
        ? error.status
        : error instanceof ReceiptUnknownError
          ? "blocked_unknown"
          : error instanceof ReceiptBusyError
            ? "waiting_receipt"
            : error instanceof ProviderRejectedError
              ? "provider_unavailable"
              : error instanceof ModelOutputError
                ? "invalid_output"
                : error instanceof PolicyRunStaleError || error instanceof PolicyInputChangedError || error instanceof SourcePolicyConflict
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
      error instanceof StageBlocked ? error.status : error instanceof PolicyRunStaleError || error instanceof SourcePolicyConflict ? "stale" : null;
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
