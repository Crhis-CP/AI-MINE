import { saveSourcePolicy } from "@amp/backend/admin/sources";
import { sourcePolicyExample } from "./permission-fixture.ts";

/** Explicit synthetic permission for isolated source tests; never a production or collector default. */
export async function grantDateFixture(sourceId: string, urls: string[]) {
  const scope = { hosts: [...new Set(urls.map((url) => new URL(url).hostname))], path_prefixes: ["/"], document_types: [], excluded_content: [] };
  const policy = structuredClone(sourcePolicyExample);
  policy.source_id = sourceId;
  policy.scope = scope;
  policy.evidence = policy.evidence.map((evidence) => ({ ...evidence, scope }));
  return saveSourcePolicy(sourceId, { policy, expectedVersion: null, reason: "Synthetic date acquisition fixture" }, "test");
}
