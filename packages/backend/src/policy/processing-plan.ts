import { sha256, stableJson } from "../lib/ids.ts";
import type { PolicyExtraction } from "./extraction.ts";

export const POLICY_PLAN_LIMITS = Object.freeze({ documentBytes: 2_000_000, nodes: 8192, requestBytes: 2000, requestParts: 12, planBytes: 8 * 1024 * 1024 });
export type PolicyPlanContext = { sourceId: string; expressionId: string; language: string; identityHash: string; recipeVersion: string };
export type PolicyPart = {
  partId: string;
  resourceUrl: string;
  resourceHash: string;
  nodeId: string;
  nodePath: string;
  source: string;
  format: "text" | "html";
  sourceHash: string;
  byteLength: number;
  page?: number;
  transform?: number[];
};
export type PolicyFulltextRequest = { id: string; partIds: string[]; sourceBytes: number };
export type PolicyFulltextPlan = {
  status: "planned";
  revisionId: string;
  context: PolicyPlanContext;
  manifestHash: string;
  parts: PolicyPart[];
  requests: PolicyFulltextRequest[];
  sourceBytes: number;
  semantic_verified: false;
  runtime_authorization: "none";
};
type BlockedPlan = { status: "incomplete" | "blocked_capacity"; revisionId: string; gaps: string[]; requests: [] };
const hash = /^[a-f0-9]{64}$/;

/** Pure reconstruction, not a permission grant: the gateway rechecks the current original and processing controls. */
export function buildPolicyFulltextPlan(extraction: PolicyExtraction, context: PolicyPlanContext): PolicyFulltextPlan | BlockedPlan {
  const gaps = [...extraction.gaps];
  let capacity = extraction.state === "blocked_capacity";
  const block = (): BlockedPlan => ({
    status: capacity ? "blocked_capacity" : "incomplete",
    revisionId: extraction.revisionId,
    gaps: [...new Set(gaps)],
    requests: [],
  });
  if (!extraction.revisionId || Object.values(context).some((value) => !value.trim()) || !hash.test(context.identityHash))
    gaps.push("missing_processing_identity");
  if (extraction.state !== "extracted") gaps.push("original_extraction_incomplete");
  if (!extraction.resources.length) gaps.push("original_resources_missing");
  const parts: PolicyPart[] = [];
  const resources = new Set<string>();
  let sourceBytes = 0;
  for (const resource of extraction.resources) {
    if (resources.has(resource.url)) gaps.push(`duplicate_resource:${resource.url}`);
    resources.add(resource.url);
    gaps.push(...resource.gaps.map((gap) => `${resource.url}:${gap}`));
    if (resource.state !== "extracted" || !resource.nodes.length || !resource.sha256 || !hash.test(resource.sha256))
      gaps.push(`resource_incomplete:${resource.url}`);
    if (resource.state === "blocked_capacity") capacity = true;
    const ids = new Set<string>();
    let lastOrdinal = -1;
    for (const node of resource.nodes) {
      if (!node.id || ids.has(node.id) || !Number.isSafeInteger(node.ordinal) || node.ordinal <= lastOrdinal) gaps.push(`invalid_node_order:${resource.url}`);
      ids.add(node.id);
      lastOrdinal = node.ordinal;
      const source = node.html ?? node.text;
      if (!source.trim()) gaps.push(`empty_node:${resource.url}#${node.id}`);
      const byteLength = Buffer.byteLength(source, "utf8");
      sourceBytes += byteLength;
      // Extraction supplies structural blocks. An unproved internal split could sever a clause or table row.
      if (byteLength > POLICY_PLAN_LIMITS.requestBytes) {
        capacity = true;
        gaps.push(`atomic_node_exceeds_request_limit:${resource.url}#${node.id}`);
      }
      const nodePath = node.selector
        ? `${node.selector}/child:${node.ordinal}`
        : node.page === undefined
          ? `node:${node.ordinal}`
          : `page:${node.page}/item:${node.ordinal}`;
      const sourceHash = sha256(source);
      parts.push({
        partId: sha256(stableJson([context.sourceId, context.expressionId, resource.url, nodePath, sourceHash])),
        resourceUrl: resource.url,
        resourceHash: resource.sha256 ?? "",
        nodeId: node.id,
        nodePath,
        source,
        format: node.html === undefined ? "text" : "html",
        sourceHash,
        byteLength,
        ...(node.page === undefined ? {} : { page: node.page }),
        ...(node.transform === undefined ? {} : { transform: [...node.transform] }),
      });
    }
  }
  if (new Set(parts.map((part) => part.partId)).size !== parts.length) gaps.push("duplicate_part_identity");
  if (parts.length > POLICY_PLAN_LIMITS.nodes || sourceBytes > POLICY_PLAN_LIMITS.documentBytes) {
    capacity = true;
    gaps.push("document_capacity_exceeded");
  }
  if (gaps.length || capacity) return block();
  const requests: PolicyFulltextRequest[] = [];
  let group: PolicyPart[] = [];
  let bytes = 0;
  const flush = () => {
    if (!group.length) return;
    const partIds = group.map((part) => part.partId);
    requests.push({ id: sha256(stableJson([context, partIds])), partIds, sourceBytes: bytes });
    group = [];
    bytes = 0;
  };
  for (const part of parts) {
    if (group.length === POLICY_PLAN_LIMITS.requestParts || bytes + part.byteLength > POLICY_PLAN_LIMITS.requestBytes) flush();
    group.push(part);
    bytes += part.byteLength;
  }
  flush();
  const plan: PolicyFulltextPlan = {
    status: "planned",
    revisionId: extraction.revisionId,
    context: { ...context },
    manifestHash: sha256(stableJson([extraction.revisionId, context, parts])),
    parts,
    requests,
    sourceBytes,
    semantic_verified: false,
    runtime_authorization: "none",
  };
  if (Buffer.byteLength(stableJson(plan), "utf8") > POLICY_PLAN_LIMITS.planBytes) {
    capacity = true;
    gaps.push("serialized_plan_capacity_exceeded");
    return block();
  }
  return plan;
}
