import { POLICY_MODEL_BINDING_VERSION } from "../packages/backend/src/policy/model-evidence.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dbOf, injectDb } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { grantDateFixture } from "./source-date-fixture.ts";
import { publicRoleFixture, publicServer } from "./public-role-fixture.ts";
import { capturePolicyMaterial } from "../packages/backend/src/policy/capture.ts";
import { readPolicyOriginal } from "../packages/backend/src/policy/originals.ts";
import { extractPolicyOriginal } from "../packages/backend/src/policy/extraction.ts";
import { buildPolicyFulltextPlan, type PolicyPart } from "../packages/backend/src/policy/processing-plan.ts";
import { beginPolicyFulltext, finishPolicyFulltext } from "../packages/backend/src/policy/fulltext-store.ts";
import type { Candidate } from "../packages/backend/src/policy/interpretation-schema.ts";
import type { PolicyAutomationProfile } from "../packages/backend/src/policy/automation-profile.ts";
import { explicitPolicyReference } from "../packages/backend/src/policy/references.ts";
import { publishPolicyPublication } from "../packages/backend/src/publication/policies-publish.ts";
import { preparePolicyRelationships, savePolicyRelationships, policyRelationshipCandidates } from "../packages/backend/src/publication/policy-relations.ts";
import { Policy, PolicyCard, PolicyThread } from "@amp/contracts/http/public";
import { sha256, stableJson } from "@amp/backend/lib/ids";
const sql = dbOf("policy"),
  discovered = new Date("2026-01-02T03:04:05Z");
let serial = 0;
async function fixture(number: string, content = "Mining rule.", jurisdiction = "AR", overrideUrl?: string) {
  const sourceId = `relation-${++serial}`,
    url = overrideUrl ?? `https://source.invalid/laws/${sourceId}`;
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
    identity: { authority: fact(sourceId), jurisdiction: fact(jurisdiction), documentType: fact("decree") },
    language: "en",
    kind: "original",
    recheckMinutes: 60,
    extraction: { bodySelector: "article", attachmentSelector: "a.attachment", maxBytes: 100000, maxResources: 10, maxPages: 10, maxTextBytes: 100000 },
  };
  await sql`INSERT INTO sources(id,name,kind,lane,enabled,config) VALUES(${sourceId},'Synthetic only','web_list','policy',true,${sql.json({ policyProfile: profile })})`;
  await grantDateFixture(sourceId, [url]);
  const material = await upsertMaterial({ sourceId, url, title: "Untrusted listing title", via: "fetch", discoveredAt: discovered });
  const materialId = material.articleId;
  let text = content,
    hits = 0;
  const get = async (address: string) => {
    hits++;
    const body = Buffer.from(
      `<html><span class="formal">Official decree</span><span class="number">${number}</span><h1>Official mining decree</h1><article><p>${text}</p></article></html>`,
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

test("exact reference needs genuine visible URI or its own href; neighbouring/prefix/other-host addresses do not qualify", () => {
  const part = {
    source: '<p>Amends <a href="https://source.invalid/laws/2">2/2026</a>.</p>',
    format: "html",
    resourceUrl: "https://source.invalid/laws/1",
  } as PolicyPart;
  assert.ok(explicitPolicyReference(part, "2/2026", "https://source.invalid/laws/2", "Amends 2/2026."));
  assert.equal(explicitPolicyReference(part, "2/2026", "https://source.invalid/laws/20", "Amends 2/2026."), false);
  assert.equal(explicitPolicyReference(part, "3/2026", "https://source.invalid/laws/2", "Amends 2/2026."), false);
  assert.equal(
    explicitPolicyReference({ ...part, source: "2/2026 https://source.invalid/laws/20", format: "text" }, "2/2026", "https://source.invalid/laws/2"),
    false,
  );
});
test("current qualified relations produce stable navigation and every public outlet removes a withdrawn or changed endpoint", async (t) => {
  const roles = await publicRoleFixture(t),
    reset = injectDb({ ops: roles.admin, policy: roles.admin, sources: roles.admin, content: roles.admin, publication: roles.admin });
  t.after(reset);
  const app = await publicServer(t, roles);
  t.after(app.stop);
  const publish = async (f: Awaited<ReturnType<typeof fixture>>) => {
    const c = await capturePolicyMaterial(f.sourceId, f.materialId, f.get);
    assert.equal(c.status, "captured");
    if (c.status !== "captured") throw Error("capture");
    const p = await publishPolicyPublication({ expressionId: c.expressionId });
    assert.equal(p.status, "published");
    if (p.status !== "published") throw Error("publish");
    return { f, c, p };
  };
  const target = await publish(await fixture("2/2026"));
  const source = await publish(await fixture("1/2026", `Amends <a href="${target.f.url}">2/2026</a>.`));
  const snapshot = (await readPolicyOriginal(source.c.expressionId))!;
  const extracted = await extractPolicyOriginal(source.c.expressionId, source.f.profile.extraction);
  const plan = buildPolicyFulltextPlan(extracted, {
    sourceId: source.f.sourceId,
    expressionId: source.c.expressionId,
    language: "en",
    identityHash: sha256(stableJson(snapshot.manifest.identity)),
    recipeVersion: "synthetic-only",
  });
  assert.equal(plan.status, "planned");
  if (plan.status !== "planned") return;
  const run = (await beginPolicyFulltext(snapshot, plan, "synthetic-only"))!;
  await finishPolicyFulltext(run, { synthetic: true }, true);
  assert.deepEqual(
    (await policyRelationshipCandidates(run.id)).map((r) => r.id),
    [target.p.policyId],
  );
  const part = plan.parts.find((p) => p.source.includes("2/2026"))!;
  const candidate = {
    relationships: [{ relation: "updates", target_policy_id: target.p.policyId, target_citation: "2/2026", evidence_ids: ["e"] }],
    evidence: [{ id: "e", part_id: part.partId, quote: "Amends 2/2026." }],
  } as Candidate;
  const links = await preparePolicyRelationships(run, candidate);
  assert.equal(links.length, 1);
  const full = Policy.parse(JSON.parse(readFileSync(new URL("./fixtures/policy-public/complete.json", import.meta.url), "utf8")));
  full.id = source.p.policyId;
  full.ai_metadata.content_id = full.id;
  full.instrument_number = "1/2026";
  full.original_url = source.f.url;
  full.relationships = [{ ...candidate.relationships[0]!, target_policy_id: null, evidence_ids: [full.evidence[0]!.evidence_id] }];
  const card = PolicyCard.parse(Object.fromEntries(Object.keys(PolicyCard.shape).map((k) => [k, full[k as keyof Policy]])));
  await roles.admin`INSERT INTO publication.policy_quality_windows(id,valid_until,revoked,binding_version) VALUES('synthetic-relations',now()+interval '1 hour',false,${POLICY_MODEL_BINDING_VERSION})`;
  await roles.admin`UPDATE publication.policy_editions SET complete_card=${roles.admin.json(card)},complete_detail=${roles.admin.json(full)},quality_id='synthetic-relations' WHERE id=${source.p.editionId}`;
  await roles.admin.begin((tx) => savePolicyRelationships(tx, source.p.policyId, source.p.editionId, links, { e: full.evidence[0]!.evidence_id }));
  const get = async () => Policy.parse(await (await app.request(`/api/site/policies/${source.p.policyId}`)).json());
  const first = await get();
  assert.equal(first.relationships[0]?.target_policy_id, target.p.policyId);
  assert.ok(first.thread_id);
  const thread = PolicyThread.parse(await (await app.request(`/api/site/policy-threads/${first.thread_id}`)).json());
  assert.equal(thread.policies.length, 2);
  assert.ok(thread.summary?.includes("分别"));
  await roles.admin.begin((tx) => savePolicyRelationships(tx, source.p.policyId, source.p.editionId, links, { e: full.evidence[0]!.evidence_id }));
  assert.equal((await get()).thread_id, first.thread_id);
  await roles.admin`UPDATE publication.policy_documents SET withdrawn=true WHERE id=${target.p.policyId}`;
  assert.equal((await get()).relationships.length, 0);
  assert.equal((await get()).thread_id, null);
  assert.equal((await app.request(`/api/site/policy-threads/${first.thread_id}`)).status, 404);
  assert.equal((await policyRelationshipCandidates(run.id)).length, 0);
  await roles.admin`UPDATE publication.policy_documents SET withdrawn=false WHERE id=${target.p.policyId}`;
  await roles.admin`UPDATE publication.policy_quality_windows SET valid_until=now()-interval '1 second' WHERE id='synthetic-relations'`;
  assert.equal((await get()).interpretation_state, "basic_facts");
  assert.equal((await get()).thread_id, null);
});
