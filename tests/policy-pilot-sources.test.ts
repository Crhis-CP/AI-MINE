// Restart pilot sources (法规线重启设计 §5): the registered list and detail configurations against minimal real official
// pages saved on 2026-11-05 (tests/fixtures/policy/pilot; scripts, styles and inline styling removed). Offline: no
// database, network or model. Official legal texts are public; the fixtures keep only what the selectors need.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";
import { ALL_POLICY_SOURCES, POLICY_PILOT, POLICY_PILOT_ADDITIONS, POLICY_SOURCES, type PolicySource } from "@amp/industry/policy-sources";
import { POLICY_JURISDICTIONS } from "@amp/industry/jurisdictions";
import { assertSupportedConfig, normalizeSourceLanguage } from "@amp/backend/sources/config-keys";
import { allowed, fromHtml } from "@amp/backend/sources/web-list";
import { jsonListDocument } from "@amp/backend/sources/json-list";
import { PolicyAutomationProfile } from "../modules/policy/backend/domain/automation-profile.ts";
import { validateProfile } from "../modules/policy/backend/domain/extraction.ts";
import { PolicyIdentityMismatch, readPolicyIdentityFields } from "../modules/policy/backend/domain/identity-fields.ts";
import { splitProvisions } from "../modules/policy/backend/domain/provisions.ts";
const { load } = createRequire(new URL("../packages/backend/package.json", import.meta.url))("cheerio") as typeof import("cheerio");

const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, "fixtures/policy/pilot", name), "utf8");
const entry = (id: string) => ALL_POLICY_SOURCES.find((s) => s.id === id)!;
const row = (s: PolicySource) =>
  ({
    id: `policy-${s.id.toLowerCase()}`,
    name: s.name.zh,
    kind: s.collect!.kind,
    config: s.collect!.config,
    lane: "policy",
    tier: "T1",
    participation_mode: "editorial",
    first_party: true,
    interval_minutes: 360,
    enabled: false,
    cursor: null,
    fail_count: 0,
  }) as Parameters<typeof fromHtml>[2];
const profileOf = (s: PolicySource) => PolicyAutomationProfile.parse(s.collect!.config.policyProfile);
const inScope = (s: PolicySource, urls: string[]) => {
  const pattern = new RegExp(profileOf(s).officialRole.singleObjectPattern, "u");
  return urls.filter((url) => allowed(url, row(s)) && pattern.test(url));
};
const bodyText = (html: string, selector: string) => {
  const $ = load(html);
  return $(selector)
    .find("p, h1, h2, h3, h4, h5, h6, li, div:not(:has(p, div))")
    .toArray()
    .map((node) => $(node).text().replace(/\s+/gu, " ").trim())
    .filter(Boolean);
};

test("pilot conclusions cover every pilot source, name real entries and record robots and license", () => {
  assert.equal(POLICY_SOURCES.length, 156, "the Owner's list is unchanged; additions live beside it");
  for (const addition of POLICY_PILOT_ADDITIONS) {
    assert.match(addition.id, /^[A-Z]{2}-P\d{2}$/);
    assert.ok(!POLICY_SOURCES.some((s) => s.id === addition.id));
    assert.ok(POLICY_JURISDICTIONS.some((j) => j.id === addition.jurisdiction));
    assert.ok(addition.hold, `${addition.id}: waits for the production dry run`);
  }
  const ids = POLICY_PILOT.map((p) => p.sourceId).filter(Boolean);
  for (const id of ["CN-001", "CN-002", "CN-003", "CN-004", "CN-P01", "AR-001", "AR-005", "AR-007", "AR-008", "AR-P01"]) assert.ok(ids.includes(id), id);
  for (const group of ["cn_national", "cn_mining_authority", "ar_national", "ar_province", "standards"])
    assert.ok(
      POLICY_PILOT.some((p) => p.group === group),
      group,
    );
  for (const p of POLICY_PILOT) {
    if (p.sourceId) assert.ok(entry(p.sourceId), `${p.sourceId} exists`);
    assert.match(p.robots.url, /^https:\/\/[^/]+\/robots\.txt$/);
    assert.ok(p.license.basis && p.serverVerify, p.publisher);
    if (p.group === "standards") assert.ok(["metadata_only"].includes(p.license.archive), `${p.publisher}: copyrighted standards keep metadata only`);
    if (p.robots.result === "challenge" || p.robots.result === "disallowed") assert.equal(p.state, "blocked", p.publisher);
    if (p.state === "working" || p.state === "needs_server_verification")
      if (p.sourceId && entry(p.sourceId).collect) assert.ok(p.serverVerify.includes(`--source ${p.sourceId}`), p.publisher);
  }
});

test("configured pilot entries carry a valid listing config and an acquisition profile", () => {
  for (const id of ["CN-002", "CN-004", "CN-P01", "AR-001", "AR-007", "AR-008"]) {
    const s = entry(id);
    assert.ok(s.collect, id);
    assert.doesNotThrow(() => assertSupportedConfig(s.collect!.kind, s.collect!.config), id);
    assert.ok(normalizeSourceLanguage(s.collect.config.language), id);
    const profile = profileOf(s);
    validateProfile(profile.extraction);
    assert.equal(s.entry, s.collect.config.url, `${id}: entry equals the checked config`);
  }
});

test("field patterns need one capturing group and a selector", () => {
  const base = profileOf(entry("CN-004"));
  assert.throws(() => PolicyAutomationProfile.parse({ ...base, fieldPatterns: { number: "部令第\\d+号" } }), /one capturing group/);
  assert.throws(() => PolicyAutomationProfile.parse({ ...base, fieldPatterns: { version: "(x)" } }), /version selector/);
  assert.throws(() => PolicyAutomationProfile.parse({ ...base, fieldPatterns: { title: "((x)" } }), /one capturing group/);
});

test("CN-002 reads State Council documents and administrative regulations, not the central-party layout", () => {
  const s = entry("CN-002");
  const listing = jsonListDocument(fixture("cn-gov-zuixinzhengce.json"), row(s), "2026-11-05T20:21:00Z").candidates;
  assert.equal(listing.length, 14);
  const urls = inScope(
    s,
    listing.map((c) => c.url),
  );
  assert.equal(urls.length, 10);
  assert.ok(urls.includes("https://www.gov.cn/zhengce/content/202611/content_7085098.htm"));
  assert.ok(!urls.includes("https://www.gov.cn/zhengce/202611/content_7084690.htm"));
  assert.equal(listing.find((c) => c.url.endsWith("content_7084279.htm"))?.sourceDateObservation?.raw, "2026-10-26");

  const profile = profileOf(s);
  const regulation = readPolicyIdentityFields(load(fixture("cn-gov-content-7084279.html")), profile);
  assert.equal(regulation.title.raw, "事业单位登记管理条例");
  assert.equal(regulation.number?.raw, "国令第849号");
  assert.equal(regulation.marker.raw, "000014349/2026-00077");
  const decision = readPolicyIdentityFields(load(fixture("cn-gov-content-7085098.html")), profile);
  assert.equal(decision.title.raw, "国务院关于修改和废止部分行政法规的决定");
  assert.equal(decision.number?.raw, "国令第851号");

  const split = splitProvisions(bodyText(fixture("cn-gov-content-7084279.html"), profile.extraction.bodySelector!), { language: "zh-CN" });
  assert.equal(split.numbering, "zh");
  assert.ok(split.provisions.length >= 30, `provisions: ${split.provisions.length}`);
  assert.equal(split.provisions[0]!.label, "第一条");
});

test("content fingerprints ignore volatile page bytes and follow the legal text", () => {
  const profile = profileOf(entry("CN-002"));
  const page = fixture("cn-gov-content-7084279.html");
  assert.match(page, /页面生成时间/);
  const regenerated = page.replace(/页面生成时间 [^"]+/, "页面生成时间 2026-11-12 09:00:00");
  assert.notEqual(regenerated, page);
  const before = readPolicyIdentityFields(load(page), profile).fingerprint;
  assert.ok(before);
  assert.equal(readPolicyIdentityFields(load(regenerated), profile).fingerprint, before);
  const amended = page.replace("制定本条例。", "制定本条例（修订）。");
  assert.notEqual(amended, page);
  assert.notEqual(readPolicyIdentityFields(load(amended), profile).fingerprint, before);
});

test("CN-004 reads 生态环境部令 with the order number from the disclosure panel", () => {
  const s = entry("CN-004");
  const listing = fromHtml(fixture("cn-mee-ling-list.html"), s.collect!.config.url as string, row(s));
  const urls = inScope(
    s,
    listing.map((c) => c.url),
  );
  assert.ok(urls.length >= 15, `items: ${urls.length}`);
  assert.equal(urls.length, listing.length, "every listed item is a 部令 page");
  assert.equal(listing[0]!.title, "新化学物质环境管理登记办法");
  assert.equal(listing[0]!.url, "https://www.mee.gov.cn/xxgk2018/xxgk/xxgk02/202610/t20261027_1184708.html");
  assert.equal(listing[0]!.sourceDateObservation?.raw, "2026-10-26");
  const fields = readPolicyIdentityFields(load(fixture("cn-mee-ling-1184708.html")), profileOf(s));
  assert.equal(fields.title.raw, "新化学物质环境管理登记办法");
  assert.equal(fields.number?.raw, "部令 第40号");
  const split = splitProvisions(bodyText(fixture("cn-mee-ling-1184708.html"), ".content_body_box"), { language: "zh-CN" });
  assert.equal(split.provisions.at(-1)?.label, "第四十八条");
});

test("CN-P01 keys 应急管理部 rules on the original order number and versions them by the latest amendment", () => {
  const s = entry("CN-P01");
  const listing = fromHtml(fixture("cn-mem-gz11-list.html"), s.collect!.config.url as string, row(s));
  assert.equal(listing.length, 15);
  assert.equal(
    inScope(
      s,
      listing.map((c) => c.url),
    ).length,
    15,
  );
  assert.equal(listing[1]!.title, "煤矿企业安全生产许可证实施办法");
  assert.equal(listing[1]!.url, "https://www.mem.gov.cn/gk/zfxxgkpt/fdzdgknr/gz11/202609/t20260904_715240.shtml");
  assert.equal(listing[1]!.sourceDateObservation?.raw, "20260904");
  const profile = profileOf(s);
  const fields = readPolicyIdentityFields(load(fixture("cn-mem-gz11-715240.html")), profile);
  assert.equal(fields.title.raw, "煤矿企业安全生产许可证实施办法");
  assert.equal(fields.number?.raw, "应急管理部令第22号");
  assert.equal(fields.version?.raw, "2026年8月31日应急管理部令第22号公布");
  // A revised rule keeps its first order number as identity and takes the latest act as its version.
  const revised = load(
    '<html><head><title>社会消防技术服务管理规定--中华人民共和国应急管理部</title></head><body><div class="zhenwen scy_xqlogo"><span>应急管理部规章</span></div><div class="zhenwen_neir"><div class="TRS_Editor"><p>社会消防技术服务管理规定</p><p>（2021年9月13日应急管理部令第7号公布，2026年9月18日应急管理部令第23号修订）</p><p>第一条 为了规范社会消防技术服务活动，制定本规定。</p></div></div></body></html>',
  );
  const revision = readPolicyIdentityFields(revised, profile);
  assert.equal(revision.number?.raw, "应急管理部令第7号");
  assert.equal(revision.version?.raw, "2026年9月18日应急管理部令第23号修订");
  const split = splitProvisions(bodyText(fixture("cn-mem-gz11-715240.html"), "div.zhenwen_neir"), { language: "zh-CN" });
  assert.ok(split.provisions.length >= 20, `provisions: ${split.provisions.length}`);
});

test("AR-007 Salta keeps dated normative items and reads the instrument number", () => {
  const s = entry("AR-007");
  const listing = fromHtml(fixture("ar-salta-navegacion.html"), s.collect!.config.url as string, row(s));
  assert.equal(listing.length, 28, "13 decretos and 15 decisiones administrativas");
  assert.ok(listing.every((c) => / DEL \d{2}\/\d{2}\/\d{4}/.test(c.title)));
  assert.ok(!listing.some((c) => /AGUAS DEL NORTE/.test(c.title)), "procurement notices are not instruments");
  assert.equal(
    inScope(
      s,
      listing.map((c) => c.url),
    ).length,
    28,
  );
  assert.equal(listing[0]!.sourceDateObservation?.raw, "26/10/2026");
  const fields = readPolicyIdentityFields(load(fixture("ar-salta-decreto-719-26.html")), profileOf(s));
  assert.equal(fields.number?.raw, "DECRETO N° 719/26");
  assert.match(fields.title.raw, /^RECHAZA RECURSO DE RECONSIDERACIÓN/);
  assert.match(fields.marker.raw, /Boletín N° 22303/);
  const notice = load(fixture("ar-salta-decreto-719-26.html").replace("DECRETO N° 719/26", "LICITACION PUBLICA N° 100141966"));
  assert.throws(() => readPolicyIdentityFields(notice, profileOf(s)), PolicyIdentityMismatch);
});

test("AR-008 Jujuy reads the act number from the post, not the issue heading", () => {
  const s = entry("AR-008");
  const listing = jsonListDocument(fixture("ar-jujuy-posts.json"), row(s), "2026-11-05T20:30:00Z").candidates;
  assert.equal(listing.length, 6);
  assert.equal(
    inScope(
      s,
      listing.map((c) => c.url),
    ).length,
    6,
  );
  const fields = readPolicyIdentityFields(load(fixture("ar-jujuy-437475.html")), profileOf(s));
  assert.equal(fields.number?.raw, "RESOLUCION Nº 150-E-JUJ-SMH#MM/2026");
  assert.equal(fields.marker.raw, "Resoluciones");
  const split = splitProvisions(bodyText(fixture("ar-jujuy-437475.html"), ".entry-content"), { language: "es" });
  assert.equal(split.numbering, "es");
  assert.equal(split.provisions.length, 3);
  assert.match(split.provisions[0]!.label, /^ART[ÍI]CULO 1/i);
});

test("AR-P01 SAIJ lists mining legislation from the official JSON search, province in the title, no rulings (TASK-0603)", () => {
  const s = entry("AR-P01");
  assert.equal(s.publisher_kind, "official_law_database");
  assert.equal(s.collect!.kind, "json_list");
  assert.doesNotThrow(() => assertSupportedConfig(s.collect!.kind, s.collect!.config));
  assert.equal(s.entry, s.collect!.config.url, "entry equals the checked config");
  const query = new URL(s.entry).searchParams;
  assert.equal(query.get("f"), "Total|Tipo de Documento/Legislación|Fecha|Jurisdicción", "only the legislation facet");
  assert.equal(query.get("s"), "fecha-rango|DESC");
  assert.doesNotMatch(s.entry, /jurisprudencia|doctrina|sumario|fallo/i);
  assert.equal(s.collect!.config.policyProfile, undefined, "the detail page loads its text by script; acquisition waits for a JSON reader");
  assert.match(s.hold!, /view-document/);
  const pilot = POLICY_PILOT.find((p) => p.sourceId === "AR-P01")!;
  assert.equal(pilot.robots.result, "allowed");
  assert.equal(pilot.state, "needs_server_verification");

  const listing = jsonListDocument(fixture("ar-saij-busqueda.json"), row(s), "2026-11-10T02:45:00Z").candidates;
  assert.deepEqual(
    listing.map((c) => [c.title, c.sourceDateObservation?.raw]),
    [
      [
        "Resolución 5921 ARCA — Procedimiento. Sistema Integral de Retenciones Electrónicas (SIRE). Incorporación de regímenes de retención y/o percepción del IVA. Resoluciones Generales Nros. 3.726 y 4.523. Norma modificatoria y complementaria",
        "2026-11-02",
      ],
      ["Decreto 1304 (Nacional) — Renuncia al cargo de Secretario de Coordinación de Energía y Minería", "2026-10-29"],
      ["Ley 9739 (Mendoza) — Declaración de Impacto Ambiental para el Proyecto denominado Cobre San Romeleo", "2026-10-21"],
      [
        "Decreto 2162 (Mendoza) — Fideicomiso para el desarrollo de Malargue y del Polo logístico y de servicios Pata Mora y fomento a la actividad minera",
        "2026-10-07",
      ],
      [
        "Ley 8561 (Salta) — Protección fitosanitaria de la banana Musa spp. resguardando el estatus sanitario frente al riesgo de introducción y dispersión de plagas cuarentenarias ausentes en el territorio de la provincia",
        "2026-10-06",
      ],
      [
        "Resolución 5909 ARCA — Ventanilla Única de Comercio Exterior Argentino (VUCEA). Régimen de Inversiones para la Actividad Minera. Declaración jurada de destino minero. Decreto N° 2.686/93 y sus modificatorios. Su incorporación",
        "2026-10-01",
      ],
      ["Decreto 482 (Nacional) — Modificación de la Reglamentación del Régimen de Inversiones para la Actividad Minera", "2026-06-22"],
    ],
  );
  assert.equal(
    listing[2]!.url,
    "https://www.saij.gob.ar/9739-local-mendoza-declaracion-impacto-ambiental-para-proyecto-denominado-cobre-san-romeleo-lpm0009739-2026-10-21/123456789-0abc-defg-937-9000mvorpyel",
  );
  assert.equal((listing[2]!.raw as { externalId: unknown }).externalId, "123456789-0abc-defg-937-9000mvorpyel");
  for (const c of listing) {
    assert.ok(allowed(c.url, row(s)), c.url);
    assert.match(c.url, /^https:\/\/www\.saij\.gob\.ar\/[a-z0-9-]+\/[a-z0-9-]+$/, "detail pages carry the uuid segment");
  }
});

test("a blank number cell falls back to URL identity; a missing title stays an error", () => {
  const profile = profileOf(entry("CN-002"));
  const page = fixture("cn-gov-content-7084279.html");
  const blank = load(page.replace("国令第849号", ""));
  assert.equal(readPolicyIdentityFields(blank, profile).number, null);
  const untitled = load(page.replace(/<td[^>]*><b>标　　题：<\/b><\/td>/, "<td></td>"));
  assert.throws(() => readPolicyIdentityFields(untitled, profile), /missing or ambiguous/);
});
