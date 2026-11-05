// Foreign company names in model-written Chinese copy: 中文名（原文名） at first mention (Owner 2026-11-05).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NAME_GLOSSARY } from "@amp/industry/name-glossary";
import { bilingualNames } from "../packages/backend/src/editorial/bilingual-names.ts";

test("an English name gets its Chinese name with the original in brackets once; later mentions are Chinese", () => {
  assert.equal(bilingualNames("BHP下调铜产量指引，BHP称智利项目推迟"), "必和必拓（BHP）下调铜产量指引，必和必拓称智利项目推迟");
  assert.equal(bilingualNames("Rio Tinto与Glencore洽谈合并"), "力拓（Rio Tinto）与嘉能可（Glencore）洽谈合并");
  assert.equal(bilingualNames("Teck Resources出售煤炭业务"), "泰克资源（Teck Resources）出售煤炭业务");
});

test("a Chinese name first gets the original once; text already bracketed or unknown names stay as written", () => {
  assert.equal(bilingualNames("必和必拓公布季度产量，BHP股价上涨"), "必和必拓（BHP）公布季度产量，必和必拓股价上涨");
  assert.equal(bilingualNames("必和必拓（BHP）公布季度产量"), "必和必拓（BHP）公布季度产量");
  assert.equal(bilingualNames("必和必拓(BHP Group)公布季度产量"), "必和必拓(BHP Group)公布季度产量");
  assert.equal(bilingualNames("Hudbay Minerals获批秘鲁扩建"), "Hudbay Minerals获批秘鲁扩建", "no common Chinese name: unchanged");
});

test("short Chinese names that are ordinary words never trigger by themselves", () => {
  assert.equal(bilingualNames("政府大力拓展铜矿勘探"), "政府大力拓展铜矿勘探");
  assert.equal(bilingualNames("金田村发现金矿线索"), "金田村发现金矿线索");
});

test("the prompt's name list carries every glossary pair", () => {
  const list = readFileSync(new URL("../industry/prompts/rules-domain-names.md", import.meta.url), "utf8");
  for (const { zh, en } of NAME_GLOSSARY.filter((e) => !["洛阳钼业", "五矿资源"].includes(e.zh))) assert.ok(list.includes(`${zh}（${en}）`), `${zh}（${en}）`);
});
