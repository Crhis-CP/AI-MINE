import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { evaluateSourcePolicy, saveSourcePolicy } from "@amp/backend/admin/sources";
import { SourcePolicySchema } from "@amp/contracts/source-policy";
import { sourcePolicyExample } from "./permission-fixture.ts";
import { metadataRepairs, repairedMetadataPolicy } from "../scripts/source-health-repair.ts";

const sql = dbOf("sources");
after(closeDb);
test("the three official cross-host repairs grant only scoped metadata uses and retain existing denies", async () => {
  for (const repair of metadataRepairs) {
    const scope = { hosts: [repair.listingHost], path_prefixes: ["/"], document_types: [], excluded_content: [] };
    const before = SourcePolicySchema.parse({
      ...structuredClone(sourcePolicyExample),
      source_id: repair.id,
      scope,
      evidence: sourcePolicyExample.evidence.map((e) => ({ ...e, scope })),
      permissions: { ...sourcePolicyExample.permissions, public_translation: "deny", public_original_fulltext: "deny" },
    });
    const after = repairedMetadataPolicy(before, repair);
    assert.deepEqual(after.permissions, before.permissions);
    assert.deepEqual(after.evidence.slice(0, -1), before.evidence);
    await sql`INSERT INTO sources(id,name,kind) VALUES (${repair.id}, ${tag()}, 'web_list')`;
    await saveSourcePolicy(repair.id, { expectedVersion: null, policy: after, reason: "Synthetic metadata scope test" }, "test");
    for (const capability of [
      "fetch",
      "store_metadata",
      "process_locally",
      "store_fulltext",
      "external_model",
      "public_summary",
      "public_translation",
    ] as const) {
      const result = await evaluateSourcePolicy({
        source_id: repair.id,
        expected_permission_version: 1,
        lane: "policy",
        capability,
        resource: { url: `https://${repair.host}${repair.path}synthetic`, attachment: false, document_type: null },
      });
      assert.equal(result.decision, ["fetch", "store_metadata", "process_locally"].includes(capability) ? "allow" : "deny", capability);
    }
    const outside = await evaluateSourcePolicy({
      source_id: repair.id,
      expected_permission_version: 1,
      lane: "policy",
      capability: "fetch",
      resource: { url: `https://${repair.host}/unrelated/synthetic`, attachment: false, document_type: null },
    });
    assert.equal(outside.decision, "deny");
    assert.throws(() => repairedMetadataPolicy({ ...before, permissions: { ...before.permissions, fetch: "deny" } }, repair), /must not be relaxed/);
    assert.throws(() => repairedMetadataPolicy({ ...before, conditions: ["third_party_excluded"] }, repair), /separate review/);
  }
});
