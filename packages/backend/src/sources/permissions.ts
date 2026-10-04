import { createPublicKey, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { IssueProcessingPermitInputSchema, type ProcessingPermit, type PermitIssuanceResult } from "@amp/contracts/source-policy";
import { checkPermitCurrent, permitMessage, rejectPermit, type PermitIssuerIdentity, type PermitPorts } from "../providers/permissions.ts";

/** Explicit, unactivated sources factory. Only its public identity leaves this closure. */
export function createPermitIssuer(ports: PermitPorts, ttlMs: number) {
  if (
    ports.root.aborted ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs <= 0 ||
    typeof ports.now !== "function" ||
    typeof ports.policy?.evaluate !== "function" ||
    typeof ports.inputs?.resolve !== "function"
  )
    throw new Error("Permit issuer requires a live root, bounded lifetime and explicit current-state ports");
  let privateKey: KeyObject | undefined = generateKeyPairSync("ed25519").privateKey;
  const publicKey = createPublicKey(privateKey);
  const local = new AbortController(),
    lifetime = AbortSignal.any([ports.root, local.signal]);
  lifetime.addEventListener(
    "abort",
    () => {
      privateKey = undefined;
    },
    { once: true },
  );
  const identity: PermitIssuerIdentity = Object.freeze({ id: randomUUID(), key: publicKey, root: ports.root, lifetime });
  return Object.freeze({
    identity,
    close: () => local.abort(),
    async issueProcessingPermit(value: unknown): Promise<PermitIssuanceResult> {
      if (lifetime.aborted || !privateKey) return rejectPermit("lifecycle_revoked");
      const parsed = IssueProcessingPermitInputSchema.safeParse(value);
      if (!parsed.success) return rejectPermit("malformed_permit");
      const request = parsed.data,
        checked = await checkPermitCurrent(ports, request, lifetime);
      if (!checked.ok) return checked;
      if (lifetime.aborted || !privateKey) return rejectPermit("lifecycle_revoked");
      try {
        const now = ports.now(),
          expiry = checked.policy.expires_at;
        const end = Math.min(now + ttlMs, expiry === null ? Infinity : Date.parse(expiry));
        if (!Number.isFinite(now)) return rejectPermit("verification_unavailable");
        if (end <= now) return rejectPermit("permission_expired");
        const wire = {
          schema_version: 1 as const,
          algorithm: "Ed25519" as const,
          issuer_id: identity.id,
          credential_expires_at: new Date(end).toISOString(),
          payload: {
            __brand: "ProcessingPermit" as const,
            source_id: request.source_id,
            lane: request.lane,
            capability: request.capability,
            permission_version: request.permission_version,
            expires_at: expiry,
            issued_at: new Date(now).toISOString(),
          },
          binding: request.binding,
          signature: "",
        };
        if (lifetime.aborted || !privateKey) return rejectPermit("lifecycle_revoked");
        wire.signature = sign(null, Buffer.from(permitMessage(wire)), privateKey).toString("base64url");
        if (lifetime.aborted) return rejectPermit("lifecycle_revoked");
        return { ok: true, permit: wire as ProcessingPermit };
      } catch {
        return rejectPermit(lifetime.aborted ? "lifecycle_revoked" : "verification_unavailable");
      }
    },
  });
}
