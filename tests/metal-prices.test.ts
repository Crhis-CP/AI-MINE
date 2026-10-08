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
import { nbsFetcher, NBS_LIST_URL } from "../packages/backend/src/publication/metal-prices/nbs.ts";

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

const STEEL = "rebar wire_rod medium_plate hr_coil seamless_pipe angle_steel".split(" ").map((key) => `nbs.${key}`);
const inOrder = (actual: string[], expected: string[]) =>
  assert.deepEqual(
    actual.filter((key) => expected.includes(key)),
    expected,
  );
test("the fourth-version registry preserves source facts, five active bureau quotes and the approved presentation", () => {
  const registry = loadMetalPriceRegistry();
  assert.deepEqual(registry, parseMetalPriceRegistry(JSON.parse(text)));
  for (const host of ["thedocs.worldbank.org", "www.imf.org", "www.stats.gov.cn", "www.worldbank.org"])
    assert.ok(METAL_PRICE_HOSTS.some((known) => known === host));
  const nbs = registry.sources.find((source) => source.key === "nbs")!,
    items = registry.items.filter((item) => item.source === "nbs");
  assert.deepEqual(
    [nbs.section, nbs.frequency, nbs.currency, nbs.staleDays, nbs.hosts, nbs.decimals, nbs.enabled],
    ["domestic", "ten_day", "CNY", 20, ["www.stats.gov.cn"], null, true],
  );
  assert.deepEqual(nbs.attribution, ["转自国家统计局网站 https://www.stats.gov.cn", "原文数据来源：中国统计信息服务中心、卓创资讯"]);
  const active = items.filter((item) => item.enabled);
  assert.deepEqual(
    active.map((item) => [item.metal, item.quote, item.spec]),
    [
      ["copper", "国内 · 电解铜 1#", "铜含量不低于 99.95%"],
      ["aluminum", "国内 · 铝锭 A00", "铝含量不低于 99.70%"],
      ["lead", "国内 · 铅锭 1#", "铅含量不低于 99.994%"],
      ["zinc", "国内 · 锌锭 0#", "锌含量不低于 99.995%"],
      ["sulfuric_acid", "国内 · 硫酸（98%）", null],
    ],
  );
  assert.deepEqual(
    items.filter((item) => !item.enabled).map((item) => item.key),
    STEEL,
  );
  for (const item of items) assert.deepEqual([item.benchmark, item.deliveryBasis, item.unit, item.sourceUnit], ["全国流通领域市场价格", null, "元/吨", "吨"]);
  inOrder(
    registry.metals.map((metal) => metal.key),
    "gold silver platinum palladium copper aluminum zinc lead tin nickel iron_ore sulfuric_acid".split(" "),
  );
  assert.equal(registry.intro, "官方机构定期发布的金属价格，注明出处。不是实时行情。");
  assert.deepEqual(
    registry.frequencies.find((f) => f.key === "ten_day"),
    { key: "ten_day", tag: "旬", compare: "旬价比上一旬" },
  );
  const domesticNotes = registry.notes.filter((note) => note.sources?.includes("nbs"));
  assert.ok(domesticNotes.some((note) => note.text.includes("转自国家统计局网站 https://www.stats.gov.cn")));
  assert.ok(registry.notes.some((note) => note.text === "本栏数据不授权转载，需要使用请到各官方网站查阅原数。"));
  inOrder(
    registry.officialLinks.map((link) => link.name),
    [
      "国家统计局 数据发布",
      "世界银行 大宗商品价格",
      "IMF 初级商品价格",
      "LME 官方金属行情",
      "上海黄金交易所 每日行情",
      "上海期货交易所",
      "伦敦金银市场协会（LBMA）",
    ],
  );
  inOrder(
    registry.officialLinks.map((link) => link.url),
    [
      "https://www.stats.gov.cn/sj/zxfb/index.html",
      "https://www.worldbank.org/en/research/commodity-markets",
      "https://www.imf.org/en/research/commodity-prices",
      "https://www.lme.com/metals",
      "https://www.sge.com.cn/sjzx/quotation_daily_new",
      "https://www.shfe.com.cn/",
      "https://www.lbma.org.uk/",
    ],
  );
  assert.equal(registry.officialLinks.find((link) => link.name === "上海期货交易所")?.url, "https://www.shfe.com.cn/");
  assert.ok(registry.officialLinks.every((link) => new URL(link.url).protocol === "https:"));
  assert.doesNotMatch(text, /旬均价|涨跌幅/);
  assert.doesNotMatch(JSON.stringify({ items, domesticNotes }), /平均|均价|月均/);
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
  for (const field of ["metals", "intro", "frequencies", "footnotes", "notes", "officialLinks"]) cases.push([field, undefined, new RegExp(field)]);
  cases.push(
    ["intro", " ", /intro/],
    ["items.0.metal", undefined, /items\.0\.metal/],
    ["items.0.quote", undefined, /items\.0\.quote/],
    ["items.0.metal", "missing", /items\.0\.metal/],
    ["items.0.footnote", "missing", /items\.0\.footnote/],
    ["metals.1", data().metals[0], /metals\.1\.key/],
    ["frequencies", [{ key: "month", tag: "月", compare: "月价比上个月" }], /sources\.0\.frequency/],
    ["notes.0.text", "{link}", /notes\.0\.text/],
    ["notes.0.link", { name: "link", url: "https://example.test" }, /notes\.0\.text/],
    ["notes.0.text", "{other}", /notes\.0\.text/],
    ["notes.2.sources", ["foo"], /notes\.2\.sources/],
    ["officialLinks.0.url", "http://example.test", /officialLinks\.0\.url/],
  );
  const foot = { key: "test", text: "fixture" };
  cases.push(
    ["footnotes", [foot, foot], /footnotes\.1\.key/],
    ["footnotes", [{ ...foot, text: "{tags}" }], /footnotes\.0\.text/],
    ["footnotes", [{ ...foot, text: "{link}" }], /footnotes\.0\.text/],
    ["footnotes", [{ ...foot, text: "{link}{link}", link: { name: "link", url: "https://example.test" } }], /footnotes\.0\.text/],
    ["footnotes", [{ ...foot, text: "{link}", link: { name: "link", url: "http://example.test" } }], /footnotes\.0\.link/],
  );
  const frequency = data().frequencies.find((f: { key: string }) => f.key === "ten_day");
  cases.push(
    ["frequencies", [frequency, frequency], /frequencies\.1\.key/],
    ["frequencies", [frequency, { key: "month", tag: frequency.tag, compare: "fixture" }], /frequencies\.1\.tag/],
  );
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
  assert.deepEqual(
    [kept.length, kept.filter((item) => item.source === "nbs" && !item.enabled).map((item) => item.key)],
    [stopped.items.length, ["nbs.zinc", ...STEEL]],
  );
  const dir = mkdtempSync(path.join(tmpdir(), "metal-prices-"));
  writeFileSync(path.join(dir, "broken.json"), text.slice(0, -10));
  assert.throws(() => loadMetalPriceRegistry(path.join(dir, "broken.json")), SyntaxError);
});

test("unregistered but known note sources are allowed, and the real bureau fixture includes sulfuric acid", async () => {
  const data = JSON.parse(text);
  data.sources = data.sources.filter((source: { key: string }) => source.key === "nbs");
  data.items = data.items.filter((item: { source: string }) => item.source === "nbs");
  data.notes.push({ text: "optional source", sources: ["worldbank"] });
  const registry = parseMetalPriceRegistry(data);
  const fixture = (name: string) => readFileSync(new URL(`./fixtures/metal-prices/nbs/${name}.html`, import.meta.url), "utf8");
  const get = async (url: string) => ({
    status: 200,
    url,
    text: () => fixture(url === NBS_LIST_URL ? "list" : url.includes("1965293") ? "release-previous" : "release-latest"),
  });
  const periods = await nbsFetcher(registry, get).fetch(async () => "2026-09-01");
  assert.deepEqual(
    periods.map((period) => period.rows.map((row) => [row.key, row.unit, row.value])),
    [
      ["110492.5", "24356.3", "16006.3", "26991.9", "1835.7"],
      ["108770.0", "24191.7", "15883.3", "26257.5", "1777.3"],
    ].map((values) => values.map((value, i) => [`nbs.${["copper", "aluminum", "lead", "zinc", "sulfuric_acid"][i]}`, "吨", value])),
  );
  assert.ok(periods.every((period) => period.held.length === 0));
});
