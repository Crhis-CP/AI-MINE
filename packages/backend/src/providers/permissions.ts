import { verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import {
  IssueProcessingPermitInputSchema,
  PermitInputBindingSchema,
  PermissionLaneSchema,
  type PermissionFailureCodeSchema,
  ProcessingPermitPayloadSchema,
  SignedProcessingPermitSchema,
  SourcePolicyEvaluationSchema,
  type SignedProcessingPermit,
  type SourcePolicyQueryPort,
} from "@amp/contracts/source-policy";
import { stableJson } from "../lib/ids.ts";

type Request = z.infer<typeof IssueProcessingPermitInputSchema>;
type Failure = z.infer<typeof PermissionFailureCodeSchema>;
const CurrentInput = z.strictObject({
  source_id: ProcessingPermitPayloadSchema.shape.source_id,
  lane: PermissionLaneSchema,
  binding: PermitInputBindingSchema,
});
export interface PermitPorts {
  root: AbortSignal;
  now: () => number;
  policy: SourcePolicyQueryPort;
  /** Rebuild identity and actual prepared-input binding from trusted objects, never echo claims. */
  inputs: { resolve(binding: Request["binding"]): Promise<z.infer<typeof CurrentInput> | null> };
}
export type PermitIssuerIdentity = Readonly<{ id: string; key: KeyObject; root: AbortSignal; lifetime: AbortSignal }>;
export const rejectPermit = (reason: Failure) => ({ ok: false as const, reason });
export const permitMessage = ({ signature: _signature, ...body }: SignedProcessingPermit) => stableJson(body);

export function inputMismatch(expected: Pick<Request, "source_id" | "lane" | "binding">, actual: z.infer<typeof CurrentInput>): Failure | null {
  if (expected.source_id !== actual.source_id) return "source_mismatch";
  if (expected.lane !== actual.lane) return "lane_mismatch";
  const a = expected.binding,
    b = actual.binding;
  if (a.kind !== b.kind) return "material_mismatch";
  if (a.kind === "material" && b.kind === "material" && (a.material_id !== b.material_id || a.revision !== b.revision || a.content_hash !== b.content_hash))
    return "material_mismatch";
  if (a.input_fingerprint !== b.input_fingerprint || (a.kind === "acquisition" && b.kind === "acquisition" && a.config_fingerprint !== b.config_fingerprint))
    return "input_mismatch";
  return stableJson(a.resource) !== stableJson(b.resource) ? "resource_mismatch" : null;
}

/** Both issuing and verifying require explicit live ports; failures never fall back to cached allow. */
export async function checkPermitCurrent(ports: PermitPorts, request: Request, lifetime: AbortSignal) {
  if (lifetime.aborted) return rejectPermit("lifecycle_revoked");
  try {
    const resolved = await ports.inputs.resolve(structuredClone(request.binding));
    if (resolved === null) return rejectPermit("material_mismatch");
    const current = CurrentInput.parse(resolved);
    if (lifetime.aborted) return rejectPermit("lifecycle_revoked");
    const mismatch = inputMismatch(request, current);
    if (mismatch) return rejectPermit(mismatch);
    const policy = SourcePolicyEvaluationSchema.parse(
      await ports.policy.evaluate({
        source_id: current.source_id,
        lane: current.lane,
        capability: request.capability,
        expected_permission_version: request.permission_version,
        resource: structuredClone(current.binding.resource),
      }),
    );
    if (lifetime.aborted) return rejectPermit("lifecycle_revoked");
    if (policy.source_id !== request.source_id) return rejectPermit("source_mismatch");
    if (policy.lane !== request.lane) return rejectPermit("lane_mismatch");
    if (policy.capability !== request.capability) return rejectPermit("purpose_mismatch");
    if (policy.decision !== "allow") return rejectPermit(policy.reason);
    if (policy.permission_version !== request.permission_version) return rejectPermit("version_changed");
    const now = ports.now();
    if (!Number.isFinite(now)) return rejectPermit("verification_unavailable");
    if (policy.expires_at !== null && Date.parse(policy.expires_at) <= now) return rejectPermit("permission_expired");
    const url = new URL(current.binding.resource.url),
      scope = policy.scope;
    if (
      !scope.hosts.includes(url.hostname) ||
      !scope.path_prefixes.some((prefix) => url.pathname.startsWith(prefix)) ||
      (scope.document_types.length && !scope.document_types.includes(current.binding.resource.document_type ?? ""))
    )
      return rejectPermit("resource_mismatch");
    return { ok: true as const, policy };
  } catch {
    return rejectPermit(lifetime.aborted ? "lifecycle_revoked" : "verification_unavailable");
  }
}

export function createPermitVerifier(identity: PermitIssuerIdentity, ports: PermitPorts) {
  if (
    typeof ports.now !== "function" ||
    typeof ports.policy?.evaluate !== "function" ||
    typeof ports.inputs?.resolve !== "function" ||
    identity.root !== ports.root ||
    ports.root.aborted ||
    identity.lifetime.aborted ||
    identity.key.type !== "public" ||
    identity.key.asymmetricKeyType !== "ed25519"
  )
    throw new Error("Permit verifier requires the current root and public issuer key");
  const local = new AbortController(),
    lifetime = AbortSignal.any([ports.root, identity.lifetime, local.signal]);
  const timeFailure = (permit: SignedProcessingPermit): Failure | null => {
    const now = ports.now(),
      issued = Date.parse(permit.payload.issued_at),
      until = Date.parse(permit.credential_expires_at);
    if (!Number.isFinite(now)) return "verification_unavailable";
    if (permit.payload.expires_at !== null && Date.parse(permit.payload.expires_at) <= now) return "permission_expired";
    return issued <= now && now < until && until > issued ? null : "credential_expired";
  };
  return Object.freeze({
    close: () => local.abort(),
    async verify(wire: unknown, expected: unknown) {
      if (lifetime.aborted) return rejectPermit("lifecycle_revoked");
      if (wire === null || wire === undefined) return rejectPermit("missing_permit");
      const parsed = SignedProcessingPermitSchema.safeParse(wire),
        input = IssueProcessingPermitInputSchema.safeParse(expected);
      if (!parsed.success || !input.success) return rejectPermit("malformed_permit");
      const permit = parsed.data,
        request = input.data;
      if (permit.issuer_id !== identity.id) return rejectPermit("untrusted_issuer");
      try {
        if (!verify(null, Buffer.from(permitMessage(permit)), identity.key, Buffer.from(permit.signature, "base64url")))
          return rejectPermit("invalid_signature");
        const mismatch = inputMismatch(request, { ...permit.payload, binding: permit.binding });
        if (mismatch) return rejectPermit(mismatch);
        if (permit.payload.capability !== request.capability) return rejectPermit("purpose_mismatch");
        if (permit.payload.permission_version !== request.permission_version) return rejectPermit("version_changed");
        const beforeTime = timeFailure(permit);
        if (beforeTime) return rejectPermit(beforeTime);
        const checked = await checkPermitCurrent(ports, request, lifetime);
        if (!checked.ok) return checked;
        const afterTime = timeFailure(permit);
        if (afterTime) return rejectPermit(afterTime);
        if (permit.payload.expires_at !== checked.policy.expires_at) return rejectPermit("version_changed");
        if (lifetime.aborted) return rejectPermit("lifecycle_revoked");
        return { ok: true as const, permit };
      } catch {
        return rejectPermit(lifetime.aborted ? "lifecycle_revoked" : "verification_unavailable");
      }
    },
  });
}
