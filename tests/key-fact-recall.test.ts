// The same party with the same amount puts two reports before the event judge (TASK-0578). Production
// (Codex #389, 2026-11-08): one Rio Tinto investment in Resolution Copper sat in five separate events, three of
// them picks; AngloGold's US$900 million and India's lithium/nickel incentive were split the same way.
import assert from "node:assert/strict";
import { test } from "node:test";
import { IDENTITY_LEXICON } from "@amp/industry/taxonomy";
import { keyFacts, keyNames, keyQuantities, sharesKeyFact } from "../packages/backend/src/events/relate.ts";
import { keyFactsFirst } from "../packages/backend/src/events/group.ts";

const facts = (text: string) => keyFacts(text, IDENTITY_LEXICON);

test("amounts normalise across languages, magnitudes and spacing; years and plain counts do not count", () => {
  assert.deepEqual([...keyQuantities("力拓批准向 Resolution Copper 项目投入 1.44 亿美元")], ["usd:144000000"]);
  assert.deepEqual([...keyQuantities("Rio Tinto approves US$144 million for Resolution Copper")], ["usd:144000000"]);
  assert.deepEqual([...keyQuantities("AngloGold to spend up to $900m")], ["usd:900000000"]);
  assert.deepEqual([...keyQuantities("拟投资至多9亿美元扩建三座在产金矿")], ["usd:900000000"]);
  assert.deepEqual([...keyQuantities("预计2027年全球铜矿产量回升3.4%至2408万吨")], ["pct:3.4", "t:24100000"]);
  assert.deepEqual([...keyQuantities("2026年第三季度，公司拥有12座矿山")], [], "a year and a count are not amounts");
  assert.deepEqual([...keyQuantities("India approves Rs 1,500 crore")], ["inr:15000000000"]);
  assert.deepEqual([...keyQuantities("Rio Tinto approves USD 144 million for Resolution Copper")], ["usd:144000000"], "a leading ISO code is the currency");
  assert.deepEqual([...keyQuantities("Northern Star commits AUD 144 million")], ["aud:144000000"], "a different currency keeps its own key");
  assert.deepEqual([...keyQuantities("AUD144m capex")], ["aud:144000000"]);
  assert.deepEqual([...keyQuantities("output in the years 2025 and 2026")], [], "the rs in years is not a rupee sign");
});

test("names: lexicon companies in either language and the Latin names the copy keeps", () => {
  const zh = keyNames("力拓（Rio Tinto）批准1.44亿美元投资推进Resolution Copper项目", IDENTITY_LEXICON);
  assert.ok(zh.has("co:rio-tinto"));
  assert.ok(zh.has("nm:resolution"), "Copper is a common word; Resolution names the project");
  const en = keyNames("Resolution Copper Mining approves investment in Arizona copper project", IDENTITY_LEXICON);
  assert.ok(en.has("nm:resolution"));
  assert.ok(!keyNames("Mining Copper Gold Update", IDENTITY_LEXICON).size, "common words alone name nothing");
  assert.ok(!keyNames("企业大力拓展海外市场", IDENTITY_LEXICON).has("co:rio-tinto"), "力拓 inside 大力拓展 is not Rio Tinto");
});

test("the production duplicates are tied; different news about the same company is not", () => {
  const rio = [
    "力拓批准向 Resolution Copper 项目投入 1.44 亿美元",
    "力拓（Rio Tinto）批准1.44亿美元投资推进Resolution Copper项目",
    "Resolution Copper Mining 批准向亚利桑那铜矿项目投资 1.44 亿美元",
    "力拓批准向美国 Resolution Copper 铜矿投入 1.44 亿美元",
  ].map(facts);
  for (const a of rio) for (const b of rio) assert.ok(sharesKeyFact(a, b));
  const angloA = facts("盎格鲁黄金阿散蒂（AngloGold Ashanti）拟投至多9亿美元扩建三座在产金矿");
  const angloB = facts("盎格鲁黄金阿散蒂（AngloGold Ashanti）拟投资9亿美元扩建现有矿山");
  assert.ok(sharesKeyFact(angloA, angloB));
  assert.ok(!sharesKeyFact(rio[0]!, facts("力拓（Rio Tinto）在阿根廷举行14亿美元锂项目落成仪式")), "same company, another amount");
  assert.ok(!sharesKeyFact(rio[0]!, angloA), "same amount class, another party");
  assert.ok(!sharesKeyFact(facts("铜价上涨1.2%"), facts("锂价上涨1.2%")), "no named party: never tied");
});

test("key-fact matches are judged first, without duplicates", () => {
  const keyed = [{ factId: 7, score: 0.4 }];
  const recalled = [
    { factId: 3, score: 0.8 },
    { factId: 7, score: 0.4 },
    { factId: 5, score: 0.7 },
  ];
  assert.deepEqual(
    keyFactsFirst(keyed, recalled).map((r) => r.factId),
    [7, 3, 5],
  );
});
