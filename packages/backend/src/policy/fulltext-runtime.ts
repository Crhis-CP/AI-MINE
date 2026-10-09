import { z } from "zod";
import { promptText, promptVersion } from "@amp/backend/editorial/prompts";
import { createPolicyGateway, PolicyInputChangedError, type PreparedPolicyInput } from "@amp/backend/providers/policy";
import { extractJson, ModelOutputError } from "@amp/backend/providers/llm";
import { readPolicyPartResponses, ReceiptBusyError, ReceiptUnknownError, PolicyPartLimitError, ProviderRejectedError } from "@amp/backend/providers/receipts";
import { readPolicyOriginal } from "./originals.ts";
import { extractPolicyOriginal, type ExtractionProfile } from "./extraction.ts";
import { buildPolicyFulltextPlan, type PolicyPart } from "./processing-plan.ts";
import { validatePolicyFulltextCandidate, PolicyPartCandidateSchema } from "./fulltext-candidate.ts";
import {
  assertPolicyRunCurrent,
  beginPolicyFulltext,
  fulltextCheckpoints,
  finishPolicyFulltext,
  saveFulltextResponse,
  PolicyRunStaleError,
  type FulltextRun,
} from "./fulltext-store.ts";
import { sha256, stableJson } from "../lib/ids.ts";

const PROMPT = "policy-fulltext";
function responseParts(response: unknown): unknown[] {
  const parsed = z
    .object({ choices: z.array(z.object({ message: z.object({ content: z.string() }), finish_reason: z.string().nullable().optional() })) })
    .safeParse(response);
  const choice = parsed.success ? parsed.data.choices[0] : null;
  if (!choice || (choice.finish_reason && choice.finish_reason !== "stop")) return [];
  try {
    const value = extractJson(choice.message.content) as { parts?: unknown };
    return Array.isArray(value?.parts) ? value.parts : [];
  } catch {
    return [];
  }
}
const recipeFor = (plan: FulltextRun["plan"]) => sha256(stableJson([plan.context.language, plan.context.identityHash, plan.context.recipeVersion]));

/** An explicit worker invocation, not a scheduler: bounded new sends resume from real paid receipts and checkpoints. */
export async function runPolicyFulltext(expressionId: string, profileValue: ExtractionProfile, options: { root: AbortSignal; maxRequests?: number }) {
  const profile = { ...profileValue },
    max = options.maxRequests ?? 2;
  if (!Number.isSafeInteger(max) || max < 1) throw new Error("maxRequests must be a positive fairness limit");
  const snapshot = await readPolicyOriginal(expressionId);
  if (!snapshot) throw new Error("Policy original missing");
  const recipeVersion = `${promptVersion(PROMPT)}/candidate-v1`;
  const plan = buildPolicyFulltextPlan(await extractPolicyOriginal(expressionId, profile), {
    sourceId: snapshot.sourceId,
    expressionId,
    language: snapshot.language,
    identityHash: sha256(stableJson([snapshot.manifest.officialTitle, snapshot.manifest.identity])),
    recipeVersion,
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
      system: promptText(PROMPT),
      user: stableJson({
        officialTitle: original.manifest.officialTitle,
        identity: original.manifest.identity,
        language: plan.context.language,
        parts: parts.map((p) => ({ partId: p.partId, sourceHash: p.sourceHash, nodePath: p.nodePath, format: p.format, source: p.source })),
      }),
      promptVersion: promptVersion(PROMPT),
      recipeVersion,
      controlRevision: String(run.controlVersion),
      processingAllowed: true,
    };
  };
  const gateway = createPolicyGateway({
    root: options.root,
    resolve: async (ref, purpose) => {
      const parts = requestParts.get(ref.id);
      return purpose === "policy_fulltext" && ref.version === run.id && parts ? load(parts) : null;
    },
  });
  const recover = async () => {
    const responses = await readPolicyPartResponses(
      plan.parts.map((p) => p.partId),
      run.recipeHash,
    );
    for (const response of responses) {
      const raw = responseParts(response.response),
        parsed = raw
          .map((x) => PolicyPartCandidateSchema.safeParse(x))
          .filter((x) => x.success)
          .map((x) => x.data!);
      const candidates = parsed.filter((p) => plan.parts.some((expected) => expected.partId === p.partId && expected.sourceHash === p.sourceHash));
      const checked = validatePolicyFulltextCandidate(plan, candidates);
      const accepted = checked.accepted.map((p) => ({ partId: p.partId, sourceHash: p.sourceHash, candidate: candidates.find((c) => c.partId === p.partId)! }));
      const samePlan = response.request.manifest?.upstream_artifacts?.every((a) => a.manifest_id === plan.manifestHash);
      await saveFulltextResponse(run, response, accepted, samePlan ? raw.length > 0 && accepted.length === raw.length : null);
    }
    const checkpoints = await fulltextCheckpoints(run);
    // A stored candidate still needs both its immutable source binding and the actual paid response.
    const usable = checkpoints.filter((p) =>
      responses.some(
        (r) => r.receiptId === p.receiptId && r.attemptId === p.attemptId && responseParts(r.response).some((c) => stableJson(c) === stableJson(p.candidate)),
      ),
    );
    return validatePolicyFulltextCandidate(
      plan,
      usable.map((p) => p.candidate),
    );
  };
  try {
    let checked = await recover();
    for (const request of plan.requests) {
      while (request.partIds.some((id) => !checked.accepted.some((p) => p.partId === id)) && requests < max) {
        const parts = plan.parts.filter((p) => request.partIds.includes(p.partId) && !checked.accepted.some((done) => done.partId === p.partId));
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
    }
    await finishPolicyFulltext(run, checked, checked.status === "program_validated");
    return { ...checked, runId: run.id, requestsAttempted: requests, acceptedParts: checked.accepted.length, totalParts: plan.parts.length };
  } catch (error) {
    const status =
      error instanceof PolicyPartLimitError
        ? "blocked_retry_limit"
        : error instanceof ReceiptUnknownError
          ? "blocked_unknown"
          : error instanceof ReceiptBusyError
            ? "waiting_receipt"
            : error instanceof ProviderRejectedError
              ? "provider_unavailable"
              : error instanceof PolicyRunStaleError || error instanceof PolicyInputChangedError
                ? "stale"
                : null;
    if (!status) throw error;
    return { status, runId: run.id, requestsAttempted: requests, semantic_verified: false as const, runtime_authorization: "none" as const };
  }
}

export { setPolicyProcessingPaused, readPolicyFulltextRun, withCurrentPolicyRun, type FulltextRun } from "./fulltext-store.ts";
