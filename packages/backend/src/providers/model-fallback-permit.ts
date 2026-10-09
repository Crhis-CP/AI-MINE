import { SourceInputManifestSchema, type ProcessingPermit, type IssueProcessingPermitInputSchema } from "@amp/contracts/source-policy";
import type { z } from "zod";
import { readCurrentSourcePolicy, evaluateSourcePolicy, readSourceDateContext } from "../admin/sources.ts";
import { createPermitIssuer } from "../sources/permissions.ts";
import { createPermitVerifier, type PermitPorts } from "./permissions.ts";
import { sha256, stableJson } from "../lib/ids.ts";
export type FallbackTarget = { modelKey: string; configurationHash: string };
export type FallbackPermitPort = {
  sourceIds: readonly string[];
  inputFingerprint: string;
  authorize(target: FallbackTarget): Promise<{ inputFingerprint: string; beforeRequest(): Promise<void>; close(): void }>;
};
export type FallbackMaterialSnapshot = { manifest: z.infer<typeof SourceInputManifestSchema>; inputFingerprint: string };
/** Trusted workers capture the actual prepared material and reconstruct its current identity. This does not accept an allow boolean. */
export function createFallbackPermitPort(ports: {
  root: AbortSignal;
  snapshot: FallbackMaterialSnapshot;
  current(): Promise<FallbackMaterialSnapshot>;
}): FallbackPermitPort {
  if (!/^[a-f0-9]{64}$/u.test(ports.snapshot.inputFingerprint)) throw new Error("备用处理缺少实际输入指纹");
  const initial = { manifest: SourceInputManifestSchema.parse(ports.snapshot.manifest), inputFingerprint: ports.snapshot.inputFingerprint };
  const identity = sha256(stableJson(initial));
  return Object.freeze({
    sourceIds: Object.freeze([...new Set(initial.manifest.materials.map((m) => m.source_id))].sort()),
    inputFingerprint: identity,
    async authorize(target: FallbackTarget) {
      if (!target.modelKey || !/^[a-f0-9]{64}$/u.test(target.configurationHash)) throw new Error("备用接入的实际配置未确认");
      const bound = sha256(stableJson([identity, target.modelKey, target.configurationHash]));
      const current = async () => {
        if (ports.root.aborted) throw new Error("材料处理已经停止");
        const next = await ports.current();
        if (sha256(stableJson(next)) !== identity) throw new Error("备用处理前材料版本已变化");
        return next;
      };
      const permitPorts: PermitPorts = {
        root: ports.root,
        now: Date.now,
        policy: {
          evaluate: async (request) => {
            if ((await readSourceDateContext(request.source_id))?.lane !== initial.manifest.lane) throw new Error("业务线已变化");
            return evaluateSourcePolicy(request);
          },
        },
        inputs: {
          resolve: async (binding) => {
            const value = await current();
            if (binding.kind !== "material" || binding.input_fingerprint !== bound) return null;
            const material = value.manifest.materials.find(
              (m) =>
                m.material_id === binding.material_id &&
                m.revision === binding.revision &&
                m.content_hash === binding.content_hash &&
                stableJson(m.resource) === stableJson(binding.resource),
            );
            return material ? { source_id: material.source_id, lane: value.manifest.lane, binding } : null;
          },
        },
      };
      const issuer = createPermitIssuer(permitPorts, 300000),
        verifier = createPermitVerifier(issuer.identity, permitPorts);
      const permits: { request: z.infer<typeof IssueProcessingPermitInputSchema>; permit: ProcessingPermit }[] = [];
      const close = () => {
        verifier.close();
        issuer.close();
      };
      try {
        await current();
        for (const m of initial.manifest.materials) {
          const policy = await readCurrentSourcePolicy(m.source_id);
          if (!policy) throw new Error("来源许可记录缺失");
          const request = {
            source_id: m.source_id,
            lane: initial.manifest.lane,
            capability: "external_model" as const,
            permission_version: policy.permission_version,
            binding: {
              kind: "material" as const,
              material_id: m.material_id,
              revision: m.revision,
              content_hash: m.content_hash,
              input_fingerprint: bound,
              resource: m.resource,
            },
          };
          const result = await issuer.issueProcessingPermit(request);
          if (!result.ok) throw new Error(`备用材料许可未通过：${result.reason}`);
          permits.push({ request, permit: result.permit });
        }
        const beforeRequest = async () => {
          await current();
          for (const item of permits) {
            const check = await verifier.verify(item.permit, item.request);
            if (!check.ok) throw new Error(`备用材料许可已变化：${check.reason}`);
          }
        };
        await beforeRequest();
        return { inputFingerprint: bound, beforeRequest, close };
      } catch (error) {
        close();
        throw error;
      }
    },
  });
}
