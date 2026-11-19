// The entity library's spelling keys and its linker (packages/backend/src/pipeline/entities): which companies an
// article names, without a model. The sentences that a plain regex gets wrong (Riotinto, Vale lembrar, Vale of
// Belvoir, southern Copperbelt, Former Barrick executive) are here because the lexicon's own regexes match them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIndex, type EntityIndex, linkText } from "../packages/backend/src/pipeline/entities/link.ts";
import type { EntityRow, StatementRow } from "../packages/backend/src/pipeline/entities/model.ts";
import { aliasKey, lookupKey } from "../packages/backend/src/pipeline/entities/normalize.ts";
import { seedRows } from "../packages/backend/src/pipeline/entities/seed.ts";

const seed = seedRows();
const index = buildIndex(seed.entities, seed.statements);

type LinkInput = Parameters<typeof linkText>[1];
const link = (title: string, more: Partial<LinkInput> = {}) => linkText(index, { title, body: "", language: null, ...more });
const roles = (links: ReturnType<typeof linkText>) => Object.fromEntries(links.map((l) => [`${l.entityId}/${l.method}`, l.role]));

const row = (id: string, nameZh: string | null, nameOriginal: string, extra: Partial<EntityRow> = {}): EntityRow => ({
  id,
  kind: "company",
  nameZh,
  nameOriginal,
  showOriginal: true,
  origin: "admin",
  status: "active",
  mergedInto: null,
  ...extra,
});
const alias = (entityId: string, value: string, extra: Partial<StatementRow> = {}): StatementRow => ({
  entityId,
  property: "alias",
  value,
  scope: "text",
  lang: null,
  caseSensitive: false,
  origin: "admin",
  status: "active",
  ...extra,
});
const ids = (ix: EntityIndex, title: string) => linkText(ix, { title, body: "", language: null }).map((l) => l.entityId);

test("spellings that differ only in hyphens, accents, width or legal form share a key", () => {
  assert.equal(aliasKey("Freeport-McMoRan"), aliasKey("Freeport McMoRan"));
  assert.equal(aliasKey("Río Tinto"), aliasKey("Rio Tinto"));
  assert.equal(aliasKey("自由港-麦克莫兰"), aliasKey("自由港麦克莫兰"));
  assert.equal(aliasKey("西班耶·斯蒂尔沃特"), aliasKey("西班耶-斯蒂尔沃特"));
  assert.equal(aliasKey("ＢＨＰ"), "bhp");
  assert.equal(lookupKey("BHP Group Limited"), "bhp");
  assert.equal(lookupKey("Vale S.A."), "vale");
  assert.equal(lookupKey("Zijin Mining Group Co., Ltd."), "zijin mining");
  assert.equal(lookupKey("智利国家铜业公司"), "智利国家铜业");
  assert.equal(lookupKey("Teck Resources"), "teck resources", "descriptive words are never stripped");
  assert.equal(lookupKey("公司"), "公司", "a legal form alone is not emptied");
});

test("place names and ordinary words that a regex takes for a company are not linked", () => {
  assert.deepEqual(link("Atalaya Mining reports third-quarter results at Proyecto Riotinto in Huelva, Spain."), []);
  assert.deepEqual(link("Vale lembrar que o projeto ainda depende de licenciamento ambiental.", { language: "pt" }), []);
  assert.deepEqual(link("Junior explorer completes drilling in the Vale of Belvoir"), []);
  assert.deepEqual(link("Exploration drilling resumed in the southern Copperbelt of Zambia."), []);
  assert.deepEqual(link("Antofagasta region approves desalination plant"), []);
  assert.deepEqual(link("Kinross council rejects quarry plan"), []);
  assert.deepEqual(link("Rio, Tinto and Odiel rivers polluted"), [], "words of one name are not split by a comma");
  assert.deepEqual(link("the bhp rating of the engine"), [], "an upper-case abbreviation only counts in upper case");
  assert.deepEqual(link("Mining towns in the gold fields of Ghana"), []);
});

test("a spelling that is also a place counts once the article names the company another way", () => {
  assert.deepEqual(roles(link("Vale cuts iron ore guidance (NYSE: VALE)")), { "vale/text": "subject" });
  assert.deepEqual(roles(link("Vale cuts iron ore guidance", { modelSubjects: ["vale"] })), { "vale/text": "subject" });
  assert.deepEqual(roles(link("Vale cuts iron ore guidance", { url: "https://www.vale.com/en/news/1" })), {
    "vale/text": "subject",
    "vale/publisher_domain": "publisher",
  });
  assert.deepEqual(roles(link("Antofagasta Minerals says Antofagasta output rose")), { "antofagasta/text": "subject" });
  const [vale] = link("Vale S.A. said Vale will cut output");
  assert.equal(vale?.hits, 2, "an anchored spelling counts once anchored");
  assert.deepEqual(link("Teck"), []);
  assert.deepEqual(roles(link("Teck Resources sells coal unit; Teck shares rise")), { "teck/text": "subject" });
});

test("the longest registered name wins over its prefix", () => {
  const ix = buildIndex(
    [row("anglo-american", "英美资源", "Anglo American"), row("anglo-american-platinum", null, "Anglo American Platinum")],
    [alias("anglo-american", "Anglo American"), alias("anglo-american-platinum", "Anglo American Platinum")],
  );
  assert.deepEqual(ids(ix, "Anglo American Platinum raises dividend"), ["anglo-american-platinum"]);
  assert.deepEqual(ids(ix, "Anglo American raises dividend"), ["anglo-american"]);
});

test("a Chinese name counts only where the identity lexicon also recognises it", () => {
  assert.deepEqual(link("政府大力拓展铜矿勘探"), []);
  assert.deepEqual(link("长江铜价走高"), []);
  assert.deepEqual(link("今天齐聚北京"), [], "天齐 alone is not guarded and needs an anchor");
  assert.deepEqual(link("金田村发现金矿线索"), [], "a two-character name needs an anchor");
  assert.deepEqual(roles(link("力拓集团公布产量")), { "rio-tinto/text": "subject" });
  assert.deepEqual(roles(link("江铜集团扩产")), { "jiangxi-copper/text": "subject" });
  assert.deepEqual(roles(link("科德尔科下调指引")), { "codelco/text": "subject" });
  assert.deepEqual(roles(link("金田（Gold Fields）上调指引")), { "gold-fields/text": "subject" });
});

test("a company named in passing is a mention, in each language with a list", () => {
  assert.deepEqual(roles(link("Former Barrick executive joins junior explorer board")), { "barrick/text": "mention" });
  assert.deepEqual(roles(link("Glencore-backed explorer raises funds")), { "glencore/text": "mention" });
  assert.deepEqual(roles(link("Junior hires a Rio Tinto veteran as chief executive")), { "rio-tinto/text": "mention" });
  assert.deepEqual(roles(link("Startup competes with BHP for copper tenements")), { "bhp/text": "mention" });
  assert.deepEqual(roles(link("前力拓高管加盟初级勘探公司", { language: "zh" })), { "rio-tinto/text": "mention" });
  assert.deepEqual(roles(link("曾任必和必拓财务总监的某人出任董事", { language: "zh" })), { "bhp/text": "mention" });
  assert.deepEqual(roles(link("此前力拓宣布扩产", { language: "zh" })), { "rio-tinto/text": "subject" }, "此前 is not 前 (former)");
  assert.deepEqual(roles(link("Ex ejecutivo de Codelco asume en minera junior", { language: "es" })), { "codelco/text": "mention" });
  assert.deepEqual(roles(link("Ex-diretor da Glencore assume mineradora", { language: "pt" })), { "glencore/text": "mention" });
});

test("with a model answer the subject is what the model named and the text grounds", () => {
  const body = "Barrick and Newmont operate the joint venture. Separately, BHP said its outlook was unchanged.";
  assert.deepEqual(roles(link("Nevada Gold Mines output falls", { body, modelSubjects: ["barrick"] })), {
    "barrick/text": "subject",
    "newmont/text": "mention",
    "bhp/text": "mention",
  });
  assert.deepEqual(roles(link("Nevada Gold Mines output falls", { body })), {
    "barrick/text": "subject",
    "newmont/text": "subject",
    "bhp/text": "mention",
  });
  assert.deepEqual(link("Copper output falls", { modelSubjects: ["glencore"] }), [], "a model subject the text never names is not linked");
});

test("a link records where its first hit is and how many hits there were", () => {
  const body = "Copper prices rose on Monday. Traders cited BHP, and BHP declined to comment.";
  assert.deepEqual(link("Copper rises", { body }), [
    { entityId: "bhp", role: "mention", method: "text", alias: "BHP", segment: "body", position: body.indexOf("BHP"), hits: 2 },
  ]);
});

test("the publisher comes from the domain or the source owner, and only known ids are returned", () => {
  assert.deepEqual(roles(link("Quarterly report", { url: "https://www.riotinto.com/en/news/x" })), { "rio-tinto/publisher_domain": "publisher" });
  assert.deepEqual(roles(link("Quarterly report", { url: "https://notriotinto.com/x" })), {});
  assert.deepEqual(roles(link("Quarterly report", { sourceOwner: "glencore" })), { "glencore/source_owner": "publisher" });
  assert.deepEqual(link("Quarterly report", { sourceOwner: "lundin-mining", url: "not a url" }), []);
});

test("merged entities answer with the winner; retired ones and merge cycles with nothing", () => {
  const ix = buildIndex(
    [
      row("winner", "甲公司", "Alpha Corp"),
      row("loser", "乙公司", "Beta Corp", { mergedInto: "winner" }),
      row("gone", "丙公司", "Gamma Corp", { status: "retired" }),
      row("loop-a", null, "Loop A", { mergedInto: "loop-b" }),
      row("loop-b", null, "Loop B", { mergedInto: "loop-a" }),
    ],
    [alias("winner", "Alpha Corp"), alias("loser", "Beta Corp"), alias("gone", "Gamma Corp"), alias("loop-a", "Loop A"), alias("loop-b", "Loop B")],
  );
  assert.deepEqual(ids(ix, "Beta Corp and Alpha Corp sign deal"), ["winner"]);
  assert.deepEqual(ids(ix, "Gamma Corp and Loop A and Loop B"), []);
  assert.equal(ix.resolve("loser"), "winner");
  assert.deepEqual([...ix.entities.keys()], ["winner"]);
});
