import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { readCurrentSourcePolicy, saveSourcePolicy } from "@amp/backend/admin/sources";
import { policyMaterialReferences, upsertMaterial } from "@amp/backend/content/materials";
import { capturePolicyMaterial } from "../packages/backend/src/policy/capture.ts";
import { readPolicyMetadataObservation } from "../packages/backend/src/policy/metadata.ts";
import { readPolicyOriginal } from "../packages/backend/src/policy/originals.ts";
import type { PolicyAutomationProfile } from "../packages/backend/src/policy/automation-profile.ts";
import { grantDateFixture } from "./source-date-fixture.ts";
const sql = dbOf("policy"),
  discovered = new Date("2026-01-02T03:04:05Z");
after(closeDb);
let serial = 0;
async function fixture() {
  const sourceId = `automation-${++serial}`,
    url = `https://source.invalid/laws/${sourceId}`;
  const fact = (value: string) => ({ value, evidenceUrl: "https://source.invalid/official-catalogue", basis: "Synthetic official register fixture" });
  const profile: PolicyAutomationProfile = {
    version: 1,
    officialRole: {
      kind: "official_original",
      evidenceUrl: "https://source.invalid/official-catalogue",
      basis: "Synthetic formal publication responsibility",
      singleObjectPattern: "^https://source\\.invalid/laws/[^/]+$",
    },
    identityMarker: { selector: ".formal", pattern: "^Official decree$" },
    titleSelector: "h1",
    numberSelector: ".number",
    originalLinkSelector: null,
    versionSelector: null,
    identity: { authority: fact(sourceId), jurisdiction: fact("AR"), documentType: fact("decree") },
    language: "en",
    kind: "original",
    recheckMinutes: 60,
    extraction: { bodySelector: "article", attachmentSelector: "a.attachment", maxBytes: 100000, maxResources: 10, maxPages: 10, maxTextBytes: 100000 },
  };
  await sql`INSERT INTO sources(id,name,kind,lane,enabled,config) VALUES(${sourceId},'Synthetic only','web_list','policy',true,${sql.json({ policyProfile: profile })})`;
  await grantDateFixture(sourceId, [url]);
  const material = await upsertMaterial({ sourceId, url, title: "Untrusted listing title", via: "fetch", discoveredAt: discovered });
  const materialId = material.articleId;
  let text = "Permit applies at 10 kg.",
    hits = 0;
  const get = async (address: string) => {
    hits++;
    const body = Buffer.from(
      `<html><span class="formal">Official decree</span><span class="number">1/2026</span><h1>Official mining decree</h1><article><p>${text}</p></article></html>`,
    );
    return { status: 200, url: address, headers: new Headers({ "content-type": "text/html;charset=utf-8" }), body, text: () => body.toString() };
  };
  return {
    sourceId,
    url,
    materialId,
    profile,
    get,
    hits: () => hits,
    setText: (value: string) => {
      text = value;
    },
  };
}

test("captures official fields and actual stored discovery; same URL revisions preserve evidence and never change news state", async () => {
  const f = await fixture(),
    first = await capturePolicyMaterial(f.sourceId, f.materialId, f.get);
  assert.equal(first.status, "captured");
  if (first.status !== "captured") return;
  assert.equal(f.hits(), 1);
  const metadata = await readPolicyMetadataObservation(first.expressionId);
  assert.equal(metadata?.originalTitle, "Official mining decree");
  assert.equal(metadata?.titleZh, undefined);
  assert.equal(metadata?.discoveredAt, discovered.toISOString());
  assert.equal(metadata?.materialId, f.materialId);
  assert.equal(metadata?.provenance.fields.originalTitle.selector, "h1");
  const unchanged = await capturePolicyMaterial(f.sourceId, f.materialId, f.get);
  assert.equal(unchanged.status, "captured");
  assert.equal("revisionId" in unchanged && unchanged.revisionId, first.revisionId);
  f.setText("Permit applies at 11 kg.");
  const changed = await capturePolicyMaterial(f.sourceId, f.materialId, f.get);
  assert.equal(changed.status, "captured");
  assert.notEqual("revisionId" in changed && changed.revisionId, first.revisionId);
  assert.equal((await readPolicyMetadataObservation(first.expressionId))?.discoveredAt, discovered.toISOString());
  assert.equal((await sql`SELECT processing_state FROM articles WHERE id=${f.materialId}`)[0].processing_state, "new");
});

test("metadata-only permissions create no stored fulltext, still retain independently proven basic facts", async () => {
  const f = await fixture(),
    current = (await readCurrentSourcePolicy(f.sourceId))!;
  await saveSourcePolicy(
    f.sourceId,
    {
      policy: { ...current, permission_version: 2, permissions: { ...current.permissions, store_fulltext: "deny" } },
      expectedVersion: 1,
      reason: "Synthetic metadata-only",
    },
    "test",
  );
  const captured = await capturePolicyMaterial(f.sourceId, f.materialId, f.get);
  assert.equal(captured.status, "captured");
  if (captured.status !== "captured") return;
  assert.equal(captured.fulltextAllowed, false);
  assert.equal((await readPolicyOriginal(captured.expressionId))?.resources[0].body, null);
  assert.equal((await readPolicyMetadataObservation(captured.expressionId))?.documentNumber, "1/2026");
  await sql`UPDATE sources SET config='{}'::jsonb WHERE id=${f.sourceId}`;
  assert.equal(await readPolicyMetadataObservation(captured.expressionId), null);
  assert.equal((await capturePolicyMaterial(f.sourceId, f.materialId, f.get)).status, "needs_configuration");
  assert.equal(f.hits(), 1);
});

test("changed configuration during acquisition cannot commit trusted observation; government news marker is not formal identity", async () => {
  const f = await fixture();
  const news = await capturePolicyMaterial(f.sourceId, f.materialId, async (address) => {
    const res = await f.get(address);
    res.body = Buffer.from(res.body.toString().replace("Official decree", "Ministry news"));
    return res;
  });
  assert.equal(news.status, "identity");
  await assert.rejects(
    capturePolicyMaterial(f.sourceId, f.materialId, async (address) => {
      const response = await f.get(address);
      await sql`UPDATE sources SET enabled=false WHERE id=${f.sourceId}`;
      return response;
    }),
    /configuration changed or paused/,
  );
  assert.equal((await sql`SELECT count(*)::int AS n FROM policy.metadata_observations WHERE source_id=${f.sourceId}`)[0].n, 0);
});

test("bounded material scan includes every source binding even when a page ends within one material", async () => {
  const a = await fixture(),
    b = await fixture();
  await upsertMaterial({ sourceId: b.sourceId, url: a.url, title: "Other listing", via: "fetch" });
  let cursor = { materialId: "", sourceId: "" };
  const rows = [];
  for (;;) {
    const page = await policyMaterialReferences([a.sourceId, b.sourceId], cursor, 1);
    if (!page.length) break;
    rows.push(...page);
    cursor = page[0];
  }
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((row) => row.materialId === a.materialId).length, 2);
});
