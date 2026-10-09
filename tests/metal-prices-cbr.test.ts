// CBR registry, storage shape and daily refresh; recorded XML is local official capture, never a live test request.
import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, beforeEach, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { cbrFetcher } from "../packages/backend/src/publication/metal-prices/cbr.ts";
import type { PageGetter } from "../packages/backend/src/publication/metal-prices/types.ts";
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

const xmlBytes = (name: string) => readFileSync(new URL(`./fixtures/metal-prices/cbr/${name}.xml`, import.meta.url));
const decode = (bytes: Buffer) => new TextDecoder("windows-1251").decode(bytes);
const metalXml = decode(xmlBytes("metal"));
const usdXml = (date: string) => decode(xmlBytes(`usd-${date}`));
const NOW = new Date("2026-10-06T02:00:00Z"),
  EARLIER = new Date("2026-10-03T02:00:00Z");
const LIST = "https://www.cbr.ru/scripts/xml_metall.asp?date_req1=05/09/2026&date_req2=06/10/2026";
function recorded(opts: { metal?: string; usd?: Record<string, string>; status?: number; url?: string; utf8?: boolean } = {}) {
  const calls: string[] = [];
  const get: PageGetter = async (url, options) => {
    calls.push(url);
    assert.equal(options?.maxRedirects, 0);
    const date = new URL(url).searchParams.get("date_req")?.split("/").reverse().join("-");
    const bytes = date ? xmlBytes(`usd-${date}`) : xmlBytes("metal");
    const text = date
      ? (opts.usd?.[date] ?? (opts.utf8 ? bytes.toString("utf8") : decode(bytes)))
      : (opts.metal ?? (opts.utf8 ? bytes.toString("utf8") : metalXml));
    return { url: opts.url ?? url, status: opts.status ?? 200, text: () => text };
  };
  return { get, calls };
}
const capture = async (get: PageGetter = recorded().get, now = NOW) => (await refreshMetalPrices({ registry: only(), get, now })).cbr;
const rows = () =>
  sql`SELECT series_key, value::text AS value, unit, source_unit, currency, period_type, period_start::text, period_end::text, period_label, release_label, release_url, released_on FROM publication.metal_prices ORDER BY period_start, series_key`;

test("recorded CBR XML stores the latest two fixing days as raw RUB values and source release facts", async () => {
  const get = recorded(),
    result = await capture(get.get),
    data = await rows();
  assert.deepEqual([result.ok, result.inserted, get.calls[0]], [true, 10, LIST]);
  const expected = {
    "2026-10-02": ["11143.31", "3204.64", "4636.32", "163.51", "83.4839"],
    "2026-10-05": ["11441.31", "3267.29", "4761.6", "166.66", "84.9309"],
  };
  for (const [date, values] of Object.entries(expected)) {
    const period = data.filter((r) => r.period_start === date),
      effective = date === "2026-10-02" ? "03" : "06";
    assert.deepEqual(
      period.map((r) => r.value),
      values,
    );
    assert.ok(period.every((r) => r.currency === "RUB" && r.period_type === "day" && r.period_end === date && r.released_on === null));
    assert.ok(period.every((r) => r.unit === (r.series_key === "cbr.usd" ? "卢布/美元" : "卢布/克") && r.source_unit === r.unit));
    assert.ok(
      period.every(
        (r) => r.period_label === `2026年10月${Number(date.slice(-2))}日定价` && r.release_label === `俄罗斯银行 2026年10月${Number(effective)}日起适用`,
      ),
    );
    assert.ok(period.every((r) => r.release_url === `https://www.cbr.ru/scripts/xml_metall.asp?date_req1=${effective}/10/2026&date_req2=${effective}/10/2026`));
  }
  assert.match(usdXml("2026-10-06"), /<Name>Доллар США<\/Name>/);
  const parser = cbrFetcher(parseMetalPriceRegistry(only()), recorded().get),
    fallback = cbrFetcher(parseMetalPriceRegistry(only()), recorded({ utf8: true }).get);
  assert.deepEqual(
    await parser.fetch(async () => null, { now: NOW, fetchedAt: async () => null }),
    await fallback.fetch(async () => null, { now: NOW, fetchedAt: async () => null }),
  );
});

test("incremental daily refresh rereads the stored newest day and respects midnight in Beijing", async () => {
  assert.equal((await capture(recorded().get, EARLIER)).inserted, 10);
  const next = await capture();
  assert.deepEqual([next.inserted, next.touched], [5, 5]);
  assert.deepEqual([(await capture()).inserted, (await rows()).length], [0, 15]);
  for (const [time, expected] of [
    ["2026-10-05T15:59:59Z", "2026-10-02"],
    ["2026-10-05T16:00:00Z", "2026-10-05"],
  ]) {
    const fetched = await cbrFetcher(parseMetalPriceRegistry(only()), recorded().get).fetch(async () => null, {
      now: new Date(time),
      fetchedAt: async () => null,
    });
    assert.equal(fetched.at(-1)!.period.start, expected);
  }
});

test("a mismatched effective FX date holds one day without blocking later daily fixings or refetching skipped days", async () => {
  const badLatest = await capture(recorded({ usd: { "2026-10-06": usdXml("2026-10-04") } }).get);
  assert.deepEqual([badLatest.ok, badLatest.inserted], [false, 5]);
  assert.match(badLatest.periods[1].held!, /文件日期/);
  await sql`TRUNCATE publication.metal_prices`;
  const badEarlier = await capture(recorded({ usd: { "2026-10-03": usdXml("2026-10-03").replace('Date="03.10.2026"', 'Date="04.10.2026"') } }).get);
  assert.deepEqual([badEarlier.ok, badEarlier.periods[0].held?.includes("文件日期"), badEarlier.periods[1].held, badEarlier.inserted], [false, true, null, 5]);
  const get = recorded();
  await capture(get.get);
  assert.equal(
    get.calls.some((url) => url.includes("date_req=03/10/2026")),
    false,
  );
});

test("raw-number, Buy/Sell, nominal, missing and duplicate USD defects hold a whole day without converting values", async () => {
  const edited = (replace: (row: string) => string) => metalXml.replace(/<Record Date="03\.10\.2026" Code="1">.*?<\/Record>/, replace);
  const usd = usdXml("2026-10-03"),
    match = usd.match(/<Valute\b[^>]*>.*?<CharCode>USD<\/CharCode>.*?<\/Valute>/)![0];
  const cases = [
    recorded({ metal: edited((s) => s.replace(/<Sell>.*?<\/Sell>/, "<Sell>1</Sell>")) }),
    ...["11143.31", "11 143,31"].map((value) => recorded({ metal: edited((s) => s.replace(/11143,31/g, value)) })),
    recorded({ usd: { "2026-10-03": usd.replace(/<Nominal>1<\/Nominal>/g, "<Nominal>10</Nominal>") } }),
    recorded({ usd: { "2026-10-03": usd.replace(match, "") } }),
    recorded({ usd: { "2026-10-03": usd.replace("</ValCurs>", `${match}</ValCurs>`) } }),
  ];
  for (const get of cases) {
    await sql`TRUNCATE publication.metal_prices`;
    const result = await capture(get.get);
    assert.equal(result.ok, false);
    assert.ok(result.periods[0].held);
    assert.equal(result.periods[1].held, null);
    assert.equal(result.inserted, 5);
    assert.ok((await rows()).every((r) => r.period_start === "2026-10-05"));
  }
});

test("CBR transport, XML and impossible dates fail the source before writes, while NBS continues", async () => {
  const bad = [
    recorded({ url: "https://example.com/blocked" }),
    recorded({ status: 503 }),
    recorded({ metal: "<html>verification</html>" }),
    recorded({ metal: metalXml.replace(/<Record\b[^>]*>.*?<\/Record>/g, "") }),
    recorded({ metal: metalXml.replace(/Date="\d{2}\.\d{2}\.\d{4}"/, 'Date="31.02.2026"') }),
  ];
  for (const get of bad) {
    const result = await capture(get.get);
    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.equal((await rows()).length, 0);
  }
  const nbs = (name: string) => readFileSync(new URL(`./fixtures/metal-prices/nbs/${name}.html`, import.meta.url), "utf8");
  const get: PageGetter = async (url) => ({
    url,
    status: url.startsWith("https://www.stats.gov.cn/") ? 200 : 503,
    text: () => nbs(url.endsWith("index.html") ? "list" : "release-latest"),
  });
  const selected = {
    ...raw,
    sources: raw.sources.filter((s: { key: string }) => s.key !== "worldbank").map((s: { key: string }) => ({ ...s, enabled: true })),
    items: raw.items.filter((i: { source: string }) => i.source !== "worldbank"),
  };
  const result = await refreshMetalPrices({ registry: selected, get, now: NOW });
  assert.equal(result.cbr.ok, false);
  assert.equal(result.nbs.ok, true);
  assert.equal(result.nbs.inserted, 5);
});
