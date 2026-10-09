import { runtimeControlSnapshot, RuntimeControlPaused, RuntimeControlStale } from "../operations/lane-controls.ts";
import { z } from "zod";
import { sha256, stableJson } from "../lib/ids.ts";
import { promptText, promptVersion } from "../editorial/prompts.ts";
import { modelFor, PolicyVisionConfigurationError } from "../editorial/models.ts";
import { createPolicyGateway, policyUserHash, PolicyInputChangedError, type PreparedPolicyInput } from "../providers/policy.ts";
import { extractJson, ModelOutputError } from "../providers/llm.ts";
import {
  readPolicyResponse,
  readPolicyResponseForReceipt,
  readPolicyStageResponses,
  ReceiptBusyError,
  ReceiptUnknownError,
  ProviderRejectedError,
} from "../providers/receipts.ts";
import { readPolicyOriginal } from "./originals.ts";
import { processingControl, readProcessingControl, withCurrentPolicyOriginal, PolicyRunStaleError } from "./fulltext-store.ts";
import { SourcePolicyConflict } from "../sources/permission-store.ts";
import { validateProfile, type ExtractionProfile, type ResourceExtraction } from "./extraction.ts";
import { renderPolicyPdf, PDF_RENDER_RECIPE, VisionCapacityError, type PageImage, type RenderedPdf } from "./vision-render.ts";
import { checkVisionPage, checkVisionVerification, assembleVisionNodes, type VisionPageCandidate, type VisionVerification } from "./vision-schema.ts";
import { createVisionRun, storedVisionRun, visionCheckpoints, saveVisionStage, finishVision, visionRunReference, type VisionRun } from "./vision-store.ts";
import { policyModelEvidence, policyVisionContentHash, type ModelEvidence } from "./model-evidence.ts";

const EXTRACT = "policy-vision-extract",
  VERIFY = "policy-vision-check";
export const policyVisionRecipe = () => sha256(stableJson([PDF_RENDER_RECIPE, "vision-schema-v1", promptVersion(EXTRACT), promptVersion(VERIFY)]));
type Proof = NonNullable<Awaited<ReturnType<typeof readPolicyResponse>>>;
type Status =
  | "partial"
  | "needs_configuration"
  | "incomplete"
  | "blocked_capacity"
  | "blocked_unknown"
  | "waiting_receipt"
  | "provider_unavailable"
  | "invalid_output"
  | "stale"
  | "paused"
  | "waiting_control"
  | "not_required";
class Blocked extends Error {
  readonly status: Status;
  readonly gaps: string[];
  constructor(status: Status, gaps: string[] = []) {
    super(status);
    this.status = status;
    this.gaps = gaps;
  }
}
export type VisionProduct = {
  status: "extracted" | "incomplete";
  runId: string;
  revisionId: string;
  recipe: string;
  renderHash: string;
  catalogueClosed: boolean;
  resources: ResourceExtraction[];
  gaps: string[];
  modelEvidence: ModelEvidence[];
  contentHash: string;
  semantic_verified: false;
  publication_authorized: false;
};
export type VisionResult = (VisionProduct | { status: Status; runId?: string; gaps: string[]; semantic_verified: false; publication_authorized: false }) & {
  requestsAttempted: number;
};
type Stage = { id: string; inputHash: string; prompt: string; pages: PageImage[]; payload: Record<string, unknown>; check: (raw: unknown) => unknown };
const pageMeta = ({ png: _, ...page }: PageImage) => page;
function stage(prompt: string, pages: PageImage[], payload: Record<string, unknown>, check: Stage["check"]): Stage {
  const inputHash = sha256(stableJson([promptVersion(prompt), payload, pages.map(pageMeta)]));
  return { id: sha256(stableJson(["vision", prompt, inputHash])), inputHash, prompt, pages, payload, check };
}
function prepared(run: VisionRun, s: Stage): PreparedPolicyInput {
  const urls = [...new Set(s.pages.map((p) => p.resourceUrl))],
    materials = urls.map((url) => {
      const resource = run.snapshot.resources.find((r) => r.url === url)!;
      return {
        source_id: run.snapshot.sourceId,
        material_id: sha256(stableJson([run.expressionId, url])),
        revision: run.snapshot.sequence,
        content_hash: resource.sha256!,
        resource: { url, document_type: run.snapshot.manifest.identity.documentType, attachment: resource.attachment },
      };
    });
  const input: PreparedPolicyInput = {
    usageObject: { kind: "policy", id: run.snapshot.versionId },
    system: promptText(s.prompt),
    user: stableJson(s.payload),
    promptVersion: promptVersion(s.prompt),
    recipeVersion: run.recipe,
    controlRevision: String(run.controlVersion),
    processingAllowed: true,
    manifest: {
      schema_version: 1,
      kind: "source_materials",
      lane: "policy",
      materials,
      upstream_artifacts: [
        { kind: "policy_stage_input", id: s.id, version: run.recipe, content_hash: s.inputHash, manifest_id: run.renderHash },
        ...s.pages.map((p) => ({ kind: "policy_page_image", id: p.locationId, version: p.recipe, content_hash: p.imageHash, manifest_id: run.renderHash })),
      ],
    },
    images: s.pages.map((p) => ({
      materialId: materials.find((m) => m.resource.url === p.resourceUrl)!.material_id,
      locationId: p.locationId,
      sha256: p.imageHash,
      recipe: p.recipe,
      width: p.width,
      height: p.height,
      byteLength: p.byteLength,
      dataUrl: `data:image/png;base64,${Buffer.from(p.png).toString("base64")}`,
    })),
  };
  if (Buffer.byteLength(input.system + input.user) > 32_000) throw new VisionCapacityError("Complete visual input exceeds text capacity");
  return input;
}
function matches(proof: Proof, input: PreparedPolicyInput) {
  return (
    proof.purpose === "policy_vision" &&
    proof.request.systemHash === sha256(input.system) &&
    proof.request.userHash === policyUserHash(input) &&
    proof.request.promptVersion === input.promptVersion &&
    stableJson(proof.request.manifest) === stableJson(input.manifest)
  );
}
function decoded(proof: Proof) {
  const response = proof.response as { choices?: { message?: { content?: string }; finish_reason?: string }[] },
    choice = response?.choices?.[0];
  if (!choice?.message?.content || choice.finish_reason !== "stop") throw new Error("visual_output_incomplete");
  return extractJson(choice.message.content);
}
/** A bounded worker invocation. No model is selected implicitly, and no scheduler/retry loop is created. */
export async function runPolicyVision(
  expressionId: string,
  profileValue: ExtractionProfile,
  options: { root: AbortSignal; maxRequests?: number; readOnly?: boolean; runId?: string },
): Promise<VisionResult> {
  const profile = { ...profileValue },
    max = options.maxRequests ?? 2,
    recipe = policyVisionRecipe();
  validateProfile(profile);
  if (!Number.isSafeInteger(max) || max < 0) throw new Error("Invalid vision request bound");
  let requestsAttempted = 0,
    run: VisionRun | null = null;
  const blocked = (status: Status, gaps: string[] = []): VisionResult => ({
    status,
    gaps,
    ...(run ? { runId: run.id } : {}),
    requestsAttempted,
    semantic_verified: false,
    publication_authorized: false,
  });
  try {
    if (options.root.aborted) return blocked("stale");
    const snapshot = await readPolicyOriginal(expressionId);
    if (!snapshot) return blocked("stale");
    const pdfResources = snapshot.resources.filter((r) => r.body && Buffer.from(r.body.subarray(0, 5)).toString() === "%PDF-");
    if (!pdfResources.length) return blocked("not_required");
    if (pdfResources.length > profile.maxResources) throw new VisionCapacityError("PDF resource count exceeds capacity");
    const control = options.readOnly ? await readProcessingControl(expressionId) : await processingControl(expressionId);
    if (!control) return blocked("partial");
    if (control.paused) return blocked("paused");
    const runtimeControl = options.readOnly ? undefined : await runtimeControlSnapshot("policy", ["processing"]);
    if (runtimeControl?.paused) return blocked("paused");
    const ref = { snapshot, expressionId, controlVersion: control.version, runtimeControl },
      id = sha256(stableJson([expressionId, snapshot.revisionId, snapshot.permissionVersion, control.version, recipe, profile]));
    if (options.runId && options.runId !== id) return blocked("stale");
    run = await storedVisionRun(ref, id, recipe, profile);
    if (!run) {
      if (options.readOnly) return blocked("partial");
      await modelFor("policy_vision");
      await withCurrentPolicyOriginal(ref, async () => {});
      const pdfs: RenderedPdf[] = [];
      for (const resource of pdfResources) {
        try {
          pdfs.push(await renderPolicyPdf({ url: resource.url, sha256: resource.sha256!, body: resource.body! }, profile));
        } catch (error) {
          if (error instanceof VisionCapacityError) throw error;
          throw new Blocked("incomplete", [`pdf_render_failed:${resource.url}`]);
        }
      }
      run = await createVisionRun({ ...ref, id, recipe, profile, pdfs });
    }
    const current = run,
      checkpoints = new Map((await visionCheckpoints(current)).map((p) => [p.stage_id, p])),
      models = new Map<string, ModelEvidence>(),
      inflight = new Map<string, Stage>();
    const gateway = createPolicyGateway({
      runtimeControl: run!.runtimeControl,
      root: options.root,
      resolve: async (ref, purpose) => {
        const s = inflight.get(ref.id);
        if (purpose !== "policy_vision" || ref.version !== current.id || !s) return null;
        await withCurrentPolicyOriginal(current, async () => {});
        return prepared(current, s);
      },
    });
    const call = async <T>(s: Stage): Promise<T> => {
      if (options.root.aborted) throw new Blocked("stale");
      const input = prepared(current, s),
        point = checkpoints.get(s.id);
      let proof: Proof | null = null;
      if (point) {
        proof = await readPolicyResponse({ receiptId: point.receipt_id, attemptId: point.attempt_id });
        if (!proof?.knownUsage) throw new Blocked("blocked_unknown");
        if (point.input_hash !== s.inputHash || !matches(proof, input)) throw new Blocked("stale", ["visual_checkpoint_receipt_mismatch"]);
        if (point.status === "rejected") throw new Blocked("invalid_output", ["visual_candidate_rejected"]);
      } else {
        proof = (await readPolicyStageResponses(s.id)).find((p) => matches(p, input)) ?? null;
        if (!proof) {
          if (options.readOnly || requestsAttempted >= max) throw new Blocked("partial");
          await modelFor("policy_vision");
          inflight.set(s.id, s);
          requestsAttempted++;
          try {
            const response = await gateway.chat({ input: { id: s.id, version: current.id }, purpose: "policy_vision", schema: z.unknown(), maxTokens: 16_384 });
            if (response.attemptId) proof = await readPolicyResponse({ receiptId: response.receiptId, attemptId: response.attemptId });
          } catch (error) {
            if (!(error instanceof ModelOutputError) || error.receiptId === null) throw error;
            proof = await readPolicyResponseForReceipt(error.receiptId);
          }
        }
        if (!proof || !matches(proof, input)) throw new Blocked("stale", ["visual_receipt_input_mismatch"]);
        if (!proof.knownUsage) throw new Blocked("blocked_unknown");
      }
      let result: unknown = null,
        accepted = false;
      try {
        result = s.check(decoded(proof));
        accepted = true;
      } catch {
        accepted = false;
      }
      if (point && stableJson(result) !== stableJson(point.result)) throw new Blocked("stale", ["visual_checkpoint_output_mismatch"]);
      if (
        !options.readOnly &&
        !point &&
        !(await saveVisionStage(
          current,
          { stage_id: s.id, input_hash: s.inputHash, result, receipt_id: proof.receiptId, attempt_id: proof.attemptId },
          accepted,
        ))
      )
        throw new Blocked("blocked_unknown");
      if (!accepted) throw new Blocked("invalid_output", ["visual_candidate_rejected"]);
      models.set(`${proof.receiptId}:${proof.attemptId}`, policyModelEvidence(proof));
      return result as T;
    };
    const resources: ResourceExtraction[] = [],
      gaps: string[] = [];
    for (const pdf of current.pdfs) {
      const candidates = new Map<string, VisionPageCandidate>(),
        checks = new Map<string, VisionVerification>();
      for (const page of pdf.pages) {
        const neighbors = pdf.pages.filter((p) => Math.abs(p.page - page.page) <= 1),
          payload = { phase: "extract", target_location_id: page.locationId, pages: neighbors.map(pageMeta) };
        candidates.set(page.locationId, await call<VisionPageCandidate>(stage(EXTRACT, neighbors, payload, (raw) => checkVisionPage(page, raw))));
      }
      for (const page of pdf.pages) {
        const neighbors = pdf.pages.filter((p) => Math.abs(p.page - page.page) <= 1),
          candidate = candidates.get(page.locationId)!,
          payload = {
            phase: "verify",
            target_location_id: page.locationId,
            candidate_hash: sha256(stableJson(candidate)),
            pages: neighbors.map(pageMeta),
            candidates: neighbors.map((p) => candidates.get(p.locationId)!),
          };
        checks.set(
          page.locationId,
          await call<VisionVerification>(stage(VERIFY, neighbors, payload, (raw) => checkVisionVerification(page, candidate, neighbors, raw))),
        );
      }
      const assembled = assembleVisionNodes(
          pdf.pages.map((image) => ({ image, candidate: candidates.get(image.locationId)!, verification: checks.get(image.locationId)! })),
        ),
        missing = [...pdf.gaps, ...assembled.gaps];
      for (const candidate of candidates.values())
        for (const attachment of candidate.attachments) {
          if (attachment.kind === "unresolved" || (attachment.kind === "external" && !snapshot.resources.some((r) => r.url === attachment.url && r.body)))
            missing.push(`attachment_missing:${attachment.label}`);
        }
      if (!assembled.nodes.length) missing.push("document_has_no_textual_nodes");
      resources.push({
        url: pdf.url,
        sha256: pdf.hash,
        state: missing.length ? "incomplete" : "extracted",
        nodes: assembled.nodes,
        gaps: [...new Set(missing)],
      });
      gaps.push(...missing.map((g) => `${pdf.url}:${g}`));
    }
    if (resources.reduce((n, r) => n + Buffer.byteLength(stableJson(r.nodes)), 0) > profile.maxTextBytes)
      throw new VisionCapacityError("Visual structure exceeds complete-text capacity");
    const main = snapshot.resources[0],
      catalogueClosed = snapshot.manifest.catalogueClosed || Boolean(main && current.pdfs.some((p) => p.url === main.url) && !gaps.length),
      output = {
        status: gaps.length ? ("incomplete" as const) : ("extracted" as const),
        runId: current.id,
        revisionId: snapshot.revisionId,
        recipe,
        renderHash: current.renderHash,
        catalogueClosed,
        resources,
        gaps: [...new Set(gaps)],
        modelEvidence: [...models.values()].sort((a, b) => a.receiptId - b.receiptId || a.attemptId.localeCompare(b.attemptId)),
        semantic_verified: false as const,
        publication_authorized: false as const,
      };
    await withCurrentPolicyOriginal(current, async () => {});
    const contentHash = options.readOnly ? policyVisionContentHash(output) : await finishVision(current, output);
    return { ...output, contentHash, requestsAttempted };
  } catch (error) {
    if (error instanceof RuntimeControlPaused) return blocked("paused");
    if (error instanceof RuntimeControlStale) return blocked("waiting_control");
    if (error instanceof Blocked) return blocked(error.status, error.gaps);
    if (error instanceof PolicyVisionConfigurationError)
      return blocked("needs_configuration", ["POLICY_VISION_MODEL_or_models.policy_vision_requires_explicit_vision_capability"]);
    if (error instanceof VisionCapacityError) return blocked("blocked_capacity", [error.message]);
    if (error instanceof ReceiptUnknownError) return blocked("blocked_unknown");
    if (error instanceof ReceiptBusyError) return blocked("waiting_receipt");
    if (error instanceof ProviderRejectedError) return blocked("provider_unavailable");
    if (error instanceof PolicyRunStaleError || error instanceof PolicyInputChangedError || error instanceof SourcePolicyConflict) return blocked("stale");
    throw error;
  }
}

/** Read-only replay of actual current receipts; no model call or new candidate write. */
export async function loadPolicyVision(expressionId: string, profile: ExtractionProfile, runId?: string) {
  const result = await runPolicyVision(expressionId, profile, { root: new AbortController().signal, maxRequests: 0, readOnly: true, runId });
  return result.status === "extracted" && "contentHash" in result ? result : null;
}
export async function loadPolicyVisionProof(runId: string) {
  const ref = await visionRunReference(runId);
  return ref ? loadPolicyVision(ref.expression_id, ref.profile, runId) : null;
}
