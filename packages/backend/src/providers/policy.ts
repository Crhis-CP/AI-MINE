// Policy workers provide immutable references. Only their trusted resolver prepares the actual model input.
import { z } from "zod";
import { SourceInputManifestSchema, type IssueProcessingPermitInputSchema, type ProcessingPermit } from "@amp/contracts/source-policy";
import { readCurrentSourcePolicy, readSourceDateContext, evaluateSourcePolicy } from "@amp/backend/admin/sources";
import { createPermitIssuer } from "../sources/permissions.ts";
import { createPermitVerifier, type PermitPorts } from "./permissions.ts";
import { chatJson, type ChatJsonResult } from "./llm.ts";
import { modelFor } from "../editorial/models.ts";
import { sha256, stableJson } from "../lib/ids.ts";

const Purpose = z.enum(["policy_fulltext", "policy_group", "policy_interpret", "policy_verify"]);
export type PolicyPurpose = z.infer<typeof Purpose>;
const Reference = z.strictObject({ id: z.string().min(1), version: z.string().min(1) });
export type PolicyInputReference = z.infer<typeof Reference>;
const Prepared = z.strictObject({
  manifest: SourceInputManifestSchema.refine((m) => m.lane === "policy", "Policy input must belong to policy"),
  system: z.string(),
  user: z.string().min(1),
  promptVersion: z.string().min(1),
  recipeVersion: z.string().min(1),
  controlRevision: z.string().min(1),
  processingAllowed: z.boolean(),
});
export type PreparedPolicyInput = z.infer<typeof Prepared>;
export interface PolicyGatewayPorts {
  root: AbortSignal;
  /** Rebuild from current stored originals/plan/control state; never echo caller-provided text or completeness flags. */
  resolve(ref: PolicyInputReference, purpose: PolicyPurpose): Promise<PreparedPolicyInput | null>;
}
export class PolicyInputChangedError extends Error {
  readonly receiptId: number;
  readonly attemptId: string | null;
  constructor(receiptId: number, attemptId: string | null) {
    super("Policy input, permission or processing state changed; paid receipt retained, candidate cannot advance");
    this.receiptId = receiptId;
    this.attemptId = attemptId;
  }
}

export function createPolicyGateway(ports: PolicyGatewayPorts) {
  if (ports.root.aborted || typeof ports.resolve !== "function") throw new Error("Policy gateway needs live trusted input ports");
  return Object.freeze({
    async chat<S extends z.ZodType>(options: {
      input: PolicyInputReference;
      purpose: PolicyPurpose;
      schema: S;
      maxTokens?: number;
      timeoutMs?: number;
    }): Promise<ChatJsonResult<z.infer<S>> & { manifestHash: string; inputFingerprint: string }> {
      const ref = Reference.parse(options.input),
        purpose = Purpose.parse(options.purpose);
      const load = async () => {
        if (ports.root.aborted) throw new Error("Policy gateway root revoked");
        const input = Prepared.parse(await ports.resolve(structuredClone(ref), purpose));
        if (!input.processingAllowed) throw new Error("Policy processing is paused");
        if (Buffer.byteLength(input.system + input.user, "utf8") > 32_000) throw new Error("Policy input exceeds capacity; do not truncate");
        return input;
      };
      const input = await load(),
        manifestHash = sha256(stableJson(input.manifest));
      const fingerprint = (value: PreparedPolicyInput) => sha256(stableJson({ ref, purpose, ...value }));
      const inputFingerprint = fingerprint(input);
      const current = async () => {
        const value = await load();
        if (fingerprint(value) !== inputFingerprint) throw new Error("Policy input changed");
        return value;
      };
      const permitPorts: PermitPorts = {
        root: ports.root,
        now: Date.now,
        policy: {
          evaluate: async (request) => {
            if ((await readSourceDateContext(request.source_id))?.lane !== "policy") throw new Error("Not a policy source");
            return evaluateSourcePolicy(request);
          },
        },
        inputs: {
          resolve: async (binding) => {
            const value = await current();
            if (binding.kind !== "material") return null;
            const material = value.manifest.materials.find(
              (m) =>
                m.material_id === binding.material_id &&
                m.revision === binding.revision &&
                m.content_hash === binding.content_hash &&
                stableJson(m.resource) === stableJson(binding.resource),
            );
            return material ? { source_id: material.source_id, lane: "policy", binding: { ...binding, input_fingerprint: inputFingerprint } } : null;
          },
        },
      };
      const issuer = createPermitIssuer(permitPorts, 300_000),
        verifier = createPermitVerifier(issuer.identity, permitPorts);
      try {
        const permits: { request: z.infer<typeof IssueProcessingPermitInputSchema>; permit: ProcessingPermit }[] = [];
        for (const material of input.manifest.materials) {
          const policy = await readCurrentSourcePolicy(material.source_id);
          if (!policy) throw new Error("Policy source permission missing");
          const request = {
            source_id: material.source_id,
            lane: "policy" as const,
            capability: "external_model" as const,
            permission_version: policy.permission_version,
            binding: {
              kind: "material" as const,
              material_id: material.material_id,
              revision: material.revision,
              content_hash: material.content_hash,
              input_fingerprint: inputFingerprint,
              resource: material.resource,
            },
          };
          const issued = await issuer.issueProcessingPermit(request);
          if (!issued.ok) throw new Error(`Policy processing permit denied: ${issued.reason}`);
          permits.push({ request, permit: issued.permit });
        }
        const authorize = async () => {
          await current();
          for (const { request, permit } of permits) {
            const result = await verifier.verify(permit, request);
            if (!result.ok) throw new Error(`Policy processing permit denied: ${result.reason}`);
          }
        };
        await authorize();
        const result = await chatJson({
          model: await modelFor(purpose),
          purpose,
          subject: `policy:${ref.id}@${ref.version}`,
          promptVersion: input.promptVersion,
          system: input.system,
          user: input.user,
          schema: options.schema,
          maxTokens: options.maxTokens ?? 4096,
          timeoutMs: options.timeoutMs,
          beforeRequest: authorize,
          policyContext: {
            lane: "policy",
            category: purpose === "policy_fulltext" ? "policy_fulltext" : "policy_interpret",
            partIds: input.manifest.upstream_artifacts.filter((a) => a.kind === "policy_part").map((a) => a.id),
            sourceIds: [...new Set(input.manifest.materials.map((m) => m.source_id))].sort(),
            manifestHash,
            inputFingerprint,
            permissionVersions: Object.fromEntries(permits.map((p) => [p.request.source_id, p.request.permission_version])),
            manifest: input.manifest,
          },
        });
        try {
          await authorize();
        } catch {
          throw new PolicyInputChangedError(result.receiptId, result.attemptId);
        }
        return { ...result, manifestHash, inputFingerprint };
      } finally {
        verifier.close();
        issuer.close();
      }
    },
  });
}
