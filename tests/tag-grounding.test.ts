// A company or mineral tag is kept only when the material names it (TASK-0584): the Owner found 《比尔·盖茨私人访问
// 智利 Chuquicamata 铜矿》 under 紫金矿业 although its original never names Zijin.
import assert from "node:assert/strict";
import { test } from "node:test";
import { groundTags, groundingText, tagGrounded } from "../packages/backend/src/publication/tag-grounding.ts";

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
