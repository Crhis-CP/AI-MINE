import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { z } from "zod";
import type { SourcePolicySchema } from "@amp/contracts/source-policy";
import { closeDb, sql } from "@amp/backend/db";
import {
  appendSourcePolicy,
  evaluatePublicSourcePolicy,
  evaluateSourcePolicy,
  publicProcessingAllowed,
  publicProcessingAllowedBy,
  readCurrentPublicPolicies,
} from "../packages/backend/src/sources/permission-store.ts";
import { sourcePolicyExample } from "./permission-fixture.ts";

after(closeDb);

type Policy = z.input<typeof SourcePolicySchema>;
const now = Date.parse("2026-11-06T00:00:00Z");
const scope = { hosts: ["gazette.invalid"], path_prefixes: ["/laws/"], document_types: [], excluded_content: [] };
const granted = (policy: Policy, change: Partial<Policy["evidence"][number]>) => {
  policy.evidence = policy.evidence.map((evidence) => ({ ...evidence, ...change }));
};
const variants: Record<string, (policy: Policy) => void> = {
  allowed: () => {},
  translation_denied: (p) => {
    p.permissions = { ...p.permissions, public_translation: "deny" };
  },
  processing_denied: (p) => {
    p.permissions = { ...p.permissions, process_locally: "deny" };
  },
  conditional: (p) => {
    p.conditions = ["third_party_excluded"];
  },
  excluded_content: (p) => {
    p.scope = { ...p.scope, excluded_content: ["maps"] };
  },
  no_attachments: (p) => {
    p.attachments_in_scope = false;
  },
  narrower_grant: (p) => granted(p, { scope: { ...scope, path_prefixes: ["/laws/2026/"] } }),
  expired_grant: (p) => granted(p, { kind: "written_authorization", valid_until: "2026-01-01T00:00:00Z" }),
  expired_licence: (p) => {
    granted(p, { kind: "written_authorization" });
    p.expires_at = "2026-01-01T00:00:00Z";
  },
  objection_only: (p) => {
    granted(p, { kind: "source_objection" });
    p.permissions = Object.fromEntries(Object.keys(p.permissions).map((purpose) => [purpose, "unknown"])) as Policy["permissions"];
  },
};
const resources = [
  { url: "https://gazette.invalid/laws/2026/1", document_type: null, attachment: false },
  { url: "https://gazette.invalid/laws/2025/9", document_type: "decree", attachment: false },
  { url: "https://gazette.invalid/laws/2026/1/annex.pdf", document_type: null, attachment: true },
  { url: "https://gazette.invalid/notices/1", document_type: null, attachment: false },
  { url: "https://other.invalid/laws/2026/1", document_type: null, attachment: false },
];
const capabilities = ["public_summary", "public_excerpt", "public_original_fulltext", "public_translation"] as const;

test("a public permission read once decides exactly as the per-check lookup does", async () => {
  const ids: string[] = [];
  for (const [name, change] of Object.entries(variants)) {
    const id = `projection-${name}`;
    await sql`INSERT INTO sources(id,name,kind,lane) VALUES(${id},${id},'external','policy')`;
    const policy = structuredClone(sourcePolicyExample) as Policy;
    policy.source_id = id;
    policy.scope = scope;
    granted(policy, { scope });
    change(policy);
    await sql.begin((tx) => appendSourcePolicy(tx, null, policy));
    ids.push(id);
  }
  ids.push("projection-missing");
  const projections = await readCurrentPublicPolicies(ids);
  let allowed = 0;
  for (const source of ids)
    for (const resource of resources) {
      const projection = projections.get(source) ?? null;
      assert.equal(publicProcessingAllowedBy(projection, resource, now), await publicProcessingAllowed(source, resource, now), `${source} ${resource.url}`);
      for (const capability of capabilities)
        for (const version of [1, 2]) {
          const input = { source_id: source, expected_permission_version: version, lane: "policy", capability, resource };
          const decided = evaluatePublicSourcePolicy(projection, input, now);
          assert.deepEqual(decided, await evaluateSourcePolicy(input, now), `${source} ${capability} v${version} ${resource.url}`);
          if (decided.decision === "allow") allowed++;
        }
    }
  // The matrix covers both outcomes, not only refusals.
  assert.ok(allowed > 0);
  const input = { source_id: ids[0]!, expected_permission_version: 1, lane: "policy", capability: "external_model", resource: resources[0]! };
  assert.throws(() => evaluatePublicSourcePolicy(projections.get(ids[0]!)!, input, now), /public purposes/);
  assert.throws(() => evaluatePublicSourcePolicy(projections.get(ids[1]!)!, { ...input, capability: "public_summary" }, now), /another source/);
});
