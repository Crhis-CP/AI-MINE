import assert from "node:assert/strict";
import { test } from "node:test";
import { MetalPrices } from "@amp/contracts/http/public";

const period = { start: "2026-09-11", end: "2026-09-20", label: "合成期" };
const previous = { value: "10.00", period: { start: "2026-09-01", end: "2026-09-10", label: "前一期" } };
const link = { name: "合成链接", url: "https://fixture.example.test/price" };
const source = {
  key: "test",
  name: "合成来源",
  tag: "合成频率",
  status: "fresh",
  latest: { label: period.label, release: { label: "合成发布", url: link.url, date: null } },
};
const quote = {
  key: "test.metal",
  source: "test",
  title: "合成口径",
  spec: null,
  footnote: 1,
  value: "10.10",
  unit: "单位",
  currency: "USD",
  decimals: 2,
  period,
  change: { percent: "1.0", previous },
};
const metal = { key: "metal", name: "合成品种", quotes: [quote] };
const latest = { tag: source.tag, label: period.label, stale: false, extras: [] };
const note = { ref: 1, text: "说明见{link}", link };
const valid = {
  generatedAt: "2026-10-06T00:00:00Z",
  intro: "合成说明",
  latest: [latest],
  sources: [source],
  metals: [metal],
  notes: [note],
  officialLinks: [{ ...link, note: "查询入口" }],
};
const withQuote = (change: Record<string, unknown>) => ({ ...valid, metals: [{ ...metal, quotes: [{ ...quote, ...change }] }] });
const without = (value: object, field: string) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));

test("site metal prices preserve positive decimal strings and permit honest empty or stale data", () => {
  assert.deepEqual(MetalPrices.parse(valid), valid);
  const precise = "123456789012345678901234567890.0000000001";
  assert.equal(MetalPrices.parse(withQuote({ value: precise })).metals[0].quotes[0].value, precise);
  assert.ok(MetalPrices.safeParse({ ...valid, sources: [{ ...source, status: "stale" }], latest: [{ ...latest, stale: true }] }).success);
  assert.ok(
    MetalPrices.safeParse({
      ...withQuote({ value: null, period: null, change: null }),
      sources: [{ ...source, status: "empty", latest: null }],
      latest: [{ ...latest, label: null }],
    }).success,
  );
});

test("missing attribution, invalid identities, periods and decimal values are rejected", () => {
  const cases: unknown[] = [
    ...["name", "tag"].map((field) => ({ ...valid, sources: [without(source, field)] })),
    ...["title", "unit", "currency"].map((field) => ({ ...valid, metals: [{ ...metal, quotes: [without(quote, field)] }] })),
    ...["0", "0.000", "-1.0", "1e3", "NaN", " "].map((value) => withQuote({ value })),
    ...["1", "1.00", "-0.0", "+1.0"].map((percent) => withQuote({ change: { percent, previous } })),
    withQuote({ period: null }),
    withQuote({ value: null, period: null }),
    withQuote({ source: "missing" }),
    withQuote({ change: { percent: "1.0", previous: { ...previous, value: "0" } } }),
    withQuote({ period: { ...period, start: "2026-02-30" } }),
    { ...valid, sources: [{ ...source, status: "empty", latest: null }] },
    { ...valid, sources: [{ ...source, latest: null }] },
    { ...valid, sources: [source, source] },
    { ...valid, sources: [] },
    { ...valid, metals: [] },
    { ...valid, metals: [metal, metal] },
    { ...valid, metals: [{ ...metal, quotes: [] }] },
    { ...valid, metals: [{ ...metal, quotes: [quote, quote] }] },
    { ...valid, intro: " \n " },
    withQuote({ decimals: 7 }),
    withQuote({ currency: "EUR" }),
  ];
  for (const [i, value] of cases.entries()) assert.equal(MetalPrices.safeParse(value).success, false, `invalid price case ${i}`);
});

test("frequency coverage and footnote references cannot drift from the displayed quotes", () => {
  const cases: unknown[] = [
    { ...valid, latest: [latest, latest] },
    { ...valid, latest: [] },
    { ...valid, latest: [{ ...latest, tag: "unknown" }] },
    { ...valid, latest: [{ ...latest, label: null, stale: true }] },
    { ...valid, latest: [{ ...latest, label: null, extras: [{ metals: [metal.name], label: "旧期", stale: false }] }] },
    { ...valid, notes: [{ ...note, ref: 2 }] },
    withQuote({ footnote: 2 }),
    { ...valid, notes: [note, { ...note, ref: 2 }] },
    { ...valid, notes: [{ ref: null, text: "先写说明", link: null }, note] },
    { ...valid, notes: [{ ...note, link: null }] },
    { ...valid, notes: [{ ...note, text: "没有占位" }] },
    ...["{link}{link}", "{tags}", "{compare}", "{other}", "不完整{"].map((text) => ({ ...valid, notes: [{ ...note, text }] })),
    { ...valid, notes: [{ ...note, link: { ...link, url: "http://fixture.example.test" } }] },
    { ...valid, sources: [{ ...source, latest: { ...source.latest, release: { ...source.latest.release, url: "http://fixture.example.test" } } }] },
    { ...valid, officialLinks: [{ ...link, note: "入口", url: "http://fixture.example.test" }] },
  ];
  for (const [i, value] of cases.entries()) assert.equal(MetalPrices.safeParse(value).success, false, `invalid presentation case ${i}`);
});
