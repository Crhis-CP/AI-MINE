// CBR registry, storage shape and daily refresh: synthetic local values until TASK-0089 adds recorded fixtures.
import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, beforeEach, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { refreshMetalPrices } from "../packages/backend/src/publication/metal-prices/refresh.ts";
import { loadMetalPriceRegistry, parseMetalPriceRegistry } from "../packages/backend/src/publication/metal-prices/registry.ts";
import type { FetchedPeriod } from "../packages/backend/src/publication/metal-prices/types.ts";

const sql = dbOf("publication");
after(() => closeDb());
beforeEach(async () => {
  await sql`TRUNCATE publication.metal_prices`;
});
const raw = JSON.parse(readFileSync(new URL("../industry/metal-prices.json", import.meta.url), "utf8"));
const registry = loadMetalPriceRegistry();
const source = registry.sources.find((s) => s.key === "cbr")!;
const items = registry.items.filter((s) => s.source === "cbr");
const only = () => ({
  ...structuredClone(raw),
  sources: [{ ...raw.sources.find((s: { key: string }) => s.key === "cbr"), enabled: true }],
  items: structuredClone(raw.items.filter((s: { source: string }) => s.source === "cbr")),
});
const footnote = "俄央行核算价：俄罗斯银行（俄罗斯央行）每个工作日公布的贵金属核算价，原为卢布/克，本站按它同一天公布的美元汇率换算成美元/盎司。来源：{link}。";

test("CBR registration keeps four converted quotes and a hidden raw rate, with the approved daily footnote", () => {
  assert.deepEqual(
    [source.name, source.section, source.frequency, source.currency, source.staleDays, source.decimals],
    ["俄罗斯银行（俄罗斯央行）", "international", "day", "RUB", 14, 2],
  );
  assert.deepEqual(source.hosts, ["www.cbr.ru", "bank.gov.ua"]);
  for (const [index, metal] of ["gold", "silver", "platinum", "palladium"].entries()) {
    const item = items.find((i) => i.key === `cbr.${metal}`)!;
    assert.deepEqual(
      [item.sourceName, item.metal, item.quote, item.spec, item.footnote, item.unit, item.sourceUnit, item.rate],
      [String(index + 1), metal, "俄央行核算价", null, "cbr", "卢布/克", "卢布/克", false],
    );
    assert.deepEqual(item.convert, { rate: "cbr.usd", factor: "31.1034768", unit: "美元/盎司", currency: "USD" });
  }
  const rate = items.find((i) => i.key === "cbr.usd")!;
  assert.deepEqual(
    [rate.rate, rate.sourceName, rate.unit, rate.sourceUnit, rate.benchmark, rate.metal, rate.quote, rate.convert],
    [true, "USD", "卢布/美元", "卢布/美元", "俄罗斯银行官方汇率", null, null, null],
  );
  assert.deepEqual(registry.frequencies[0], { key: "day", tag: "日", compare: "日价比上一个定价日" });
  assert.deepEqual(
    registry.footnotes.find((f) => f.key === "cbr"),
    { key: "cbr", text: footnote, link: { name: "俄罗斯银行 贵金属核算价", url: "https://www.cbr.ru/hd_base/metall/metall_base_new/" } },
  );
  assert.ok(registry.officialLinks.every((link) => !link.url.includes("cbr.ru")));
  assert.doesNotMatch(JSON.stringify({ source, items, footnote }), /LBMA|伦敦金价|伦敦定盘价|平均|月均|均价|XAU|XAG|XPT|XPD|UAH|NBUStatService/);
  assert.ok(registry.items.filter((i) => i.source !== "cbr").every((i) => i.convert === null && i.rate === false));
});

test("bad conversions and rate presentation reject the entire registry and name the field", () => {
  const bad: [string, (copy: ReturnType<typeof only>) => void][] = [
    ...["missing", "nbs.copper", "cbr.silver"].map((rate): [string, (c: ReturnType<typeof only>) => void] => [
      "convert.rate",
      (c) => {
        c.items[0].convert.rate = rate;
      },
    ]),
    [
      "convert.rate",
      (c) => {
        c.items[4].enabled = false;
      },
    ],
    ...["0", "-1", "1e3", "31,1"].map((factor): [string, (c: ReturnType<typeof only>) => void] => [
      "convert.factor",
      (c) => {
        c.items[0].convert.factor = factor;
      },
    ]),
    [
      "convert.currency",
      (c) => {
        c.items[0].convert.currency = "RUB";
      },
    ],
    ...["metal", "quote", "spec", "footnote", "convert"].map((field): [string, (c: ReturnType<typeof only>) => void] => [
      field,
      (c) => {
        c.items[4][field] = c.items[0][field] ?? "forbidden";
      },
    ]),
    [
      "convert",
      (c) => {
        delete c.items[0].convert;
      },
    ],
    [
      "frequency",
      (c) => {
        c.sources[0].frequency = "ten_day";
      },
    ],
    [
      "key",
      (c) => {
        c.items[0].key = "nbs.gold";
      },
    ],
  ];
  const foreign = only();
  foreign.sources.push(raw.sources.find((s: { key: string }) => s.key === "worldbank"));
  foreign.items.push({ ...foreign.items[4], key: "wb.usd", source: "worldbank" });
  foreign.items[0].convert.rate = "wb.usd";
  assert.throws(() => parseMetalPriceRegistry(foreign), /convert\.rate/);
  for (const [field, edit] of bad) {
    const copy = only();
    edit(copy);
    assert.throws(() => parseMetalPriceRegistry(copy), new RegExp(field.replaceAll(".", "\\.")));
  }
});

const stored = (change: Record<string, string> = {}) => ({
  series_key: "cbr.gold",
  source: "cbr",
  name_zh: "金",
  benchmark: "俄罗斯银行贵金属核算价",
  currency: "RUB",
  unit: "卢布/克",
  source_unit: "卢布/克",
  period_type: "day",
  period_start: "2026-10-01",
  period_end: "2026-10-01",
  period_label: "2026年10月1日定价",
  value: "11000.00",
  release_label: "俄罗斯银行 2026年10月2日起适用",
  release_url: "https://www.cbr.ru/scripts/xml_metall.asp",
  released_on: null,
  first_fetched_at: "2026-10-06T02:00:00Z",
  fetched_at: "2026-10-06T02:00:00Z",
  ...change,
});

test("named migration checks admit raw CBR daily rows and preserve all source, currency and calendar constraints", async () => {
  const refused: Record<string, string>[] = [
    { period_type: "ten_day" },
    { period_end: "2026-10-02" },
    { source: "nbs", series_key: "nbs.gold" },
    { source: "worldbank", series_key: "wb.gold" },
    { source: "nbs" },
    { currency: "EUR" },
  ];
  for (const change of refused) await assert.rejects(sql`INSERT INTO publication.metal_prices ${sql(stored(change))}`, { code: "23514" });
  await sql`INSERT INTO publication.metal_prices ${sql(stored())}`;
  await sql`INSERT INTO publication.metal_prices ${sql(stored({ series_key: "nbs.copper", source: "nbs", currency: "CNY", period_type: "ten_day", period_end: "2026-10-10" }))}`;
  assert.deepEqual(
    (await sql`SELECT value::text AS value FROM publication.metal_prices ORDER BY source`).map((r) => r.value),
    ["11000.00", "11000.00"],
  );
  const constraints = (await sql`SELECT conname FROM pg_constraint WHERE conrelid = 'publication.metal_prices'::regclass`).map((r) => r.conname);
  for (const name of ["series_key", "source", "currency", "period_type", "cbr_day", "day"]) assert.ok(constraints.includes(`metal_prices_${name}_check`));
});

const day = (n: number, extra: Partial<FetchedPeriod> = {}): FetchedPeriod => ({
  source: "cbr",
  period: { start: `2026-10-0${n}`, end: `2026-10-0${n}`, label: `2026年10月${n}日定价` },
  release: { label: `俄罗斯银行 2026年10月${n + 1}日起适用`, url: "https://www.cbr.ru/scripts/xml_metall.asp", releasedOn: null },
  rows: items.map((i) => ({ key: i.key, unit: i.sourceUnit, value: i.rate ? "80.0000" : "1000.00" })),
  held: [],
  ...extra,
});
const synthetic = async (periods: FetchedPeriod[]) =>
  (
    await refreshMetalPrices({
      registry: only(),
      now: new Date("2026-10-06T02:00:00Z"),
      fetchers: { cbr: () => ({ sourceKeys: ["cbr"], fetch: async () => periods }) },
    })
  ).cbr;

test("fetcher notes precede check notes and a held daily fixing leaves later days free to store", async () => {
  const first = await synthetic([day(1, { notes: ["合成来源观察"] })]);
  assert.deepEqual(first.periods[0].notes, ["合成来源观察", "没有上一期"]);
  await sql`TRUNCATE publication.metal_prices`;
  const result = await synthetic([day(1, { held: ["合成比对扣下"] }), day(2)]);
  assert.equal(result.ok, false);
  assert.match(result.periods[0].held!, /合成比对扣下/);
  assert.deepEqual([result.periods[1].held, result.periods[1].inserted], [null, 5]);
  assert.deepEqual(
    (await sql`SELECT DISTINCT period_start::text AS day FROM publication.metal_prices`).map((r) => r.day),
    ["2026-10-02"],
  );
});
