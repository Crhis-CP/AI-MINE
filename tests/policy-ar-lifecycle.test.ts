// TASK-0576: the Argentine procedure read from the gazette text by rules (no model) — sanción, promulgación,
// publication, entry into force (stated, or computed by art. 5 of the Código Civil y Comercial and labelled so) and the
// instruments a text amends or repeals. Synthetic but realistic Boletín Oficial texts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Policy } from "@amp/contracts/http/public";
import {
  addDays,
  argentineLifecycle,
  argentineTargets,
  citationKey,
  citationLabel,
  spanishNumber,
  spanishYear,
} from "../modules/policy/backend/domain/ar-lifecycle.ts";
import { classifyInstrument } from "../modules/policy/backend/domain/instrument-gate.ts";
import { argentinePublicationDate } from "../modules/policy/backend/publication/policies-publish.ts";
import { withInstrumentFacts } from "../modules/policy/backend/publication/policies-project.ts";
import { argentineStages } from "../modules/policy/web/features/lifecycle.ts";
import { readFileSync } from "node:fs";

const LAW = `Ley 27.801
RÉGIMEN DE INVERSIONES MINERAS. Modificación.
El Senado y Cámara de Diputados de la Nación Argentina reunidos en Congreso, etc. sancionan con fuerza de Ley:
ARTÍCULO 1°.- Sustitúyese el artículo 22 de la Ley N° 24.196 por el siguiente: "Las provincias no podrán percibir regalías mineras superiores al tres por ciento (3%)".
ARTÍCULO 2°.- Derógase el artículo 5° del Decreto N° 456/97.
ARTÍCULO 3°.- Comuníquese al Poder Ejecutivo nacional.
DADA EN LA SALA DE SESIONES DEL CONGRESO ARGENTINO, EN BUENOS AIRES, A LOS VEINTIOCHO DÍAS DEL MES DE OCTUBRE DEL AÑO DOS MIL VEINTISÉIS.
REGISTRADA BAJO EL N° 27.801
Decreto 812/2026
DECTO-2026-812-APN-PTE - Ley N° 27.801. Promulgación.
Ciudad de Buenos Aires, 03/11/2026
En uso de las facultades conferidas por el artículo 99, inciso 3, de la CONSTITUCIÓN NACIONAL, Promúlgase la Ley N° 27.801.`;

test("a national law: sanción from the closing formula in words, promulgación from the decree printed with it, art. 5 entry into force", () => {
  const life = argentineLifecycle({ text: LAW, publicationDate: "2026-11-04" });
  assert.equal(life.sanction?.date, "2026-10-28");
  assert.match(life.sanction!.raw, /A LOS VEINTIOCHO DÍAS DEL MES DE OCTUBRE DEL AÑO DOS MIL VEINTISÉIS/);
  assert.deepEqual([life.promulgation?.date, life.promulgation?.tacit], ["2026-11-03", false]);
  assert.match(life.promulgation!.raw, /^Ciudad de Buenos Aires, 03\/11\/2026 … Promúlgase/);
  assert.equal(life.publication?.date, "2026-11-04");
  // “Las leyes rigen después del octavo día de su publicación oficial” (art. 5), counted under art. 6 without the publication day.
  assert.deepEqual([life.vigencia?.date, life.vigencia?.basis], ["2026-11-13", "legal_default"]);
});

test("labelled sanción and promulgación dates, month names first or day first; tacit promulgation", () => {
  const salta = argentineLifecycle({
    text: "Sancionada: 12 de marzo de 2026. Promulgada: Marzo 20 de 2026. ARTÍCULO 1°.- Modifícase la Ley N° 7141 de regalías mineras.",
    publicationDate: "2026-03-25",
  });
  assert.deepEqual([salta.sanction?.date, salta.promulgation?.date], ["2026-03-12", "2026-03-20"]);
  assert.equal(salta.sanction?.raw, "Sancionada: 12 de marzo de 2026");
  const tacit = argentineLifecycle({ text: "SANCIONADA EL 2 DE SEPTIEMBRE DE 2026. PROMULGADA DE HECHO: 23/09/2026.", publicationDate: "2026-09-30" });
  assert.deepEqual([tacit.sanction?.date, tacit.promulgation?.date, tacit.promulgation?.tacit], ["2026-09-02", "2026-09-23", true]);
});

test("entry into force stated by the text wins: from publication, the next day, a fixed date, N days after", () => {
  const at = (clause: string, published = "2026-10-31") =>
    argentineLifecycle({ text: `VISTO ... RESUELVE: ARTÍCULO 1°.- Apruébase. ARTÍCULO 2°.- ${clause}`, publicationDate: published }).vigencia;
  assert.deepEqual(at("La presente resolución entrará en vigencia a partir del día siguiente al de su publicación en el Boletín Oficial."), {
    date: "2026-11-01",
    raw: "entrará en vigencia a partir del día siguiente al de su publicación en el Boletín Oficial",
    basis: "stated",
  });
  assert.equal(at("Esta medida entrará en vigencia a partir de su publicación en el Boletín Oficial.")?.date, "2026-10-31");
  assert.equal(at("La presente entrará en vigencia el 1° de enero de 2027.")?.date, "2027-01-01");
  assert.equal(at("La presente regirá a partir del 15 de diciembre de 2026.")?.date, "2026-12-15");
  assert.equal(at("La presente entrará en vigencia a los treinta (30) días de su publicación.")?.date, "2026-11-30");
  assert.equal(at("La presente entrará en vigencia a los treinta (30) días de su publicación.")?.basis, "stated");
});

test("the art. 5 default crosses month and year boundaries and leap days; no date without a publication date", () => {
  assert.equal(argentineLifecycle({ text: "ARTÍCULO 1°.- Apruébase.", publicationDate: "2026-10-25" }).vigencia?.date, "2026-11-03");
  assert.equal(argentineLifecycle({ text: "ARTÍCULO 1°.- Apruébase.", publicationDate: "2026-12-28" }).vigencia?.date, "2027-01-06");
  assert.equal(argentineLifecycle({ text: "ARTÍCULO 1°.- Apruébase.", publicationDate: "2028-02-25" }).vigencia?.date, "2028-03-05");
  assert.equal(addDays("2026-01-31", 1), "2026-02-01");
  assert.deepEqual(argentineLifecycle({ text: "ARTÍCULO 1°.- Apruébase.", publicationDate: null }).vigencia, null);
});

test("amended and repealed instruments by number: kind, number with or without thousands dots, two-digit years", () => {
  const targets = argentineTargets(LAW);
  assert.deepEqual(
    targets.map((t) => [t.relation, t.citation, t.kind, t.number, t.year, t.partial]),
    [
      ["updates", "Ley N° 24.196", "ley", "24196", null, true],
      ["repeals", "Decreto N° 456/1997", "decreto", "456", "1997", true],
    ],
  );
  assert.match(targets[0]!.quote, /^Sustitúyese el artículo 22 de la Ley N° 24\.196/);
  assert.deepEqual(
    argentineTargets("ARTÍCULO 1°.- Derógase la Resolución Conjunta N° 3/26.").map((t) => [t.relation, t.citation, t.partial]),
    [["repeals", "Resolución Conjunta N° 3/2026", false]],
  );
  assert.deepEqual(citationKey("Ley 24196"), citationKey("LEY N° 24.196"));
  assert.deepEqual(citationKey("DECRETO N° 719/26"), { kind: "decreto", number: "719", year: "2026" });
  assert.notDeepEqual(citationKey("Decreto 719/2025"), citationKey("Decreto 719/2026"));
  assert.equal(citationLabel({ kind: "ley", number: "27801", year: null }), "Ley N° 27.801");
  assert.deepEqual(
    [spanishNumber("treinta y uno"), spanishNumber("veintiséis"), spanishYear("mil novecientos noventa y siete"), spanishYear("dos mil")],
    [31, 26, 1997, 2000],
  );
});

test("the gazette edition date: the source's parsed date, else the date in the national gazette item address", () => {
  assert.equal(
    argentinePublicationDate({ publicationDate: null, officialUrl: "https://www.boletinoficial.gob.ar/detalleAviso/primera/348786/20261104" }),
    "2026-11-04",
  );
  assert.equal(argentinePublicationDate({ publicationDate: null, officialUrl: "https://boletinoficialsalta.gob.ar/instrumento.php?abc=" }), null);
});

const basicFixture = Policy.parse(JSON.parse(readFileSync("tests/fixtures/policy-public/basic-facts.json", "utf8")));
test("basic facts of a recognised Argentine law: stage published, procedure dates with their basis, computed force never ‘occurred’", () => {
  const basic = Policy.parse({
    ...basicFixture,
    jurisdictions: [{ code: "AR", label: "阿根廷", kind: "country" }],
    original_title: "Ley 27.801 RÉGIMEN DE INVERSIONES MINERAS",
  });
  const gate = classifyInstrument({ title: basic.original_title, number: null, issuer: null, excerpt: LAW, language: "es" });
  const lifecycle = argentineLifecycle({ text: LAW, publicationDate: "2026-11-04" });
  const projected = withInstrumentFacts(basic, { gate, lifecycle, relationships: [], evidence: [], today: "2026-11-07" });
  assert.equal(projected.nature.code, "law");
  assert.deepEqual(projected.legal_brief, { stage: "published", in_force: "unknown", repeal: "unknown" });
  assert.equal(projected.legal_state.legislative_stage.value, "published");
  assert.match(projected.legal_state.legislative_stage.basis!, /程序从公报原文抽取/);
  const byKind = Object.fromEntries(projected.dates.map((d) => [d.event_kind, d]));
  assert.equal(byKind.adoption?.local_date, "2026-10-28");
  assert.equal(byKind.promulgation?.local_date, "2026-11-03");
  assert.equal(byKind.entry_into_force?.local_date, "2026-11-13");
  assert.equal(byKind.entry_into_force?.occurrence, "planned");
  assert.match(byKind.entry_into_force!.basis, /推算/);
  assert.equal(projected.legal_state.enforcement.arrangements[0]!.occurrence, "conditional");
  // The reader's path for a law: 国会通过 → 行政颁布 → 公报公布 → 施行 (computed).
  const stages = argentineStages(projected)!;
  assert.deepEqual(
    stages.map((s) => [s.label, s.state]),
    [
      ["国会通过（Sancionada）", "occurred"],
      ["行政颁布（Promulgada）", "occurred"],
      ["公报公布", "occurred"],
      ["施行", "computed"],
    ],
  );
  // A stated date already reached is in force; a decree goes 签发 → 公报公布 → 施行.
  const resolution = Policy.parse({ ...basic, original_title: "SECRETARÍA DE MINERÍA Resolución 45/2026" });
  const text =
    "Ciudad de Buenos Aires, 03/11/2026 VISTO ... EL SECRETARIO DE MINERÍA RESUELVE: ARTÍCULO 1°.- Apruébase. ARTÍCULO 2°.- La presente entrará en vigencia a partir de su publicación.";
  const decree = withInstrumentFacts(resolution, {
    gate: classifyInstrument({ title: resolution.original_title, number: null, issuer: null, excerpt: text, language: "es" }),
    lifecycle: argentineLifecycle({ text, publicationDate: "2026-11-04" }),
    relationships: [],
    evidence: [],
    today: "2026-11-07",
  });
  assert.equal(decree.legal_brief.in_force, "yes");
  assert.deepEqual(
    argentineStages(decree)!.map((s) => [s.label, s.state, s.date?.local_date ?? null]),
    [
      ["签发", "occurred", "2026-11-03"],
      ["公报公布", "occurred", "2026-11-04"],
      ["施行", "occurred", "2026-11-04"],
    ],
  );
  // Amendments the record knows follow, and a repeal is the terminal stage.
  const repealed = Policy.parse({
    ...decree,
    legal_brief: { ...decree.legal_brief, repeal: "repealed" },
    legal_state: { ...decree.legal_state, repeal: { value: "repealed", basis: "合成", evidence_ids: [] } },
    versions: decree.versions.map((v) => ({ ...v, legal_brief: { ...decree.legal_brief, repeal: "repealed" } })),
  });
  const last = argentineStages(repealed)!.at(-1)!;
  assert.deepEqual([last.label, last.terminal], ["已废止", true]);
  // An instrument outside Argentina keeps the generic line.
  assert.equal(argentineStages({ ...decree, jurisdictions: [{ code: "CN", label: "中国", kind: "country" }] }), null);
});
