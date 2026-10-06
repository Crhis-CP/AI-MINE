// Metal prices (TASK-0044), layer one: the table refuses a row without what a price needs (hard rule 1, the database
// half), and the registry in the industry pack is checked whole on reading: only the four official hosts, no unknown
// or missing fields, every series on a registered source (hard rule 3, the registry half). No network.
import "./setup.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { loadMetalPriceRegistry, METAL_PRICE_HOSTS, parseMetalPriceRegistry } from "../packages/backend/src/publication/metal-prices/registry.ts";

const sql = dbOf("publication");
after(() => closeDb());

/** A valid ten-day row with a synthetic value; every refused case changes a copy of it. */
const row = (change: Record<string, string | null> = {}) => ({
  series_key: "nbs.copper",
  source: "nbs",
  name_zh: "电解铜",
  grade: "1#",
  benchmark: "全国流通领域市场价格",
  delivery_basis: null,
  currency: "CNY",
  unit: "元/吨",
  source_unit: "吨",
  period_type: "ten_day",
  period_start: "2026-09-11",
  period_end: "2026-09-20",
  period_label: "2026年9月中旬",
  value: "12345.60",
  release_label: "2026年9月中旬流通领域重要生产资料市场价格变动情况",
  release_url: "https://www.stats.gov.cn/sj/zxfb/202609/t20260923_1965403.html",
  released_on: "2026-09-24",
  first_fetched_at: "2026-09-24T01:45:00Z",
  fetched_at: "2026-09-24T01:45:00Z",
  ...change,
});
const insert = (change: Record<string, string | null> = {}) => sql`INSERT INTO publication.metal_prices ${sql(row(change))}`;
const code = (expected: string) => (error: { code?: string }) => error.code === expected;

test("the price table refuses a row without source, benchmark, unit, currency or period, and every unpaired value", async () => {
  const required =
    "series_key source benchmark unit source_unit currency period_type period_start period_end period_label name_zh value release_label release_url first_fetched_at fetched_at";
  const refused: Record<string, string | null>[] = [
    ...required.split(" ").map((column) => ({ [column]: null })),
    ...["0", "-1", "NaN", "Infinity"].map((value) => ({ value })),
    { source: "lme" },
    // Each of these two breaks one value list only: an unknown source, and a period type no source uses.
    { source: "wb", series_key: "wb.copper", currency: "USD", period_type: "month", period_start: "2026-08-01", period_end: "2026-08-31" },
    { source: "worldbank", series_key: "wb.copper", currency: "USD", period_type: "week", period_start: "2026-08-01", period_end: "2026-08-31" },
    ...["name_zh", "grade", "benchmark", "delivery_basis", "unit", "source_unit", "period_label", "release_label"].map((column) => ({ [column]: " " })),
    { currency: "EUR" },
    { period_end: "2026-09-10" },
    { release_url: "http://www.stats.gov.cn/sj/zxfb/202609/t20260923_1965403.html" },
    // The bureau publishes ten-day prices, the World Bank and the IMF monthly ones, each under its own key prefix.
    { period_type: "month" },
    { series_key: "wb.copper" },
    { series_key: "nbs.Copper" },
    { source: "worldbank", series_key: "wb.copper", currency: "USD" },
  ];
  for (const change of refused) await assert.rejects(insert(change), code(Object.values(change).includes(null) ? "23502" : "23514"), JSON.stringify(change));
  assert.equal((await sql`SELECT count(*)::int AS n FROM publication.metal_prices`)[0].n, 0);

  await insert();
  // The source's figure is kept as written, trailing zero included: no rounding or conversion.
  assert.equal((await sql`SELECT value::text AS value FROM publication.metal_prices`)[0].value, "12345.60");
  // A later release revising the same period is a row beside the old one; the same release twice is not.
  await insert({ release_label: "2026年9月中旬流通领域重要生产资料市场价格变动情况（修订）" });
  await assert.rejects(insert(), code("23505"));
  const monthly = { period_type: "month", period_start: "2026-08-01", period_end: "2026-08-31", period_label: "2026年8月", currency: "USD", grade: null };
  await insert({ ...monthly, series_key: "wb.copper", source: "worldbank", release_url: "https://thedocs.worldbank.org/fixture.xlsx", released_on: null });
  await insert({ ...monthly, series_key: "imf.cobalt", source: "imf", release_url: "https://www.imf.org/fixture.xlsx", delivery_basis: "fixture" });
  assert.equal((await sql`SELECT count(*)::int AS n FROM publication.metal_prices`)[0].n, 4);
});

const text = readFileSync(new URL("../industry/metal-prices.json", import.meta.url), "utf8");

test("the real registry: the bureau's ten series on its one official host, source defaults filled into each series", () => {
  const registry = loadMetalPriceRegistry();
  assert.deepEqual(registry, parseMetalPriceRegistry(JSON.parse(text)));
  assert.deepEqual([...METAL_PRICE_HOSTS].sort(), ["thedocs.worldbank.org", "www.imf.org", "www.stats.gov.cn", "www.worldbank.org"]);
  // Only the bureau's part: later cards add the World Bank and the IMF to the same file.
  const nbs = registry.sources.find((source) => source.key === "nbs")!;
  const items = registry.items.filter((item) => item.source === "nbs");
  assert.deepEqual(
    [nbs.section, nbs.frequency, nbs.currency, nbs.staleDays, nbs.hosts, nbs.decimals, nbs.lmeNote, nbs.enabled],
    ["domestic", "ten_day", "CNY", 20, ["www.stats.gov.cn"], null, null, true],
  );
  assert.deepEqual(nbs.attribution, ["转自国家统计局网站 https://www.stats.gov.cn", "原文数据来源：中国统计信息服务中心、卓创资讯"]);
  assert.equal(
    items.map((item) => item.key).join(" "),
    "nbs.copper nbs.aluminum nbs.lead nbs.zinc nbs.rebar nbs.wire_rod nbs.medium_plate nbs.hr_coil nbs.seamless_pipe nbs.angle_steel",
  );
  for (const item of items)
    assert.deepEqual(
      [item.source, item.enabled, item.benchmark, item.deliveryBasis, item.unit, item.sourceUnit, item.descriptionIncludes],
      ["nbs", true, "全国流通领域市场价格", null, "元/吨", "吨", []],
    );
  // The bureau does not say how the period's price is taken: nothing calls it a ten-day average.
  assert.doesNotMatch(text, /旬均价/);
});

test("a bad registry is refused whole with the field named; a stopped series stays registered", () => {
  const data = () => JSON.parse(text);
  // [path of the field to change (undefined deletes it), new value, expected message]
  const cases: [string, unknown, RegExp][] = [
    ["sources.0.hosts", ["www.lme.com"], /sources\.0\.hosts\.0: Invalid option/],
    ["sources.0.hosts", ["www.stats.gov.cn", "www.stats.gov.cn"], /sources\.0\.hosts: duplicate host/],
    ["sources.0.name", undefined, /sources\.0\.name/],
    ["sources.0.staleDays", undefined, /sources\.0\.staleDays/],
    ["sources.0.attribution", [], /sources\.0\.attribution/],
    ["sources.0.terms.url", "http://www.stats.gov.cn/", /sources\.0\.terms\.url/],
    ["sources.0.officialUrl", "www.stats.gov.cn", /sources\.0\.officialUrl/],
    ["sources.0.currency", "EUR", /sources\.0\.currency/],
    ["sources.0.frequency", "month", /sources\.0\.frequency: nbs publishes ten_day prices/],
    ["sources.0.fetchUrl", "https://www.lme.com/", /Unrecognized key: "fetchUrl"/],
    ["sources.1", data().sources[0], /sources\.1\.key: duplicate source nbs/],
    ["sources.0.benchmark", undefined, /items\.0\.benchmark: no benchmark on the item or its source/],
    ["sources.0.key", "worldbank", /items\.0\.source: unknown source nbs/],
    ["items.0.source", "lme", /items\.0\.source/],
    ["items.0.key", "imf.copper", /items\.0\.key: imf\.copper does not start with nbs\./],
    ["items.0.key", "nbs.Copper", /items\.0\.key/],
    ["items.1.key", "nbs.copper", /items\.1\.key: duplicate item nbs\.copper/],
    ["items.1.sourceName", "电解铜(1#)", /items\.1\.sourceName: duplicate source name/],
    ["items.0.sourceName", undefined, /items\.0\.sourceName/],
    ["items.0.note", "待核实", /Unrecognized key: "note"/],
    ["items", data().items.map((item: object) => ({ ...item, enabled: false })), /sources\.0\.enabled: no enabled item/],
    ["items", [], /items/],
  ];
  for (const [at, value, expected] of cases) {
    const d = data(),
      keys = at.split("."),
      last = keys.pop()!;
    const parent = keys.reduce((node, key) => node[key], d);
    if (value === undefined) delete parent[last];
    else parent[last] = value;
    assert.throws(() => parseMetalPriceRegistry(d), expected, at);
  }
  const stopped = data();
  stopped.items[3].enabled = false;
  const kept = parseMetalPriceRegistry(stopped).items;
  assert.deepEqual([kept.length, kept.filter((item) => item.source === "nbs" && !item.enabled).map((item) => item.key)], [stopped.items.length, ["nbs.zinc"]]);
  const dir = mkdtempSync(path.join(tmpdir(), "metal-prices-"));
  writeFileSync(path.join(dir, "broken.json"), text.slice(0, -10));
  assert.throws(() => loadMetalPriceRegistry(path.join(dir, "broken.json")), SyntaxError);
});
