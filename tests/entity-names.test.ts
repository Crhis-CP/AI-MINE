// The entity library's seed and its one-name rendering (packages/backend/src/pipeline/entities). The seed must
// carry every company the code already names, under the same Chinese name; the rendering must give what
// editorial/bilingual-names.ts gives today on glossary names, and fix what it gets wrong.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NAME_GLOSSARY } from "@amp/industry/name-glossary";
import { MAJOR_COMPANIES } from "@amp/industry/selection";
import { ENTITIES, IDENTITY_LEXICON } from "@amp/industry/taxonomy";
import { bilingualNames } from "../packages/backend/src/editorial/bilingual-names.ts";
import { buildIndex, guardedByLexicon } from "../packages/backend/src/pipeline/entities/link.ts";
import type { EntityRow, StatementRow } from "../packages/backend/src/pipeline/entities/model.ts";
import { companyName, renderNames } from "../packages/backend/src/pipeline/entities/names.ts";
import { aliasKey, hasHan, lookupKey } from "../packages/backend/src/pipeline/entities/normalize.ts";
import { seedRows } from "../packages/backend/src/pipeline/entities/seed.ts";
import { EXTRA_ALIASES } from "../packages/backend/src/pipeline/entities/seed-data.ts";

const seed = seedRows();
const index = buildIndex(seed.entities, seed.statements);
const byName = (zh: string) => seed.entities.find((e) => e.nameZh === zh);
/** The alias keys of an entity: spellings with one key are one stored row (entities.statements is unique on it). */
const aliasesOf = (id: string) => seed.statements.filter((s) => s.entityId === id && s.property === "alias").map((s) => aliasKey(s.value));
const render = (text: string, linked?: string[]) => renderNames(index, text, linked ? { linked: new Set(linked) } : undefined);

test("the seed holds every company the code names, under the same Chinese name", () => {
  for (const [id, { name, aliases }] of Object.entries(ENTITIES)) {
    assert.equal(seed.entities.find((e) => e.id === id)?.nameZh, name, id);
    for (const alias of aliases) assert.ok(aliasesOf(id).includes(aliasKey(alias)), `${id}: ${alias}`);
  }
  for (const { zh, en, aliases } of NAME_GLOSSARY) {
    const entity = byName(zh);
    assert.ok(entity, zh);
    assert.equal(entity.nameOriginal, en, zh);
    for (const spelling of [en, ...(aliases ?? [])]) assert.ok(aliasesOf(entity.id).includes(aliasKey(spelling)), `${zh}: ${spelling}`);
  }
  for (const entry of MAJOR_COMPANIES) assert.ok(byName(entry.split(" ")[0]!), entry);
  assert.ok(byName("铜陵有色"), "the prompt's name list adds 铜陵有色");
  assert.equal(seed.entities.length, 38);
  for (const e of seed.entities) assert.match(e.id, /^[a-z0-9][a-z0-9-]{1,62}$/, "the id fits entities.entities");
});

test("Chinese companies are written without a bracketed original; foreign ones with it", () => {
  const prompt = readFileSync(new URL("../industry/prompts/rules-domain-names.md", import.meta.url), "utf8");
  const chinese = /中国企业用其官方中文名：(.+)/.exec(prompt)![1]!.trim().split("、");
  for (const name of chinese) assert.equal(byName(name)?.showOriginal, false, name);
  for (const { zh } of NAME_GLOSSARY) assert.equal(byName(zh)?.showOriginal, true, zh);
});

test("seed rows are unique per entity, property and key, and no spelling stands for two companies", () => {
  const keys = seed.statements.map((s) => `${s.entityId} ${s.property} ${aliasKey(s.value)}`);
  assert.equal(new Set(keys).size, keys.length);
  for (const s of seed.statements.filter((s) => s.property === "alias")) {
    assert.equal(index.lookup.get(lookupKey(s.value))?.size, 1, s.value);
    assert.equal(companyName(index, s.value), seed.entities.find((e) => e.id === s.entityId)!.nameZh, s.value);
  }
});

test("each added Chinese variant of a lexicon company is one the identity lexicon accepts", () => {
  const lexicon = new Set(IDENTITY_LEXICON.map((entry) => entry.id));
  for (const [id, aliases] of Object.entries(EXTRA_ALIASES)) {
    for (const alias of aliases) {
      const value = typeof alias === "string" ? alias : alias.value;
      if (hasHan(value) && lexicon.has(id)) assert.ok(guardedByLexicon(id, value), `${id}: ${value}`);
    }
  }
});

test("every spelling of a company gives its one Chinese name; unknown or ambiguous spellings give none", () => {
  for (const spelling of ["Freeport-McMoRan", "Freeport McMoRan", "Freeport", "FCX", "自由港迈克墨伦", "Freeport-McMoRan Inc."]) {
    assert.equal(companyName(index, spelling), "自由港麦克莫兰", spelling);
  }
  assert.equal(companyName(index, "Teck"), "泰克资源");
  assert.equal(companyName(index, "科德尔科"), "智利国家铜业公司");
  assert.equal(companyName(index, "Hudbay Minerals"), null);
  const twins = buildIndex([entity("a", "甲矿业", "Alpha"), entity("b", "乙矿业", "Beta")], [alias("a", "Delta Mining"), alias("b", "Delta Mining")]);
  assert.equal(companyName(twins, "Delta Mining"), null);
});

test("on glossary names the rendering equals today's, except that the true first mention gets the bracket", () => {
  const cases = [
    "BHP下调铜产量指引，BHP称智利项目推迟",
    "Rio Tinto与Glencore洽谈合并",
    "Teck Resources出售煤炭业务",
    "必和必拓公布季度产量，BHP股价上涨",
    "必和必拓（BHP）公布季度产量",
    "必和必拓(BHP Group)公布季度产量",
    "Hudbay Minerals获批秘鲁扩建",
    "政府大力拓展铜矿勘探",
    "金田村发现金矿线索",
  ];
  for (const text of cases) assert.equal(render(text).text, bilingualNames(text), text);
  for (const { zh, en, aliases } of NAME_GLOSSARY) {
    const id = byName(zh)!.id;
    for (const spelling of [en, ...(aliases ?? [])]) {
      for (const text of [`${spelling}宣布扩产，${spelling}股价上涨`, `${zh}（${spelling}）宣布扩产`, `据悉 ${spelling} 与当地政府签约`]) {
        assert.equal(render(text, [id]).text, bilingualNames(text), text);
      }
    }
  }
  // Today a two-character Chinese name written first is skipped and the bracket lands on the later English mention.
  assert.equal(render("金田宣布扩产，Gold Fields股价上涨").text, "金田（Gold Fields）宣布扩产，金田股价上涨");
  assert.equal(bilingualNames("金田宣布扩产，Gold Fields股价上涨"), "金田宣布扩产，金田（Gold Fields）股价上涨");
});

test("variants become the one name, and the house form is left alone", () => {
  assert.equal(render("科德尔科下调指引，智利国营铜业公司称推迟投产").text, "智利国家铜业公司（Codelco）下调指引，智利国家铜业公司称推迟投产");
  assert.equal(render("科德尔科公司宣布裁员").text, "智利国家铜业公司（Codelco）宣布裁员", "no doubled 公司");
  assert.equal(render("雅保（Albemarle）与雅宝").text, "雅宝（Albemarle）与雅宝");
  assert.equal(render("Zijin Mining收购CMOC股份").text, "紫金矿业收购洛阳钼业股份", "Chinese companies take no bracket");
  assert.equal(render("自由港麦克莫兰（Freeport-McMoRan）（NYSE: FCX）公布季度业绩").text, "自由港麦克莫兰（Freeport-McMoRan）（NYSE: FCX）公布季度业绩");
  const result = render("科德尔科下调指引");
  assert.deepEqual(result.changes, [{ entityId: "codelco", from: "科德尔科", to: "智利国家铜业公司（Codelco）" }]);
});

test("rendering twice changes nothing more", () => {
  for (const text of [
    "科德尔科下调指引，智利国营铜业公司称推迟投产",
    "自由港迈克墨伦旗下 Grasberg 恢复生产，Freeport-McMoRan 股价上涨",
    "Rio Tinto 批准扩建 Rincon 锂项目，Rio Tinto 股价上涨",
    "南32（South32）与Teck Resources合资",
    "智利铜业巨头（Codelco）宣布",
  ]) {
    const once = render(text).text;
    assert.equal(render(once).text, once, text);
  }
});

test("places and words that share a spelling are left alone unless the source names the company", () => {
  assert.equal(render("初级勘探公司在 Vale of Belvoir 完成钻探").text, "初级勘探公司在 Vale of Belvoir 完成钻探");
  assert.equal(render("该项目位于智利 Antofagasta 大区").text, "该项目位于智利 Antofagasta 大区");
  assert.equal(render("Vale削减铁矿石指引").text, "Vale削减铁矿石指引");
  assert.equal(render("Vale削减铁矿石指引", ["vale"]).text, "淡水河谷（Vale）削减铁矿石指引");
  assert.equal(render("托克与当地政府签约", ["trafigura"]).text, "托克（Trafigura）与当地政府签约");
});

test("an unknown Chinese name before a bracketed original is reported and kept as written", () => {
  const result = render("智利铜业巨头（Codelco）宣布，Codelco将裁员");
  assert.equal(result.text, "智利铜业巨头（Codelco）宣布，智利国家铜业公司将裁员");
  assert.deepEqual(result.unregistered, [{ entityId: "codelco", variant: "智利铜业巨头" }]);
});

test("a company without a Chinese name stays as written; a merged one takes the winner's name", () => {
  const ix = buildIndex(
    [entity("winner", "甲矿业", "Alpha Mining"), entity("loser", "乙矿业", "Beta Mining", { mergedInto: "winner" }), entity("plain", null, "Gamma Mining")],
    [alias("winner", "Alpha Mining"), alias("loser", "Beta Mining"), alias("loser", "乙矿业"), alias("plain", "Gamma Mining")],
  );
  assert.equal(renderNames(ix, "Gamma Mining与Beta Mining合作，乙矿业称").text, "Gamma Mining与甲矿业（Alpha Mining）合作，甲矿业称");
});

function entity(id: string, nameZh: string | null, nameOriginal: string, extra: Partial<EntityRow> = {}): EntityRow {
  return { id, kind: "company", nameZh, nameOriginal, showOriginal: true, origin: "admin", status: "active", mergedInto: null, ...extra };
}
function alias(entityId: string, value: string): StatementRow {
  return { entityId, property: "alias", value, scope: "text", lang: null, caseSensitive: false, origin: "admin", status: "active" };
}
