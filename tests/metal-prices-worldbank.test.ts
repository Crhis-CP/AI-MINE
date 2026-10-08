import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadMetalPriceRegistry } from "../packages/backend/src/publication/metal-prices/registry.ts";

const raw = JSON.parse(readFileSync(new URL("../industry/metal-prices.json", import.meta.url), "utf8"));
const registry = loadMetalPriceRegistry();
const expected = {
  gold: ["国际现货 · 月均价", null, "monthly_average", "美元/盎司"],
  silver: ["国际 · 伦敦下午定价", "精炼，纯度 99.9%", "london_pm", "美元/盎司"],
  platinum: ["国际现货 · 月均价", "纯度不低于 99.95%，板或锭", "monthly_average", "美元/盎司"],
  copper: ["国际 · LME 结算价", "A 级阴极铜，纯度不低于 99.9935%", "lme", "美元/吨"],
  aluminum: ["国际 · LME 结算价", "原铝锭，纯度不低于 99.7%", "lme", "美元/吨"],
  zinc: ["国际 · LME 结算价", "高等级，纯度不低于 99.95%", "lme", "美元/吨"],
  lead: ["国际 · LME 结算价", "精炼，纯度 99.97%", "lme", "美元/吨"],
  tin: ["国际 · LME 结算价", "精炼，纯度 99.85%", "lme", "美元/吨"],
  nickel: ["国际 · LME 结算价", "阴极镍，纯度不低于 99.8%", "lme", "美元/吨"],
  iron_ore: ["国际现货 · 运到中国（CFR）", "粉矿，含铁 62%", "cfr", "美元/干吨"],
};
const footnotes = {
  monthly_average: "月均价：世界银行公布的当月每日现货价格的平均值，不是某一天的价格。",
  london_pm: "伦敦下午定价：世界银行对这项白银价格的原文是 London afternoon fixing，指伦敦市场每个工作日定出的白银基准价。",
  lme: "LME：伦敦金属交易所（London Metal Exchange）。结算价是它每个交易日公布的官方价格；表中是世界银行按月公布的月平均价。",
  cfr: "CFR：成本加运费，指运到中国港口的价格，含海运费、不含保险。干吨：扣除水分后计重的吨。",
};
const international =
  "国际价格来自世界银行每月发布的大宗商品价格（Pink Sheet，按 {link} 许可使用），表中是它公布的月平均价；铜、铝、锌、铅、锡、镍是它写明的 LME 结算价。品种名称与规格由本站翻译，数值保留两位小数。";

test("World Bank registry preserves the fourth-version quotes, footnotes and attribution order", () => {
  const source = registry.sources.find((s) => s.key === "worldbank")!;
  assert.deepEqual(
    [source.name, source.section, source.frequency, source.currency, source.staleDays, source.decimals],
    ["世界银行", "international", "month", "USD", 45, 2],
  );
  assert.deepEqual(source.hosts, ["www.worldbank.org", "thedocs.worldbank.org"]);
  for (const [metal, fields] of Object.entries(expected)) {
    const item = registry.items.find((i) => i.key === `wb.${metal}`)!;
    assert.equal(item.source, "worldbank");
    assert.equal(item.metal, metal);
    assert.deepEqual([item.quote, item.spec, item.footnote, item.unit], fields);
    assert.ok(item.descriptionIncludes.length > 0);
  }
  const frequencies = registry.frequencies.map((f) => f.key);
  assert.ok(frequencies.indexOf("ten_day") < frequencies.indexOf("month"));
  for (const [key, text] of Object.entries(footnotes)) assert.equal(registry.footnotes.find((f) => f.key === key)?.text, text);
  const domestic = registry.notes.findIndex((n) => n.sources?.includes("nbs"));
  const index = registry.notes.findIndex((n) => n.sources?.includes("worldbank"));
  assert.ok(index > domestic);
  assert.deepEqual(registry.notes[index], {
    text: international,
    link: { name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
    sources: ["worldbank"],
  });
  assert.ok(registry.notes.some((n) => n.text.startsWith("“电解铜 1#”") && n.text.endsWith("盎司指金衡盎司，约 31.1 克。")));
});

test("monthly-average wording occurs only at the explicitly supported locations", () => {
  const visit = (value: unknown, path: (string | number)[] = []) => {
    if (typeof value === "string") {
      const [field, index, property] = path;
      const monthlyFootnote = field === "footnotes" && raw.footnotes[index as number]?.key === "monthly_average" && property === "text";
      const monthlyQuote = field === "items" && ["wb.gold", "wb.platinum"].includes(raw.items[index as number]?.key) && property === "quote";
      const lme = field === "footnotes" && raw.footnotes[index as number]?.key === "lme" && property === "text";
      const attribution = field === "notes" && raw.notes[index as number]?.sources?.includes("worldbank") && property === "text";
      assert.ok(!value.includes("月均") || monthlyFootnote || monthlyQuote, path.join("."));
      assert.ok(!value.includes("平均") || monthlyFootnote || lme || attribution, path.join("."));
      assert.ok(!value.includes("每日结算价"), path.join("."));
    } else if (Array.isArray(value))
      value.forEach((child, i) => {
        visit(child, [...path, i]);
      });
    else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
  };
  visit(raw);
});
