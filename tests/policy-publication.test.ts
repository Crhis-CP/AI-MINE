import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, dbOf, injectDb } from "@amp/backend/db";
import { readCurrentSourcePolicy, saveSourcePolicy } from "@amp/backend/admin/sources";
import { upsertMaterial } from "@amp/backend/content/materials";
import { capturePolicyMaterial } from "../packages/backend/src/policy/capture.ts";
import type { PolicyAutomationProfile } from "../packages/backend/src/policy/automation-profile.ts";
import { publishPolicyPublication, setPolicyPublicationPaused, setPolicyPublicationState } from "../packages/backend/src/publication/policies-publish.ts";
import { policyDetail, policyPublicVersions } from "../packages/backend/src/publication/policies.ts";
import { publicRoleFixture } from "./public-role-fixture.ts";
import { matchingPolicyQuality } from "../packages/backend/src/policy/quality.ts";
import { grantDateFixture } from "./source-date-fixture.ts";
const sql = dbOf("policy"),
  discovered = new Date("2026-01-02T03:04:05Z");
after(closeDb);
let serial = 0;
async function fixture() {
  const sourceId = `publication-${++serial}`,
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

test("real capture publishes only independently proven facts, is idempotent and preserves publication controls", async (t) => {
  const roles = await publicRoleFixture(t);
  const reset = injectDb({ policy: roles.admin, sources: roles.admin, content: roles.admin, publication: roles.admin });
  t.after(reset);
  const f = await fixture(),
    current = (await readCurrentSourcePolicy(f.sourceId))!;
  await saveSourcePolicy(
    f.sourceId,
    {
      policy: {
        ...current,
        permission_version: 2,
        permissions: { ...current.permissions, store_fulltext: "deny", public_original_fulltext: "deny", public_translation: "deny" },
      },
      expectedVersion: 1,
      reason: "Synthetic metadata only",
    },
    "test",
  );
  const captured = await capturePolicyMaterial(f.sourceId, f.materialId, f.get);
  assert.equal(captured.status, "captured");
  if (captured.status !== "captured") return;
  const sessions = await roles.login();
  reset();
  const restore = injectDb({ policy: sessions.worker, sources: sessions.worker, content: sessions.worker, publication: sessions.worker });
  t.after(restore);
  const [a, b] = await Promise.all([
    publishPolicyPublication({ expressionId: captured.expressionId }),
    publishPolicyPublication({ expressionId: captured.expressionId }),
  ]);
  assert.equal(
    await matchingPolicyQuality({
      sourceId: f.sourceId,
      language: "en",
      fulltextRecipe: "synthetic",
      interpretationRecipe: "synthetic",
      models: ["synthetic"],
    }),
    null,
  );
  restore();
  const done = injectDb({ policy: roles.admin, sources: roles.admin, content: roles.admin, publication: roles.admin });
  t.after(done);
  assert.equal(a.status, "published");
  assert.deepEqual(a, b);
  if (a.status !== "published") return;
  assert.equal(a.mode, "basic_facts");
  const dto = await policyDetail(a.policyId, {});
  assert.equal(dto.interpretation_state, "basic_facts");
  assert.equal(dto.original_title, "Official mining decree");
  assert.equal(dto.instrument_number, "1/2026");
  assert.equal(dto.guide, null);
  assert.equal(dto.reading, null);
  assert.notEqual(a.policyId, captured.expressionId);
  assert.equal((await policyPublicVersions()).find((v) => v.editionId === a.editionId)?.discoveredAt, discovered.toISOString());
  assert.equal((await sql`SELECT count(*)::int n FROM policy.quality_releases`)[0].n, 0);
  assert.equal((await sql`SELECT count(*)::int n FROM publication.policy_editions`)[0].n, 1);
  const version = await setPolicyPublicationPaused({ expectedVersion: 1, paused: true, reason: "Synthetic pause", actor: "test" });
  assert.deepEqual(await publishPolicyPublication({ expressionId: captured.expressionId }), { status: "pending", reason: "paused" });
  assert.equal((await policyDetail(a.policyId, {})).id, a.policyId);
  await setPolicyPublicationPaused({ expectedVersion: version, paused: false, reason: "Synthetic resume", actor: "test" });
  await setPolicyPublicationState(a.policyId, { withdrawn: true, reason: "Synthetic withdrawal", actor: "test" });
  assert.deepEqual(await publishPolicyPublication({ expressionId: captured.expressionId }), { status: "pending", reason: "withdrawn" });
  await assert.rejects(policyDetail(a.policyId, {}), /policy_withdrawn/);
  assert.equal((await policyPublicVersions()).length, 0);
});
