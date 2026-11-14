// TASK-0576: the instrument gate where it acts — the publisher writes no edition (basic or complete) for an item that is
// not a final, mining-related legal instrument, and records why; Argentine basic facts carry the procedure read from the
// gazette text and link an amended law that is in the library; the regate command hides earlier junk reversibly; and the
// policy list never reads news. Synthetic official pages; no network, no model.
import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { capturePolicyMaterial } from "../modules/policy/backend/domain/capture.ts";
import { structurePolicyRevision } from "../modules/policy/backend/domain/provision-store.ts";
import { publishPolicyPublication } from "../modules/policy/backend/publication/policies-publish.ts";
import { regatePolicyDocuments } from "../modules/policy/backend/publication/policy-regate.ts";
import { policyDetail } from "../modules/policy/backend/read.ts";
import { fixture } from "./policy-automation-fixture.ts";

after(closeDb);

/** A source of the given language and jurisdiction whose page shows this title, number and body. */
async function source(input: { title: string; number: string; body: string; language: string; jurisdiction: string; type: string; date?: string }) {
  const f = await fixture();
  const profile = {
    ...f.profile,
    language: input.language,
    identity: {
      ...f.profile.identity,
      jurisdiction: { ...f.profile.identity.jurisdiction, value: input.jurisdiction },
      documentType: { ...f.profile.identity.documentType!, value: input.type },
    },
  };
  await sql`UPDATE sources SET config=${sql.json({ policyProfile: profile })} WHERE id=${f.sourceId}`;
  if (input.date) {
    const { readSourceDateContext } = await import("@amp/backend/admin/sources");
    const { observeSourceDate } = await import("../packages/backend/src/sources/date-extraction.ts");
    const { updateMaterialSourceDate } = await import("../packages/backend/src/content/date-evidence.ts");
    const observation = observeSourceDate((await readSourceDateContext(f.sourceId))!, f.url, input.date, "official.date", { format: "iso8601" });
    observation.meaning = "published";
    observation.publicationBasis = "source_published";
    await updateMaterialSourceDate(f.materialId, 1, { sourceDateObservation: observation, permissionVersion: 1, expectedSourceDateVersion: 0 });
  }
  const paragraphs = input.body
    .split("\n")
    .map((line) => `<p>${line}</p>`)
    .join("");
  const get = async (address: string) => {
    const body = Buffer.from(
      `<html><span class="formal">Official decree</span><span class="number">${input.number}</span><h1>${input.title}</h1><article>${paragraphs}</article></html>`,
    );
    return { status: 200, url: address, headers: new Headers({ "content-type": "text/html;charset=utf-8" }), body, text: () => body.toString() };
  };
  const captured = await capturePolicyMaterial(f.sourceId, f.materialId, get);
  if (captured.status !== "captured") throw new Error(`capture ${captured.status}`);
  await structurePolicyRevision(captured.expressionId, profile.extraction);
  return { ...f, profile, expressionId: captured.expressionId };
}

const LAW = `El Senado y Cámara de Diputados de la Nación Argentina reunidos en Congreso, etc. sancionan con fuerza de Ley:
ARTÍCULO 1°.- Sustitúyese el artículo 22 de la Ley N° 24.196 por el siguiente: "Las provincias no podrán percibir regalías mineras superiores al tres por ciento (3%)".
ARTÍCULO 2°.- Comuníquese al Poder Ejecutivo nacional.
DADA EN LA SALA DE SESIONES DEL CONGRESO ARGENTINO, EN BUENOS AIRES, A LOS VEINTIOCHO DÍAS DEL MES DE OCTUBRE DEL AÑO DOS MIL VEINTISÉIS.
Decreto 812/2026
Ciudad de Buenos Aires, 03/11/2026
En uso de las facultades conferidas por el artículo 99, inciso 3, de la CONSTITUCIÓN NACIONAL, Promúlgase la Ley N° 27.801.`;

test("the publisher writes no edition for junk or a bill, records the gate's reason, and audits the hold", async () => {
  const junk = await source({
    title: "关于精子生产液质量管理的通知",
    number: "国卫办〔2026〕3号",
    body: "各省卫生健康委：现就精子生产液质量管理通知如下。",
    language: "zh-CN",
    jurisdiction: "CN",
    type: "规范性文件",
  });
  const result = await publishPolicyPublication({ expressionId: junk.expressionId });
  assert.equal(result.status, "pending");
  assert.equal(result.status === "pending" && result.reason, "not_instrument");
  assert.match(result.status === "pending" ? (result.detail ?? "") : "", /与矿业无关/);
  const [doc] = await sql<{ id: string; automatic_excluded: boolean; instrument_gate_hold: { reason: string; kind: string } }[]>`
    SELECT d.id,d.automatic_excluded,d.instrument_gate_hold FROM publication.policy_documents d JOIN publication.policy_ids i ON i.public_id=d.id
    WHERE i.kind='material' AND i.internal_id=${String(junk.materialId)}`;
  assert.equal(doc!.automatic_excluded, true);
  assert.deepEqual([doc!.instrument_gate_hold.reason, doc!.instrument_gate_hold.kind], ["not_mining", "zh_normative_notice"]);
  assert.equal((await sql`SELECT 1 FROM publication.policy_editions WHERE policy_id=${doc!.id}`).length, 0, "no basic or complete edition");
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE action='policy.instrument_gate.hold' AND subject=${`policy:${doc!.id}`}`).length, 1);
  // A retry with the same answer neither rewrites nor re-audits.
  await publishPolicyPublication({ expressionId: junk.expressionId });
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE action='policy.instrument_gate.hold' AND subject=${`policy:${doc!.id}`}`).length, 1);

  const bill = await source({
    title: "Proyecto de Ley de promoción de la minería de litio",
    number: "S-1234/26",
    body: "El Senado y Cámara de Diputados ...",
    language: "es",
    jurisdiction: "AR",
    type: "ley",
  });
  const held = await publishPolicyPublication({ expressionId: bill.expressionId });
  assert.equal(held.status === "pending" && held.reason, "not_instrument");
  assert.match(held.status === "pending" ? held.detail! : "", /草案、征求意见或预告/);
});

test("an Argentine law: basic facts say published, carry sanción, promulgación and the computed entry into force, and link the amended law once it is in the library", async () => {
  const law = await source({
    title: "Ley 27.801 RÉGIMEN DE INVERSIONES MINERAS. Modificación.",
    number: "27.801",
    body: LAW,
    language: "es",
    jurisdiction: "AR",
    type: "ley",
    date: "2026-11-04",
  });
  const published = await publishPolicyPublication({ expressionId: law.expressionId });
  if (published.status !== "published") return assert.fail(`published: ${JSON.stringify(published)}`);
  const detail = await policyDetail(published.policyId);
  assert.equal(detail.interpretation_state, "basic_facts");
  assert.deepEqual([detail.nature.code, detail.legal_brief.stage, detail.legal_brief.in_force], ["law", "published", "unknown"]);
  assert.match(detail.legal_state.legislative_stage.basis!, /程序从公报原文抽取/);
  const byKind = Object.fromEntries(detail.dates.map((d) => [d.event_kind, d]));
  assert.equal(byKind.adoption?.local_date, "2026-10-28");
  assert.equal(byKind.promulgation?.local_date, "2026-11-03");
  assert.equal(byKind.original_publication?.local_date, "2026-11-04");
  assert.deepEqual([byKind.entry_into_force?.local_date, byKind.entry_into_force?.occurrence], ["2026-11-13", "planned"]);
  assert.match(byKind.entry_into_force!.basis, /第5条/);
  assert.deepEqual(
    detail.relationships.map((r) => [r.relation, r.target_citation, r.target_policy_id]),
    [["updates", "Ley N° 24.196", null]],
  );
  assert.equal(detail.evidence.length, 1);
  assert.match(detail.evidence[0]!.excerpt ?? "", /^Sustitúyese el artículo 22 de la Ley N° 24\.196/);
  assert.deepEqual(detail.main_points, []);
  assert.equal(detail.guide, null);

  const target = await source({
    title: "Ley 24.196 INVERSIONES MINERAS",
    number: "24.196",
    body: "ARTÍCULO 1°.- Institúyese el régimen de inversiones para la actividad minera.",
    language: "es",
    jurisdiction: "AR",
    type: "ley",
  });
  const targetPublished = await publishPolicyPublication({ expressionId: target.expressionId });
  if (targetPublished.status !== "published") return assert.fail("target published");
  const linked = await policyDetail(published.policyId);
  assert.deepEqual(
    linked.relationships.map((r) => r.target_policy_id),
    [targetPublished.policyId],
  );
  // The target withdrawn: the citation stays as text.
  await sql`UPDATE publication.policy_documents SET withdrawn=true WHERE id=${targetPublished.policyId}`;
  assert.deepEqual(
    (await policyDetail(published.policyId)).relationships.map((r) => [r.target_citation, r.target_policy_id]),
    [["Ley N° 24.196", null]],
  );
});

test("regate: a dry run counts and changes nothing; --apply hides earlier junk reversibly and keeps a real mining law; --restore lifts exactly the gate's holds", async () => {
  const kept = await source({
    title: "Ley 25.000 Régimen de regalías mineras",
    number: "25.000",
    body: "ARTÍCULO 1°.- Fíjanse las regalías mineras provinciales.",
    language: "es",
    jurisdiction: "AR",
    type: "ley",
  });
  const keptPublished = await publishPolicyPublication({ expressionId: kept.expressionId });
  const old = await source({
    title: "自然资源部关于矿业权出让收益的通知",
    number: "自然资发〔2026〕9号",
    body: "现就有关事项通知如下。",
    language: "zh-CN",
    jurisdiction: "CN",
    type: "规范性文件",
  });
  const oldPublished = await publishPolicyPublication({ expressionId: old.expressionId });
  if (keptPublished.status !== "published" || oldPublished.status !== "published") return assert.fail("both published");
  // An edition published before the gate existed, with the junk title that reached the list.
  await sql`UPDATE publication.policy_editions SET basic_card=jsonb_set(basic_card,'{original_title}','"关于精子生产液质量管理的通知"') WHERE policy_id=${oldPublished.policyId}`;

  const dry = await regatePolicyDocuments({ mode: "dry-run" });
  assert.equal(dry.mode, "dry-run");
  assert.ok(dry.skipped.withdrawn >= 1, "the document withdrawn by hand in the previous test is not re-gated");
  assert.ok(dry.samples.some((s) => s.policyId === oldPublished.policyId && s.reason === "not_mining" && s.title === "关于精子生产液质量管理的通知"));
  assert.ok(!dry.samples.some((s) => s.policyId === keptPublished.policyId));
  assert.ok(dry.hide >= 1);
  assert.ok(dry.byReason["not_mining（与矿业无关）"]! >= 1);
  assert.ok(dry.bySource[old.sourceId] === 1);
  assert.ok(dry.samples.length <= 10);
  assert.equal((await policyDetail(oldPublished.policyId)).id, oldPublished.policyId, "a dry run hides nothing");

  const applied = await regatePolicyDocuments({ mode: "apply" });
  assert.equal(applied.hide, dry.hide);
  await assert.rejects(policyDetail(oldPublished.policyId), /policy_not_found/);
  assert.equal((await policyDetail(keptPublished.policyId)).id, keptPublished.policyId);
  assert.equal((await sql`SELECT 1 FROM publication.policy_editions WHERE policy_id=${oldPublished.policyId}`).length, 1, "never deletes");
  assert.equal((await regatePolicyDocuments({ mode: "apply" })).hide, 0, "a second apply has nothing new to hide");

  // A manual withdrawal is never lifted by --restore.
  await sql`UPDATE publication.policy_documents SET withdrawn=true WHERE id=${keptPublished.policyId}`;
  const restored = await regatePolicyDocuments({ mode: "restore" });
  assert.ok(restored.release >= 1);
  assert.equal((await policyDetail(oldPublished.policyId)).id, oldPublished.policyId);
  await assert.rejects(policyDetail(keptPublished.policyId), /policy_withdrawn/);
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE action='policy.instrument_gate.restore' AND subject=${`policy:${oldPublished.policyId}`}`).length, 1);
});

test("the policy list reads only the policy library: news never becomes a policy item", async () => {
  const source = readFileSync("modules/policy/backend/read.ts", "utf8");
  const tables = new Set([...source.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+\.[a-z_]+)/g)].map((m) => m[1]));
  assert.deepEqual(
    [...tables].sort(),
    ["publication.policy_documents", "publication.policy_editions", "publication.policy_quality_windows"].filter((t) => tables.has(t)).sort(),
  );
  for (const table of tables) assert.match(table!, /^publication\.policy_/, `${table}: the policy list reads no news table`);
  // News reaches a policy page only as related reports, through the named read-only entry, never as list items.
  assert.deepEqual(
    [...source.matchAll(/^import \{([^}]+)\} from "@amp\/backend\/publication\/news-links";$/gm)].map((m) => m[1]!.trim()),
    ["relatedNewsForPolicy, currentNewsJurisdictionCounts"],
  );
  const { listPolicies } = await import("../modules/policy/backend/read.ts");
  const items = (await listPolicies({ page_size: 50 })).items;
  const known = new Set((await sql<{ policy_id: string }[]>`SELECT DISTINCT policy_id FROM publication.policy_editions`).map((r) => r.policy_id));
  for (const item of items) assert.ok(known.has(item.id), `${item.id} comes from the policy library`);
});
