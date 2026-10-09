import { z } from "zod";
import { sha256, stableJson } from "../lib/ids.ts";
import type { readPolicyResponse } from "../providers/receipts.ts";
export const POLICY_MODEL_BINDING_VERSION = "physical-model-1";
export const PolicyModelQualificationKey = z.string().regex(/^pmodel1:[a-f0-9]{64}$/u);
export type ModelEvidence = {
  receiptId: number;
  attemptId: string;
  service: string;
  requestedModel: string | null;
  reportedModel: string | null;
  configurationHash: string | null;
  connectionId: string | null;
  connectionRevision: number | null;
};
type Proof = NonNullable<Awaited<ReturnType<typeof readPolicyResponse>>>;
/** Only this exact physical response supplies its configuration; the logical receipt request is not evidence. */
export function policyModelEvidence(proof: Proof): ModelEvidence {
  const reported = (proof.response as { model?: unknown })?.model;
  return {
    receiptId: proof.receiptId,
    attemptId: proof.attemptId,
    service: proof.service,
    requestedModel: proof.model,
    reportedModel: typeof reported === "string" && reported.trim() ? reported : null,
    configurationHash: proof.configuration_hash,
    connectionId: proof.connection_id,
    connectionRevision: proof.connection_revision,
  };
}
export function policyModelQualificationKey(evidence: ModelEvidence): string | null {
  const { service, requestedModel, reportedModel, configurationHash, connectionId, connectionRevision } = evidence;
  if (!service?.trim() || !requestedModel?.trim() || !reportedModel?.trim() || !/^[a-f0-9]{64}$/u.test(configurationHash ?? "")) return null;
  if (service.startsWith("registered:")) {
    if (!connectionId || service !== `registered:${connectionId}` || !Number.isSafeInteger(connectionRevision) || connectionRevision! <= 0) return null;
  } else if (connectionId !== null || connectionRevision !== null) return null;
  return `pmodel1:${sha256(stableJson([service, requestedModel, reportedModel, configurationHash]))}`;
}
export function policyModelQualification(evidence: readonly ModelEvidence[]) {
  const keys = evidence.map(policyModelQualificationKey);
  return {
    models: [...new Set(keys.filter((value): value is string => value !== null))].sort(),
    modelEvidenceComplete: keys.length > 0 && keys.every((value) => value !== null),
  };
}
/** Keep the pre-existing vision→fulltext content identity. New qualification metadata is checked separately. */
export function policyVisionContentHash(output: Record<string, unknown> & { modelEvidence: readonly ModelEvidence[] }) {
  const modelEvidence = output.modelEvidence.map(({ receiptId, attemptId, service, requestedModel, reportedModel }) => ({
    receiptId,
    attemptId,
    service,
    requestedModel,
    reportedModel,
  }));
  return sha256(stableJson({ ...output, modelEvidence }));
}
