// TASK-0576 (Owner 2026-11-07): the policy line lists only legal instruments at their final, officially published stage
// that concern mining. Drafts, bills, consultations and “will publish” notices go to the news lane's 政策监管. The gate is
// deterministic (no model): these synthetic but realistic gazette items pin what it lets through and what it holds.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { classifyInstrument, foldText, operativeIssuer, INSTRUMENT_GATE_RECIPE } from "../modules/policy/backend/domain/instrument-gate.ts";
import { POLICY_INSTRUMENTS } from "@amp/industry/policy-instruments";

const es = (title: string, excerpt = "", issuer: string | null = "阿根廷国家公报局", number: string | null = null) =>
  classifyInstrument({ title, number, issuer, excerpt, language: "es", sourceId: "policy-ar-001" });
const zh = (title: string, number: string | null = null, issuer: string | null = null, excerpt = "") =>
  classifyInstrument({ title, number, issuer, excerpt, language: "zh-CN", sourceId: "policy-cn-002" });

const LEY = `El Senado y Cámara de Diputados de la Nación Argentina reunidos en Congreso, etc. sancionan con fuerza de Ley:
ARTÍCULO 1°.- Sustitúyese el artículo 22 de la Ley N° 24.196 por el siguiente: "Las provincias no podrán percibir regalías mineras superiores al tres por ciento (3%) sobre el valor boca mina".
ARTÍCULO 2°.- Comuníquese al Poder Ejecutivo nacional.
DADA EN LA SALA DE SESIONES DEL CONGRESO ARGENTINO, EN BUENOS AIRES, A LOS VEINTIOCHO DÍAS DEL MES DE OCTUBRE DEL AÑO DOS MIL VEINTISÉIS.`;
const MINING_RESOLUTION = `Ciudad de Buenos Aires, 03/11/2026
VISTO el Expediente N° EX-2026-00000001-APN-SM#MEC, la Ley N° 24.585, y
CONSIDERANDO:
Que resulta necesario actualizar el procedimiento de presentación de los informes de impacto ambiental.
Por ello, EL SECRETARIO DE MINERÍA RESUELVE:
ARTÍCULO 1°.- Apruébase el procedimiento para la presentación de los Informes de Impacto Ambiental que obra como Anexo I.
ARTÍCULO 2°.- La presente resolución entrará en vigencia a partir del día siguiente al de su publicación en el Boletín Oficial.`;
const DESIGNATION = `Ciudad de Buenos Aires, 03/11/2026
VISTO el Expediente N° EX-2026-2, CONSIDERANDO: Que se encuentra vacante el cargo.
Por ello, EL SECRETARIO DE MINERÍA RESUELVE:
ARTÍCULO 1°.- Dase por designado con carácter transitorio, a partir del 1° de octubre de 2026, al licenciado Juan PÉREZ en el cargo de Director de Fiscalización Minera.`;
const TAX = `Ciudad de Buenos Aires, 04/11/2026
VISTO el Expediente N° EX-2026-3, CONSIDERANDO: Que corresponde adecuar el régimen de percepción del impuesto al valor agregado.
Por ello, EL DIRECTOR EJECUTIVO DE LA AGENCIA DE RECAUDACIÓN Y CONTROL ADUANERO RESUELVE:
ARTÍCULO 1°.- Modifícase la Resolución General N° 4.290 en la forma que se indica.`;
const CONCESSION = `Salta, 05 de noviembre de 2026
VISTO el expediente minero N° 22.111, CONSIDERANDO: Que la solicitante cumplió los requisitos del Código de Minería.
Por ello, EL JUEZ DE MINAS RESUELVE:
ARTÍCULO 1°.- Otórgase a la empresa Litio del Norte S.A. la concesión de la mina "Esperanza" en el Departamento Los Andes.`;

test("Argentina: a law on mining royalties, sanctioned and promulgated, is a final mining instrument that amends Ley 24.196", () => {
  const gate = es("Ley 27.801 RÉGIMEN DE INVERSIONES MINERAS. Modificación.", LEY);
  assert.equal(gate.kind, "ley");
  assert.equal(gate.nature, "law");
  assert.equal(gate.final, true);
  assert.equal(gate.mining, true);
  assert.equal(gate.change, "amendment");
  assert.equal(gate.publishable, true);
  assert.equal(gate.recipe, INSTRUMENT_GATE_RECIPE);
});

test("Argentina: a Secretaría de Minería resolution passes by its issuer, read from the gazette title or the operative clause", () => {
  assert.equal(es("MINISTERIO DE ECONOMÍA SECRETARÍA DE MINERÍA Resolución 45/2026 RESOL-2026-45-APN-SM#MEC", MINING_RESOLUTION).publishable, true);
  assert.equal(operativeIssuer(MINING_RESOLUTION), "secretaria de mineria");
  // A provincial gazette names only the instrument; the issuer and the mining words are in the text.
  const salta = classifyInstrument({
    title: "DECRETO N° 719/26",
    number: "DECRETO N° 719/26",
    issuer: "萨尔塔省政府",
    excerpt:
      "Salta, 3 de noviembre de 2026 VISTO ... EL GOBERNADOR DE LA PROVINCIA DECRETA: ARTÍCULO 1°.- Apruébase el reglamento del canon minero provincial.",
    language: "es",
  });
  assert.deepEqual([salta.kind, salta.publishable], ["decreto", true]);
  const jujuy = classifyInstrument({
    title: "RESOLUCION Nº 150-E-JUJ-SMH#MM/2026",
    number: "RESOLUCION Nº 150-E-JUJ-SMH#MM/2026",
    issuer: "胡胡伊省官方公报及印务局",
    excerpt: "VISTO ... EL MINISTRO DE MINERÍA E HIDROCARBUROS RESUELVE: ARTÍCULO 1°.- Establécese el régimen de declaraciones juradas de producción.",
    language: "es",
  });
  assert.deepEqual([jujuy.kind, jujuy.mining, jujuy.publishable], ["resolucion", true, true]);
});

test("Argentina: every recognised instrument kind, the most specific name first", () => {
  const kinds: [string, string][] = [
    ["JEFATURA DE GABINETE DE MINISTROS Decisión Administrativa 12/2026", "decision_administrativa"],
    ["MINISTERIO DE ECONOMÍA Resolución Conjunta 3/2026", "resolucion_conjunta"],
    ["Decreto de Necesidad y Urgencia 70/2026", "dnu"],
    ["DNU 70/2026", "dnu"],
    ["DECRETO-LEY N° 5/2026", "decreto_ley"],
    ["SECRETARÍA DE MINERÍA Disposición 8/2026", "disposicion"],
    ["Decreto 812/2026 DECTO-2026-812-APN-PTE - Ley N° 27.801. Promulgación.", "decreto"],
    ["LEY N° 8432/26", "ley"],
  ];
  for (const [title, kind] of kinds) assert.equal(es(title, "VISTO ... ARTÍCULO 1°.- Apruébase el régimen minero.").kind, kind, title);
});

test("Argentina: bills, consultations and hearings are not final; they belong to the news lane", () => {
  for (const title of [
    "Proyecto de Ley de promoción de la minería de litio",
    "Anteproyecto de Código de Minería",
    "SECRETARÍA DE MINERÍA Consulta pública sobre el régimen de cierre de minas",
    "Convocatoria a Audiencia Pública: proyecto minero San Jorge",
  ]) {
    const gate = es(title);
    assert.equal(gate.final, false, title);
    assert.equal(gate.reason, "not_final", title);
    assert.equal(gate.publishable, false, title);
  }
  // A final resolution whose operative part only convenes a consultation is a consultation notice, not a rule.
  const convening = es(
    "SECRETARÍA DE MINERÍA Resolución 50/2026",
    "VISTO ... EL SECRETARIO DE MINERÍA RESUELVE: ARTÍCULO 1°.- Convócase a consulta pública el proyecto de reglamento de relaves.",
  );
  assert.equal(convening.reason, "not_final");
  // A promulgation decree cites the bill in its VISTO clause; that does not make it a bill.
  const promulgation = es(
    "Decreto 812/2026 - Ley N° 27.801. Promulgación.",
    "Ciudad de Buenos Aires, 03/11/2026 VISTO el Proyecto de Ley registrado bajo el N° 27.801 sobre regalías mineras ... ARTÍCULO 1°.- Promúlgase la Ley N° 27.801.",
  );
  assert.equal(promulgation.publishable, true);
});

test("Argentina: designations, edicts, notices of tenders and individual concessions are not published", () => {
  const designation = es("MINISTERIO DE ECONOMÍA SECRETARÍA DE MINERÍA Resolución 46/2026", DESIGNATION);
  assert.deepEqual([designation.reason, designation.publishable], ["personnel", false]);
  for (const title of [
    "Edicto: Juzgado Nacional en lo Comercial N° 4",
    "Licitación Pública N° 12/2026 obras mineras",
    "MINERA DEL SUR SOCIEDAD ANONIMA Asamblea",
  ])
    assert.equal(es(title).reason, "not_normative", title);
  const concession = classifyInstrument({
    title: "RESOLUCION N° 77/26",
    number: "RESOLUCION N° 77/26",
    issuer: "萨尔塔省政府",
    excerpt: CONCESSION,
    language: "es",
  });
  assert.deepEqual([concession.reason, concession.publishable], ["individual_act", false]);
  // A gazette notice with no instrument name at all is not recognised (an aviso oficial body names a law in passing).
  assert.equal(es("BANCO DE LA NACIÓN ARGENTINA", "AVISO OFICIAL El Banco comunica la tasa según la Ley 21.526.").reason, "not_normative");
  assert.equal(es("BANCO DE LA NACIÓN ARGENTINA", "El Banco comunica la tasa de interés según la Ley 21.526.").reason, "unknown_kind");
});

test("Argentina: a generic tax resolution without mining terms is excluded; one passing mention is not enough", () => {
  const tax = es("AGENCIA DE RECAUDACIÓN Y CONTROL ADUANERO Resolución General 5800/2026", TAX);
  assert.deepEqual([tax.kind, tax.change, tax.mining, tax.reason, tax.publishable], ["resolucion", "amendment", false, "not_mining", false]);
  const once = es(
    "MINISTERIO DE ECONOMÍA Resolución 9/2026",
    "VISTO ... RESUELVE: ARTÍCULO 1°.- Fíjanse los aranceles para los sectores agrícola, minero e industrial.",
  );
  assert.equal(once.reason, "not_mining");
  // Oil and gas fields (YPF) are not mining.
  assert.equal(
    es(
      "SECRETARÍA DE ENERGÍA Resolución 4/2026",
      "VISTO la presentación de Yacimientos Petrolíferos Fiscales S.A. ... RESUELVE: ARTÍCULO 1°.- Apruébase el cuadro tarifario.",
    ).reason,
    "not_mining",
  );
});

test("China: the junk that reached the list, drafts and personnel decisions are held; a decision amending the Mineral Resources Law is kept as an amendment", () => {
  const junk = zh("关于精子生产液质量管理的通知", "国卫办〔2026〕3号", "国家卫生健康委");
  assert.deepEqual([junk.mining, junk.reason, junk.publishable], [false, "not_mining", false]);
  const draft = zh("《矿山安全规程（征求意见稿）》公开征求意见的通知", null, "应急管理部");
  assert.deepEqual([draft.final, draft.reason], [false, "not_final"]);
  for (const title of ["矿产资源法实施条例（草案）", "关于拟修订《矿山地质环境保护规定》的说明", "自然资源部即将发布新版矿业权出让办法"])
    assert.equal(zh(title).reason, "not_final", title);
  const amendment = zh("全国人民代表大会常务委员会关于修改《中华人民共和国矿产资源法》的决定", null, "全国人大常委会");
  assert.deepEqual([amendment.kind, amendment.nature, amendment.change, amendment.publishable], ["zh_amendment_decision", "amendment", "amendment", true]);
  const repeal = zh("国务院关于废止《矿产资源补偿费征收管理规定》的决定", "国令第800号");
  assert.deepEqual([repeal.change, repeal.publishable], ["repeal", true]);
  assert.equal(zh("国务院关于表彰全国矿山安全先进集体的决定").publishable, false);
  assert.equal(zh("关于任免国家矿山安全监察局领导的通知", "国人〔2026〕1号").reason, "personnel");
  assert.equal(zh("关于同意某矿业公司采矿权延续的批复").reason, "not_normative");
  assert.equal(zh("国务院关于加快发展养老服务的决定").reason, "unknown_kind", "other 决定 are not instruments of this line");
});

test("China: laws, regulations, rules, orders and numbered normative notices are recognised; a notice without a 文号 is not", () => {
  assert.equal(zh("中华人民共和国矿产资源法").kind, "zh_law");
  assert.equal(zh("《中华人民共和国矿产资源法》").kind, "zh_law");
  assert.equal(zh("矿业权出让收益征收办法", "财综〔2023〕10号").kind, "zh_regulation");
  assert.equal(zh("煤矿安全规程").kind, "unknown", "a 规程 is a technical code, not one of the listed instruments");
  assert.equal(zh("金属非金属矿山安全规定").kind, "zh_regulation");
  assert.equal(zh("应急管理部令（第7号）").kind, "zh_order");
  assert.equal(zh("自然资源部关于进一步完善矿产资源勘查开采登记管理的通知", "自然资规〔2023〕4号").publishable, true);
  assert.equal(zh("自然资源部关于进一步完善矿产资源勘查开采登记管理的通知").reason, "missing_number");
  assert.equal(zh("矿山救护队标准化定级管理办法").kind, "zh_regulation", "办法 is not a law (法)");
  // A source that registers its document type decides the kind.
  assert.equal(
    classifyInstrument({ title: "尾矿库安全监督管理", number: null, issuer: "应急管理部", excerpt: "", documentType: "部门规章", language: "zh-CN" }).kind,
    "zh_regulation",
  );
  // 自然资源部 is a mining authority (issuer whitelist); 矿泉水 is not mining.
  assert.equal(zh("自然资源部关于印发《自然资源统计调查制度》的通知", "自然资发〔2026〕1号", "自然资源部").mining, true);
  assert.equal(zh("饮用天然矿泉水生产卫生规范的通知", "国卫〔2026〕2号").mining, false);
});

test("English: acts, regulations and final rules pass; proposed rules and bills do not", () => {
  const en = (title: string) => classifyInstrument({ title, number: null, issuer: "Office of the Federal Register", excerpt: "", language: "en" });
  assert.equal(en("Mining Act 2026").publishable, true);
  assert.equal(en("Mine Safety and Health Regulations").publishable, true);
  assert.equal(en("Final Rule: Tailings Storage Facilities").publishable, true);
  assert.equal(en("Proposed Rule: Tailings Storage Facilities").reason, "not_final");
  assert.equal(en("Notice of Proposed Rulemaking on Mineral Leasing").reason, "not_final");
  assert.equal(en("Critical Minerals Bill").reason, "not_final");
  assert.equal(en("Mineral water labelling regulation").mining, false);
});

test("the vocabulary is one data file; every pattern compiles and the gate's answer is stable", () => {
  const raw = JSON.parse(readFileSync("industry/policy-instruments.json", "utf8"));
  assert.equal(raw.version, POLICY_INSTRUMENTS.version);
  const patterns: string[] = [
    ...POLICY_INSTRUMENTS.kinds.flatMap((k) => [k.pattern, ...(k.requires_number ? [k.requires_number] : [])]),
    ...Object.values(POLICY_INSTRUMENTS.not_final).flat(),
    ...Object.values(POLICY_INSTRUMENTS.not_normative).flat(),
    ...Object.values(POLICY_INSTRUMENTS.personnel).flat(),
    ...Object.values(POLICY_INSTRUMENTS.individual_act).flat(),
    ...Object.values(POLICY_INSTRUMENTS.amendment),
    ...Object.values(POLICY_INSTRUMENTS.repeal),
    ...Object.values(POLICY_INSTRUMENTS.mining_terms).flat(),
    ...Object.values(POLICY_INSTRUMENTS.strong_mining_terms).flat(),
    ...Object.values(POLICY_INSTRUMENTS.mining_noise).flat(),
  ] as string[];
  for (const pattern of patterns) assert.doesNotThrow(() => new RegExp(pattern, "u"), pattern);
  // Folded matching: Spanish patterns are written without accents and in lower case.
  for (const kind of POLICY_INSTRUMENTS.kinds.filter((k) => k.language !== "zh")) assert.equal(kind.pattern, foldText(kind.pattern), kind.kind);
  for (const issuer of POLICY_INSTRUMENTS.mining_issuers) assert.equal(issuer, foldText(issuer), issuer);
  const input = { title: "SECRETARÍA DE MINERÍA Resolución 45/2026", number: null, issuer: null, excerpt: MINING_RESOLUTION, language: "es" };
  assert.deepEqual(classifyInstrument(input), classifyInstrument(input));
  // The gate never reads a model or the network: the module imports only the vocabulary.
  const source = readFileSync("modules/policy/backend/domain/instrument-gate.ts", "utf8");
  assert.deepEqual(
    [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]),
    ["@amp/industry/policy-instruments"],
  );
});
