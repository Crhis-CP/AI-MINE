// TASK-0572: the RMB central parity as a rate source, and the domestic 元/吨 quotes shown also in 美元/吨. The parity
// pages are official recordings (tests/fixtures/metal-prices/safe, see the README there); no test requests the network.
import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, beforeEach, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { MetalPrices } from "@amp/contracts/http/public";
import { loadMetalPrices } from "../modules/metals/backend/read.ts";
import { refreshMetalPrices } from "../modules/metals/backend/refresh.ts";
import { loadMetalPriceRegistry, parseMetalPriceRegistry } from "../modules/metals/backend/registry.ts";
import { SAFE_PARITY_URL, safeFetcher, safeParityDays } from "../modules/metals/backend/safe.ts";
import type { PageGetter } from "../modules/metals/backend/types.ts";

const raw = JSON.parse(readFileSync(new URL("../industry/metal-prices.json", import.meta.url), "utf8"));
const registry = loadMetalPriceRegistry();
const page = (name: "latest" | "holiday") => readFileSync(new URL(`./fixtures/metal-prices/safe/${name}.html`, import.meta.url), "utf8");
const serve =
  (html: string, override: Partial<{ status: number; url: string }> = {}): PageGetter =>
  async (url) => ({ status: 200, url, ...override, text: () => html });
const NOW = new Date("2026-11-06T03:00:00Z"); // 11:00 in Beijing, after the 9:15 fixing
const context = { now: NOW, fetchedAt: async () => null };

after(() => closeDb());
beforeEach(async () => {
  await sql`TRUNCATE publication.metal_prices, publication.metal_price_checks, publication.metal_price_holds`;
});

test("the parity is registered as an enabled, never displayed rate in 元/100美元 and NBS and MOFCOM quotes carry the 美元/吨 conversion", () => {
  const source = registry.sources.find((s) => s.key === "safe")!;
  assert.deepEqual(
    [source.name, source.section, source.frequency, source.currency, source.enabled, source.hosts, source.officialUrl],
    ["国家外汇管理局", "domestic", "day", "CNY", true, ["www.safe.gov.cn"], "https://www.safe.gov.cn/safe/rmbhlzjj/index.html"],
  );
  assert.match(source.delay, /9:15/);
  assert.ok(source.attribution.some((line) => line.includes("信息来源：国家外汇管理局网站")));
  const rate = registry.items.find((i) => i.key === "safe.usd")!;
  assert.deepEqual(
    [rate.rate, rate.sourceName, rate.unit, rate.sourceUnit, rate.benchmark, rate.metal, rate.secondary],
    [true, "美元", "元/100美元", "元/100美元", "人民币汇率中间价", null, null],
  );
  const usd = { rate: "safe.usd", factor: "100", unit: "美元/吨", currency: "USD", decimals: 0, withinDays: 14 };
  for (const item of registry.items.filter((i) => i.source === "nbs" || i.source === "mofcom")) assert.deepEqual(item.secondary, usd, item.key);
  // Precious metals stay in 美元/盎司 and base metals in 美元/吨: nothing else is converted a second time.
  for (const item of registry.items.filter((i) => !["nbs", "mofcom"].includes(i.source))) assert.equal(item.secondary, null, item.key);
});

test("a bad conversion entry rejects the whole registry and names the field", () => {
  const edit = (change: (copy: typeof raw) => void) => {
    const copy = structuredClone(raw);
    change(copy);
    return () => parseMetalPriceRegistry(copy);
  };
  const nbs = (copy: typeof raw) => copy.sources.find((s: { key: string }) => s.key === "nbs");
  assert.throws(
    edit((c) => (nbs(c).secondary.rate = "nbs.copper")),
    /sources\.0\.secondary\.rate/,
  );
  assert.throws(
    edit((c) => (nbs(c).secondary.rate = "cbr.usd")),
    /secondary\.rate/,
    "a ruble rate cannot convert a yuan price",
  );
  assert.throws(
    edit((c) => (nbs(c).secondary.currency = "CNY")),
    /secondary\.currency/,
  );
  assert.throws(
    edit((c) => (c.items.find((i: { key: string }) => i.key === "safe.usd").secondary = nbs(c).secondary)),
    /items\.\d+\.secondary/,
  );
  assert.throws(
    edit((c) => (c.items.find((i: { key: string }) => i.key === "cbr.gold").secondary = nbs(c).secondary)),
    /secondary/,
  );
  assert.throws(
    edit((c) => (nbs(c).secondary.withinDays = 40)),
    /withinDays/,
  );
  assert.throws(
    edit((c) => (nbs(c).secondary.rate = "safe.eur")),
    /sources\.0\.secondary\.rate/,
    "a missing rate of a registered source is a typo",
  );
  // A registry narrowed to the bureau alone (as other tests read it) leaves the parity out and converts nothing.
  const narrowed = {
    ...structuredClone(raw),
    sources: raw.sources.filter((s: { key: string }) => s.key === "nbs"),
    items: raw.items.filter((i: { source: string }) => i.source === "nbs"),
  };
  assert.doesNotThrow(() => parseMetalPriceRegistry(narrowed));
});

test("the recorded business-day page lists ten trading days with the dollar column as written", () => {
  const days = safeParityDays(page("latest"), "美元");
  assert.deepEqual(
    [...days],
    [
      ["2026-11-06", "671.68"],
      ["2026-11-05", "671.56"],
      ["2026-11-04", "671.8"],
      ["2026-11-03", "671.5"],
      ["2026-11-02", "671.46"],
      ["2026-10-30", "671.38"],
      ["2026-10-29", "671.47"],
      ["2026-10-28", "671.65"],
      ["2026-10-27", "671.71"],
      ["2026-10-26", "671.62"],
    ],
  );
  assert.throws(() => safeParityDays("<html><body><p>维护中</p></body></html>", "美元"), /InfoTable/);
  assert.throws(() => safeParityDays(page("latest").replace(">日期<", ">交易日<"), "美元"), /日期/);
  assert.throws(() => safeParityDays(page("latest"), "瑞郎"), /“瑞郎”列有 0 个/);
});

test("the recorded holiday page has no parity for the National Day closure: no day is invented", () => {
  const days = safeParityDays(page("holiday"), "美元");
  assert.deepEqual([...days.keys()], ["2026-10-12", "2026-10-09", "2026-10-08", "2026-09-30", "2026-09-29", "2026-09-28"]);
  assert.equal(days.get("2026-09-30"), "673.51");
  assert.equal(days.get("2026-10-08"), "673.67");
});

test("the fetcher takes every listed day on its first run, then the stored newest day on, and refuses other pages", async () => {
  const fetcher = safeFetcher(registry, serve(page("latest")));
  const first = await fetcher.fetch(async () => null, context);
  assert.deepEqual(
    first.map((one) => one.period.start),
    ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"],
  );
  const newest = first.at(-1)!;
  assert.deepEqual(newest.period, { start: "2026-11-06", end: "2026-11-06", label: "2026年11月6日" });
  assert.deepEqual(newest.release, {
    label: "国家外汇管理局 人民币汇率中间价 2026-11-06",
    url: "https://www.safe.gov.cn/safe/rmbhlzjj/index.html",
    releasedOn: "2026-11-06",
  });
  assert.deepEqual(newest.rows, [{ key: "safe.usd", unit: "元/100美元", value: "671.68" }]);
  assert.ok(first.every((one) => one.held.length === 0));
  const later = await fetcher.fetch(async () => "2026-11-05", context);
  assert.deepEqual(
    later.map((one) => one.period.start),
    ["2026-11-05", "2026-11-06"],
  );
  await assert.rejects(
    safeFetcher(registry, serve(page("latest"), { status: 503 })).fetch(async () => null, context),
    /HTTP 503/,
  );
  await assert.rejects(
    safeFetcher(registry, serve(page("latest"), { url: "https://www.safe.gov.cn/" })).fetch(async () => null, context),
    /跳转/,
  );
  // A changed basis (per dollar rather than per 100) or a blank cell holds that day back.
  assert.equal(page("latest").split("671.68").length, 2, "the 6 November dollar cell is the only 671.68 on the page");
  const changed = await safeFetcher(registry, serve(page("latest").replace("671.68", "6.7168"))).fetch(async () => "2026-11-06", context);
  assert.match(changed[0]!.held.join(), /不像每 100 美元的人民币数/);
  const blank = await safeFetcher(registry, serve(page("latest").replace("671.68", "-"))).fetch(async () => "2026-11-06", context);
  assert.match(blank[0]!.held.join(), /不是数字/);
});

/** NBS, MOFCOM and the parity only, as a deployment with just these sources enabled. */
const domestic = () => ({
  ...structuredClone(raw),
  sources: raw.sources.filter((s: { key: string }) => ["nbs", "mofcom", "safe"].includes(s.key)),
  items: raw.items.filter((i: { source: string }) => ["nbs", "mofcom", "safe"].includes(i.source)),
});
async function seed(key: string, start: string, end: string, value: string) {
  const item = registry.items.find((i) => i.key === key)!,
    source = registry.sources.find((s) => s.key === item.source)!;
  await sql`INSERT INTO publication.metal_prices ${sql({
    series_key: key,
    source: source.key,
    name_zh: item.name,
    grade: item.grade,
    benchmark: item.benchmark,
    unit: item.unit,
    source_unit: item.sourceUnit,
    currency: source.currency,
    period_type: source.frequency,
    period_start: start,
    period_end: end,
    period_label: `合成 ${start}–${end}`,
    value,
    release_label: `合成 ${end}`,
    release_url: source.officialUrl,
    released_on: end,
    first_fetched_at: NOW,
    fetched_at: NOW,
  })}`;
}
const quotes = (data: MetalPrices) => new Map(data.metals.flatMap((metal) => metal.quotes).map((quote) => [quote.key, quote]));

test("the parity goes in through the scheduled refresh and converts a 元/吨 quote with the parity of its own date, else the latest before", async () => {
  const runs = await refreshMetalPrices({ registry: domestic(), source: "safe", get: serve(page("latest")), now: NOW });
  assert.equal(runs.safe!.ok, true, JSON.stringify(runs.safe));
  assert.equal(runs.safe!.inserted, 10);
  // Read again with nothing new: only the stored newest day is checked, nothing more goes in.
  const again = await refreshMetalPrices({ registry: domestic(), source: "safe", get: serve(page("latest")), now: NOW });
  assert.equal(again.safe!.inserted, 0);
  // The ten days of 2026年10月下旬 end on Saturday 31 October: no parity that day, Friday's (671.38) is used.
  await seed("nbs.copper", "2026-10-21", "2026-10-31", "91470");
  // A weekly date on a trading day uses that day's parity (4 November, 671.8).
  await seed("mofcom.copper", "2026-11-04", "2026-11-04", "91234.5");
  // Before the first stored parity (26 October) by more than the window: no conversion, never a later parity.
  await seed("nbs.aluminum", "2026-10-01", "2026-10-10", "20750");
  await seed("mofcom.zinc", "2026-10-09", "2026-10-09", "22500");
  const data = MetalPrices.parse(await loadMetalPrices(NOW, domestic()));
  const all = quotes(data);
  const copper = all.get("nbs.copper")!;
  assert.deepEqual([copper.value, copper.unit, copper.currency], ["91470", "元/吨", "CNY"], "the published price stays first and unchanged");
  // 91470 × 100 ÷ 671.38 = 13624.47… → 13624 (whole dollars).
  assert.deepEqual(copper.converted, {
    value: "13624",
    unit: "美元/吨",
    currency: "USD",
    rate: { source: "safe", name: "人民币汇率中间价", date: "2026-10-30", label: "2026年10月30日" },
  });
  // 91234.5 × 100 ÷ 671.8 = 13580.6… → 13581 (half up from .6).
  assert.deepEqual(all.get("mofcom.copper")!.converted, {
    value: "13581",
    unit: "美元/吨",
    currency: "USD",
    rate: { source: "safe", name: "人民币汇率中间价", date: "2026-11-04", label: "2026年11月4日" },
  });
  assert.equal(all.get("nbs.aluminum")!.converted, null, "the window holds no parity: none is guessed");
  assert.equal(all.get("mofcom.zinc")!.converted, null, "a parity published after the quote's date is never used");
  // Quotes without a price carry no conversion either.
  assert.equal(all.get("nbs.lead")!.value, null);
  assert.equal(all.get("nbs.lead")!.converted, null);
  // The parity source is listed for attribution with its newest day, and is never a quote of its own.
  const parity = data.sources.find((s) => s.key === "safe")!;
  assert.deepEqual([parity.name, parity.tag, parity.status, parity.latest?.label], ["国家外汇管理局", "日", "fresh", "2026年11月6日"]);
  assert.ok(!all.has("safe.usd"));
  assert.ok(data.notes.some((note) => note.text.includes("约 X 美元/吨") && note.link?.url === "https://www.safe.gov.cn/safe/rmbhlzjj/index.html"));
});

test("an exact holiday window: a quote on the first day after National Day uses that day's parity, one inside the closure the last before it", async () => {
  // Store the holiday page's six days as if they had been read day by day.
  const fetched = await safeFetcher(registry, serve(page("holiday"))).fetch(async () => null, { ...context, now: new Date("2026-10-12T03:00:00Z") });
  const runs = await refreshMetalPrices({
    registry: domestic(),
    source: "safe",
    now: new Date("2026-10-12T03:00:00Z"),
    fetchers: { safe: () => ({ sourceKeys: ["safe"], fetch: async () => fetched }) },
  });
  assert.equal(runs.safe!.inserted, 6, JSON.stringify(runs.safe));
  await seed("mofcom.copper", "2026-10-08", "2026-10-08", "88000");
  await seed("mofcom.aluminum", "2026-10-05", "2026-10-05", "20000");
  // 27 October is 15 days after the newest stored parity (12 October): outside the 14-day window, so not converted.
  await seed("mofcom.zinc", "2026-10-27", "2026-10-27", "22500");
  const all = quotes(MetalPrices.parse(await loadMetalPrices(new Date("2026-10-28T03:00:00Z"), domestic())));
  assert.equal(all.get("mofcom.zinc")!.converted, null);
  // 88000 × 100 ÷ 673.67 = 13062.8… → 13063
  assert.deepEqual([all.get("mofcom.copper")!.converted?.value, all.get("mofcom.copper")!.converted?.rate.date], ["13063", "2026-10-08"]);
  // 20000 × 100 ÷ 673.51 = 2969.5… → 2970, with 30 September's parity (the 5th is inside the closure)
  assert.deepEqual([all.get("mofcom.aluminum")!.converted?.value, all.get("mofcom.aluminum")!.converted?.rate.date], ["2970", "2026-09-30"]);
});

test("other units are left alone: precious metals in 美元/盎司 and base metals in 美元/吨 carry no conversion, and a stopped parity converts nothing", async () => {
  await refreshMetalPrices({ registry: domestic(), source: "safe", get: serve(page("latest")), now: NOW });
  await seed("nbs.copper", "2026-10-21", "2026-10-31", "91470");
  await seed("wb.copper", "2026-10-01", "2026-10-31", "9800.5");
  await seed("wb.gold", "2026-10-01", "2026-10-31", "3990.12");
  const data = MetalPrices.parse(await loadMetalPrices(NOW, raw));
  const all = quotes(data);
  assert.deepEqual([all.get("wb.copper")!.unit, all.get("wb.copper")!.currency, "converted" in all.get("wb.copper")!], ["美元/吨", "USD", false]);
  assert.deepEqual([all.get("wb.gold")!.unit, all.get("wb.gold")!.currency, "converted" in all.get("wb.gold")!], ["美元/盎司", "USD", false]);
  for (const key of ["cbr.gold", "cochilco.copper"]) assert.equal("converted" in all.get(key)!, false, key);
  assert.equal(all.get("nbs.copper")!.converted?.value, "13624");
  // With the parity source stopped the domestic quote shows only its published price, and the source is not listed.
  const stopped = structuredClone(raw);
  stopped.sources.find((s: { key: string }) => s.key === "safe").enabled = false;
  stopped.items.find((i: { key: string }) => i.key === "safe.usd").enabled = false;
  const without = MetalPrices.parse(await loadMetalPrices(NOW, stopped));
  assert.equal("converted" in quotes(without).get("nbs.copper")!, false);
  assert.ok(!without.sources.some((s) => s.key === "safe"));
  assert.ok(!without.notes.some((note) => note.text.includes("约 X 美元/吨")));
});

test("the parity URL stays on the registered host", () => {
  assert.equal(new URL(SAFE_PARITY_URL).host, "www.safe.gov.cn");
});
