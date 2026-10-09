import "./setup.ts";
import { closeDb, dbOf } from "@amp/backend/db";
import { refreshMetalPrices } from "../packages/backend/src/publication/metal-prices/refresh.ts";
import { worldbankFetcher, worldbankPeriods, WORLDBANK_LIST_URL } from "../packages/backend/src/publication/metal-prices/worldbank.ts";
import { openWorkbook, type Sheet } from "../packages/backend/src/publication/metal-prices/xlsx.ts";
import type { FetchedPeriod, PageGetter } from "../packages/backend/src/publication/metal-prices/types.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, beforeEach, test } from "node:test";
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

const sql = dbOf("publication");
after(() => closeDb());
beforeEach(async () => {
  await sql`TRUNCATE publication.metal_prices`;
});
const fixture = (name: string) => readFileSync(new URL(`./fixtures/metal-prices/worldbank/${name}`, import.meta.url));
const [html, bytes] = [fixture("commodity-markets.html").toString(), fixture("monthly.xlsx")] as const;
const NOW = new Date("2026-10-06T04:00:00Z");
const later = (days: number) => new Date(NOW.getTime() + days * 86400_000);
const wb = {
  ...raw,
  sources: raw.sources.filter((s: { key: string }) => s.key === "worldbank"),
  items: raw.items.filter((s: { source: string }) => s.source === "worldbank"),
};
const stock = worldbankFetcher(registry);
const noStored = async () => null;
const current = async () => "2026-09-01";
function pages(page = html, body = bytes, response: Partial<Awaited<ReturnType<PageGetter>>> = {}) {
  const calls: { url: string; opts: Parameters<PageGetter>[1] }[] = [];
  const get: PageGetter = async (url, opts) => {
    calls.push({ url, opts });
    return url === WORLDBANK_LIST_URL ? { url, status: 200, text: () => page } : { url, status: 200, text: () => "", body, ...response };
  };
  return { get, files: () => calls.filter((call) => call.url !== WORLDBANK_LIST_URL), calls };
}
const snapshot = () => sql`SELECT * FROM publication.metal_prices ORDER BY series_key, period_start, release_label`;
const run = async (opts: Parameters<typeof refreshMetalPrices>[0] = {}) =>
  (await refreshMetalPrices({ registry: wb, get: pages().get, now: NOW, ...opts })).worldbank;
const copied = (edit: (prices: Sheet, descriptions: Sheet) => void) => {
  const sheet = openWorkbook(bytes),
    prices = sheet("Monthly Prices"),
    descriptions = sheet("Description");
  edit(prices, descriptions);
  return (name: string) => (name === "Monthly Prices" ? prices : descriptions);
};
const release = { label: "Monthly prices October 2026 (XLS)", url: "https://thedocs.worldbank.org/CMO-Historical-Data-Monthly.xlsx", releasedOn: null };
const parse = (edit: (p: Sheet, d: Sheet) => void, newest: string | null = "2026-09-01") => worldbankPeriods(registry, copied(edit), release, newest);
const fetchers = (periods: FetchedPeriod[]) => ({ worldbank: () => ({ sourceKeys: stock.sourceKeys, fetch: async () => periods }) });

test("recorded workbook keeps raw values, full cell version, source units and adjacent calendar months", async () => {
  const get = pages();
  const periods = await worldbankFetcher(registry, get.get).fetch(noStored);
  assert.deepEqual(
    periods.map((p) => p.period),
    [
      { start: "2026-08-01", end: "2026-08-31", label: "2026年8月" },
      { start: "2026-09-01", end: "2026-09-30", label: "2026年9月" },
    ],
  );
  const latest = periods[1];
  assert.deepEqual(
    latest.rows.map((r) => [r.key, r.unit, r.value]),
    [
      ["wb.aluminum", "($/mt)", "3283"],
      ["wb.iron_ore", "($/dmtu)", "97.7"],
      ["wb.copper", "($/mt)", "14474"],
      ["wb.lead", "($/mt)", "1873"],
      ["wb.tin", "($/mt)", "53712"],
      ["wb.nickel", "($/mt)", "16324"],
      ["wb.zinc", "($/mt)", "4021"],
      ["wb.gold", "($/troy oz)", "4319"],
      ["wb.platinum", "($/troy oz)", "1784"],
      ["wb.silver", "($/troy oz)", "64.599999999999994"],
    ],
  );
  assert.equal(latest.release.label, release.label);
  assert.equal(latest.release.releasedOn, null);
  assert.deepEqual(latest.held, []);
  assert.equal(latest.heldSeries, undefined);
  assert.deepEqual(get.files()[0].opts, { maxRedirects: 0, maxBytes: 4 * 1024 * 1024 });
  const january = parse((p) => {
    p.get(807)!.set("A", "2027M01");
    p.get(806)!.set("A", "2026M12");
  }, null);
  assert.deepEqual(
    january.map((p) => p.period.start),
    ["2026-12-01", "2027-01-01"],
  );
  assert.equal(
    parse((p) => {
      p.delete(806);
    }, null).length,
    1,
  );
  assert.throws(
    () =>
      parse((p) => {
        for (const row of p.values()) row.delete("A");
      }),
    /没有月份行/,
  );
  assert.throws(
    () =>
      worldbankPeriods(
        registry,
        (name) => {
          if (name === "Description") throw new Error("missing Description");
          return openWorkbook(bytes)(name);
        },
        release,
        null,
      ),
    /missing Description/,
  );
  const dated = await worldbankFetcher(registry, pages(html.replace("October 2026", "October 02, 2026")).get).fetch(current);
  assert.equal(dated[0].release.releasedOn, "2026-10-02");
});

test("initial refresh stores two months; cached versions skip the file, seven days touch, dry-run and force bypass cache", async () => {
  assert.equal((await run()).inserted, 20);
  const original = await snapshot();
  const cached = pages();
  const skipped = await run({ get: cached.get, now: later(6) });
  assert.deepEqual([skipped.ok, skipped.note, cached.files().length], [true, "这次一期都没有返回", 0]);
  assert.deepEqual(await snapshot(), original);
  const changed = pages(html.replace("October 2026", "November 2026"));
  const newVersion = await run({ get: changed.get, now: later(1) });
  assert.deepEqual([newVersion.inserted, changed.files().length], [0, 1]);
  assert.deepEqual(await snapshot(), original);
  const due = pages();
  const refreshed = await run({ get: due.get, now: later(7) });
  assert.deepEqual([refreshed.inserted, refreshed.touched, due.files().length], [0, 10, 1]);
  assert.equal((await snapshot()).length, 20);
  const unchanged = await snapshot();
  const dry = pages();
  assert.equal((await run({ get: dry.get, dryRun: true, now: later(8) })).touched, 10);
  assert.equal(dry.files().length, 1);
  assert.deepEqual(await snapshot(), unchanged);
  const forced = pages();
  assert.equal((await run({ get: forced.get, source: "worldbank", force: { periodStart: "2026-09-01", held: ["2026年9月"] }, now: later(8) })).ok, true);
  assert.equal(forced.files().length, 1);
  const direct = pages();
  await worldbankFetcher(registry, direct.get).fetch(current);
  assert.equal(direct.files().length, 1);
});

test("description drift and explicit missing markers hold only that series, retaining its old fetched time without defeating the cache", async () => {
  await run();
  for (const marker of ["…", "..", "description"]) {
    const periods = parse((p, d) => {
      if (marker === "description") d.get(89)!.set("B", d.get(89)!.get("B")!.replaceAll("LME", "unknown"));
      else p.get(807)!.set("BM", marker);
    });
    assert.deepEqual(
      periods[0].heldSeries?.map((s) => s.key),
      ["wb.copper"],
    );
    const result = await run({ fetchers: fetchers(periods), now: later(7) });
    assert.deepEqual([result.ok, result.touched, result.periods[0].held], [false, 9, null]);
    assert.equal(
      (await sql`SELECT fetched_at FROM publication.metal_prices WHERE series_key = 'wb.copper' AND period_start = '2026-09-01'`)[0].fetched_at.toISOString(),
      NOW.toISOString(),
    );
    const get = pages();
    await run({ get: get.get, now: later(8) });
    assert.equal(get.files().length, 0);
  }
  await sql`TRUNCATE publication.metal_prices`;
  const missing = parse((p) => {
    p.get(807)!.set("BM", "…");
  });
  assert.equal((await run({ fetchers: fetchers(missing) })).inserted, 9);
});

test("bad headers, duplicate columns, units and ordinary missing values hold the whole period with no database change", async () => {
  await run();
  const before = await snapshot();
  const edits: [string, (p: Sheet) => void][] = [
    [
      "实际 0 列",
      (p) => {
        p.get(5)!.delete("BM");
      },
    ],
    [
      "实际 2 列",
      (p) => {
        p.get(5)!.set("ZZ", "Copper");
      },
    ],
    [
      "单位",
      (p) => {
        p.get(6)!.set("BM", "($/kg)");
      },
    ],
    [
      "不是数值",
      (p) => {
        p.get(807)!.set("BM", "");
      },
    ],
  ];
  for (const [reason, edit] of edits) {
    const result = await run({ fetchers: fetchers(parse(edit)) });
    assert.equal(result.ok, false);
    assert.match(result.periods[0].held!, new RegExp(reason));
    assert.deepEqual(await snapshot(), before);
  }
});

test("new versions revise the stored previous month, unchanged versions add no duplicate rows", async () => {
  const initial = await worldbankFetcher(registry, pages().get).fetch(noStored);
  assert.equal((await run({ fetchers: fetchers(initial.slice(0, 1)) })).inserted, 10);
  const revised = parse((p) => {
    p.get(806)!.set("BM", "14330");
  }, "2026-08-01").map((p) => ({ ...p, release: { ...p.release, label: "Monthly prices revised October 2026 (XLS)" } }));
  assert.deepEqual(
    revised.map((p) => p.period.start),
    ["2026-08-01", "2026-09-01"],
  );
  assert.equal((await run({ fetchers: fetchers(revised) })).inserted, 20);
  assert.equal((await snapshot()).length, 30);
  const repeated = revised.slice(-1).map((p) => ({ ...p, release: { ...p.release, label: "Monthly prices November 2026 (XLS)" } }));
  const result = await run({ fetchers: fetchers(repeated) });
  assert.deepEqual([result.inserted, result.touched], [0, 0]);
  assert.match(result.periods[0].notes.join(" "), /不另存/);
  assert.equal((await snapshot()).length, 30);
});

test("off-host links, redirects, bad statuses, oversized and unreadable files fail without writes; NBS continues", async () => {
  await run();
  const before = await snapshot();
  const bad = [
    pages(html.replaceAll("thedocs.worldbank.org", "example.com")),
    pages(html, bytes, { url: "https://example.com/a" }),
    pages(html, bytes, { status: 404 }),
    pages(html, Buffer.alloc(4 * 1024 * 1024 + 1)),
    pages(html, Buffer.from("not zip")),
    pages(html, bytes, { status: 302 }),
    pages(html.replaceAll("CMO-Historical-Data-Monthly.xlsx", "missing.xlsx")),
  ];
  for (const get of bad) {
    const result = await run({ get: get.get, now: later(7) });
    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.deepEqual(await snapshot(), before);
  }
  const nbs = (name: string) => readFileSync(new URL(`./fixtures/metal-prices/nbs/${name}.html`, import.meta.url), "utf8");
  const get: PageGetter = async (url) => ({
    url,
    status: url.startsWith("https://www.stats.gov.cn/") ? 200 : 404,
    text: () => nbs(url.endsWith("index.html") ? "list" : "release-latest"),
  });
  const result = await refreshMetalPrices({ registry: raw, get, now: NOW });
  assert.equal(result.worldbank.ok, false);
  assert.equal(result.nbs.ok, true);
  assert.equal(result.nbs.inserted, 5);
});
