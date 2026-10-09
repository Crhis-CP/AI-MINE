import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { dbOf, initializeDb, closeDb } from "@amp/backend/db";
import { readCurrentSourcePolicy, saveSourcePolicy } from "@amp/backend/admin/sources";
import { sha256 } from "@amp/backend/lib/ids";
import { createFallbackPermitPort, type FallbackMaterialSnapshot } from "../packages/backend/src/providers/model-fallback-permit.ts";
import { grantDateFixture } from "./source-date-fixture.ts";
const sql = dbOf("sources"),
  root = await initializeDb("test");
after(closeDb);
test("each fallback target gets a fresh supplier-bound permit that cannot survive input or permission changes", async () => {
  const id = `fallback-permit-${tag()}`,
    url = `https://source.invalid/${id}`;
  await sql`INSERT INTO sources(id,name,kind,lane,enabled) VALUES(${id},${id},'external','news',false)`;
  await grantDateFixture(id, [url]);
  const snapshot: FallbackMaterialSnapshot = {
    inputFingerprint: sha256("actual prepared request"),
    manifest: {
      schema_version: 1,
      kind: "source_materials",
      lane: "news",
      materials: [
        {
          source_id: id,
          material_id: id,
          revision: 1,
          content_hash: sha256("real stored fixture bytes"),
          resource: { url, document_type: null, attachment: false },
        },
      ],
      upstream_artifacts: [],
    },
  };
  let live = structuredClone(snapshot);
  const port = createFallbackPermitPort({ root, snapshot, current: async () => structuredClone(live) });
  const a = await port.authorize({ modelKey: "registered:source-a", configurationHash: sha256("config-a") }),
    b = await port.authorize({ modelKey: "registered:source-b", configurationHash: sha256("config-b") });
  try {
    assert.notEqual(a.inputFingerprint, b.inputFingerprint);
    await a.beforeRequest();
    await b.beforeRequest();
    live = { ...live, inputFingerprint: sha256("changed prepared request") };
    await assert.rejects(a.beforeRequest(), /材料版本已变化/);
    live = structuredClone(snapshot);
    const policy = (await readCurrentSourcePolicy(id))!;
    await saveSourcePolicy(
      id,
      {
        expectedVersion: policy.permission_version,
        policy: { ...policy, permissions: { ...policy.permissions, external_model: "deny" } },
        reason: "Synthetic denial",
      },
      "test",
    );
    await assert.rejects(b.beforeRequest(), /备用材料许可已变化/);
  } finally {
    a.close();
    b.close();
  }
  await assert.rejects(port.authorize({ modelKey: "registered:source-c", configurationHash: sha256("config-c") }), /许可未通过/);
});
