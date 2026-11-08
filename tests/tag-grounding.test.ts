// A company or mineral tag is kept only when the material names it (TASK-0584): the Owner found 《比尔·盖茨私人访问
// 智利 Chuquicamata 铜矿》 under 紫金矿业 although its original never names Zijin.
import assert from "node:assert/strict";
import { test } from "node:test";
import { regroundedProjection } from "../packages/backend/src/publication/publish.ts";
import { groundTags, groundingText, tagGrounded, ungroundedFilterHits } from "../packages/backend/src/publication/tag-grounding.ts";

const gates = groundingText([
  "Bill Gates realizó visita privada a Chuquicamata",
  "El fundador de Microsoft recorrió la mina de cobre de Codelco en Calama, una de las mayores del mundo.",
  null,
  "Reporte Minero",
]);

test("the reported case: Zijin and lithium leave, copper, Codelco, the category and the countries stay", () => {
  assert.deepEqual(groundTags(["会议观点", "铜", "锂", "智利", "赞比亚", "紫金矿业", "智利国家铜业公司", "entity:codelco"], gates, "es"), [
    "会议观点",
    "铜",
    "智利",
    "赞比亚",
    "智利国家铜业公司",
    "entity:codelco",
  ]);
});

test("company aliases in either language count; a name inside another word does not", () => {
  assert.equal(tagGrounded("紫金矿业", "Zijin Mining raised its copper guidance."), true);
  assert.equal(tagGrounded("entity:zijin", "紫金矿业发布三季度报告"), true);
  assert.equal(tagGrounded("必和必拓", "BHP and Lundin agree on Vicuña"), true);
  assert.equal(tagGrounded("必和必拓", "Lundin Mining expands Caserones"), false);
  assert.equal(tagGrounded("力拓", "企业大力拓展海外市场"), false, "力拓 inside 大力拓展 is not Rio Tinto");
});

test("minerals: 金 inside 紫金 is not gold; English names count; lead needs a metal context", () => {
  assert.equal(tagGrounded("金", "紫金矿业发布三季度铜产量"), false);
  assert.equal(tagGrounded("金", "Barrick lifts gold output"), true);
  assert.equal(tagGrounded("铅", "Glencore will lead the consortium"), false);
  assert.equal(tagGrounded("铅", "Lead-zinc concentrate shipments rose"), true);
  assert.equal(tagGrounded("铅", "铅锌矿山复产"), true);
});

test("tags that are not a company or mineral are never removed here", () => {
  assert.deepEqual(groundTags(["政策监管", "秘鲁", "未知标签"], "nothing relevant"), ["政策监管", "秘鲁", "未知标签"]);
});

test("the source name counts as the material's own words (a company's own newsroom)", () => {
  assert.equal(tagGrounded("紫金矿业", groundingText(["三季度经营情况", "公司前三季度矿产铜产量同比增长", "紫金矿业 · 官方动态"])), true);
});

test("a mineral in a language the wordings do not cover is kept; a company is still checked", () => {
  assert.equal(tagGrounded("铜", "Медь подорожала", "ru"), true);
  assert.equal(tagGrounded("紫金矿业", "Медь подорожала", "ru"), false);
  assert.equal(tagGrounded("锂", "Proyecto de litio en Catamarca", "es"), true);
  assert.equal(tagGrounded("锂", "Proyecto de cobre en Catamarca", "es"), false);
});

test("Spanish and Portuguese aluminium are both found (Codex review #380)", () => {
  assert.equal(tagGrounded("铝", "La producción de aluminio creció.", "es"), true);
  assert.equal(tagGrounded("铝", "A produção de alumínio aumentou.", "pt"), true);
});

test("the filter audit finds a company or mineral that only the AI copy names (TASK-0589)", () => {
  // The AI summary in the search text says 紫金矿业 although the Spanish original never does; copper is named (cobre).
  const search = "比尔·盖茨私人访问智利 Chuquicamata 铜矿 紫金矿业 同类项目 Reporte Minero";
  assert.deepEqual(ungroundedFilterHits(search, ["铜"], gates, "es"), ["紫金矿业"]);
  assert.deepEqual(ungroundedFilterHits("Codelco 铜矿", ["铜", "entity:codelco"], gates, "es"), [], "named in the material: nothing to report");
  assert.deepEqual(ungroundedFilterHits("锂 价格", [], "Proyecto de cobre en Catamarca", "es"), ["锂"], "a mineral only the copy names");
  assert.deepEqual(ungroundedFilterHits("锂 价格", [], "Медь подорожала", "ru"), [], "an uncovered language cannot prove a mineral absent");
});

test("dry-run review 2026-11-08: trade words and single-commodity companies keep a correct mineral tag", () => {
  assert.equal(tagGrounded("铁", "SSAB tops profit expectations as EU import curbs boost steel prices", "en"), true);
  assert.equal(tagGrounded("铁矿石", "World Steel cuts 2026 demand outlook", "en"), false, "iron ore stays strict");
  assert.equal(tagGrounded("铝", "Hydro sees global alumina surplus narrowing", "en"), true);
  assert.equal(tagGrounded("铬", "Chrome ore production rose in the quarter", "en"), true);
  assert.equal(tagGrounded("铅", "Record silver output, with zinc and lead below forecast", "en"), true);
  assert.equal(tagGrounded("铅", "The company will lead the consortium", "en"), false);
  assert.equal(tagGrounded("锂", "Spodumene concentrate shipments resumed", "en"), true);
  assert.equal(tagGrounded("稀土", "A new rare-earth processing hub", "en"), true);
  assert.equal(tagGrounded("铜", "Codelco desvincula a ocho ejecutivos tras nuevos hallazgos", "es"), true, "a copper producer's story");
  assert.equal(tagGrounded("铜", "Universidad de Atacama lanza doctorado en minería sostenible", "es"), false);
  assert.equal(tagGrounded("金", "Barrick names a new chief financial officer", "en"), true);
  assert.equal(tagGrounded("锂", "Barrick names a new chief financial officer", "en"), false);
});

test("the audit checks what the filters still show after the clean-up, not the removals subtracted (Codex review #390)", () => {
  // The original names copper only; the stored tags add lithium and the AI summary says 锂价上涨. The clean-up removes
  // the 锂 tag and its own search word, but the summary's 锂价上涨 stays, so the lithium filter still shows the item.
  const text = "Codelco eleva su producción de cobre";
  const row = { tags: ["铜", "锂"], search_text: "智利 铜 产量 锂价上涨 锂", subjects: [], manual_tags: false, language: "es" };
  const after = regroundedProjection(row, text);
  assert.deepEqual(after.tags, ["铜"]);
  assert.equal(after.searchText, "智利 铜 产量 锂价上涨");
  assert.deepEqual(ungroundedFilterHits(after.searchText, after.tags, text, "es"), ["锂"]);
  const clean = regroundedProjection({ ...row, search_text: "智利 铜 产量 锂" }, text);
  assert.deepEqual(ungroundedFilterHits(clean.searchText, clean.tags, text, "es"), [], "nothing left once the tag word was the only mention");
});
