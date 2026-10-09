import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, beforeEach, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { MetalPrices } from "@amp/contracts/http/public";
import { loadMetalPrices } from "../packages/backend/src/publication/metal-prices/read.ts";
import { parseMetalPriceRegistry } from "../packages/backend/src/publication/metal-prices/registry.ts";
import { nbsFetcher, NBS_LIST_URL } from "../packages/backend/src/publication/metal-prices/nbs.ts";
import { worldbankFetcher, WORLDBANK_LIST_URL } from "../packages/backend/src/publication/metal-prices/worldbank.ts";
import { storePeriod } from "../packages/backend/src/publication/metal-prices/store.ts";
import { buildApp } from "../apps/api/src/app.ts";

const sql = dbOf("publication"),
  NOW = new Date("2026-10-06T04:00:00Z");
const raw = JSON.parse(readFileSync(new URL("../industry/metal-prices.json", import.meta.url), "utf8"));
const registry = parseMetalPriceRegistry(raw);
const fixture = (file: string) => readFileSync(new URL(`./fixtures/metal-prices/${file}`, import.meta.url));
const quote = (data: MetalPrices, key: string) => data.metals.flatMap((m) => m.quotes).find((q) => q.key === key)!;
const read = (date = NOW, data: unknown = raw) => loadMetalPrices(date, data);
after(() => closeDb());
beforeEach(async () => {
  await sql`TRUNCATE publication.metal_prices`;
});
async function seed(key: string, start: string, end: string, value: string, change: Record<string, unknown> = {}) {
  const item = registry.items.find((i) => i.key === key)!,
    source = registry.sources.find((s) => s.key === item.source)!;
  const row = {
    series_key: key,
    source: source.key,
    name_zh: item.name,
    benchmark: item.benchmark,
    unit: item.unit,
    source_unit: item.sourceUnit,
    currency: source.currency,
    period_type: source.frequency,
    period_start: start,
    period_end: end,
    period_label: `${start.slice(0, 4)}年${start.slice(5, 7)}期`,
    value,
    release_label: "Synthetic release",
    release_url: source.officialUrl,
    released_on: end,
    first_fetched_at: NOW,
    fetched_at: NOW,
    ...change,
  };
  await sql`INSERT INTO publication.metal_prices ${sql(row)}`;
}

test("recorded bureau and World Bank periods retain decimal text, units and adjacent comparisons", async () => {
  const list = fixture("nbs/list.html").toString(),
    early = fixture("nbs/release-previous.html").toString(),
    mid = fixture("nbs/release-latest.html").toString();
  const nbs = nbsFetcher(registry, async (url) => ({ url, status: 200, text: () => (url === NBS_LIST_URL ? list : url.includes("1965293") ? early : mid) }));
  const wb = worldbankFetcher(registry, async (url) => ({
    url,
    status: 200,
    text: () => fixture("worldbank/commodity-markets.html").toString(),
    ...(url === WORLDBANK_LIST_URL ? {} : { body: fixture("worldbank/monthly.xlsx") }),
  }));
  for (const fetcher of [nbs, wb])
    for (const period of await fetcher.fetch(async () => (fetcher === nbs ? "2026-09-01" : null), { now: NOW, fetchedAt: async () => null })) {
      const source = registry.sources.find((s) => s.key === period.source)!;
      await storePeriod(
        source,
        registry.items.filter((i) => i.enabled && i.source === source.key),
        period,
        NOW,
      );
    }
  const data = await read();
  MetalPrices.parse(data);
  for (const [metal, value, percent] of [
    ["copper", "108770.0", "-1.6"],
    ["aluminum", "24191.7", "-0.7"],
    ["lead", "15883.3", "-0.8"],
    ["zinc", "26257.5", "-2.7"],
    ["sulfuric_acid", "1777.3", "-3.2"],
  ]) {
    const q = quote(data, `nbs.${metal}`);
    assert.deepEqual([q.value, q.unit, q.currency, q.change?.percent], [value, "元/吨", "CNY", percent]);
  }
  const copper = data.metals.find((m) => m.key === "copper")!;
  assert.ok(copper.quotes.findIndex((q) => q.key === "nbs.copper") < copper.quotes.findIndex((q) => q.key === "wb.copper"));
  assert.ok(quote(data, "wb.copper").change?.previous.value);
  assert.equal(quote(data, "wb.copper").period?.label, "2026年9月");
  assert.equal(data.latest.find((p) => p.tag === "旬")?.label, "9月中旬");
});

test("same-period revisions use deterministic tie-breaks; empty and stale source states never invent a price", async () => {
  const empty = await read();
  assert.ok(empty.sources.every((s) => s.status === "empty" && s.latest === null));
  assert.ok(empty.metals.every((m) => m.quotes.every((q) => q.value === null && q.period === null && q.change === null)));
  await seed("nbs.copper", "2026-09-11", "2026-09-20", "100.0", { release_label: "A", released_on: "2026-09-21" });
  await seed("nbs.copper", "2026-09-11", "2026-09-20", "101.0", { release_label: "B", released_on: "2026-09-22" });
  await seed("nbs.copper", "2026-09-11", "2026-09-20", "102.0", { release_label: "C", released_on: "2026-09-22" });
  assert.equal(quote(await read(), "nbs.copper").value, "102.0");
  await seed("nbs.copper", "2026-09-11", "2026-09-20", "103.0", {
    release_label: "Older title, newer revision",
    first_fetched_at: new Date(NOW.getTime() + 1000),
  });
  assert.equal(quote(await read(), "nbs.copper").value, "103.0");
  for (const [date, status] of [
    ["2026-10-10T15:59:59Z", "fresh"],
    ["2026-10-10T16:00:00Z", "stale"],
  ])
    assert.equal((await read(new Date(date))).sources.find((s) => s.key === "nbs")?.status, status);
  const disabled = structuredClone(raw);
  disabled.items.find((i: { key: string }) => i.key === "nbs.copper").enabled = false;
  assert.ok(!quote(await read(NOW, disabled), "nbs.copper"));
  assert.equal((await read(NOW, disabled)).sources.find((s) => s.key === "nbs")?.status, "empty");
});

test("numeric comparisons round away from zero, require adjacent periods and reject corrupt current units", async () => {
  for (const [key, value, expected] of [
    ["nbs.copper", "100.05", "0.1"],
    ["nbs.aluminum", "99.95", "-0.1"],
    ["nbs.zinc", "99.96", "0.0"],
  ]) {
    await seed(key, "2026-09-01", "2026-09-10", "100.00");
    await seed(key, "2026-09-11", "2026-09-20", value);
    assert.equal(quote(await read(), key).change?.percent, expected);
  }
  await seed("wb.copper", "2026-08-01", "2026-08-31", "10");
  await seed("wb.copper", "2026-09-01", "2026-09-30", "12");
  assert.equal(quote(await read(), "wb.copper").change?.percent, "20.0");
  await sql`UPDATE publication.metal_prices SET unit='Synthetic different unit' WHERE series_key='nbs.copper' AND period_start='2026-09-01'`;
  assert.equal(quote(await read(), "nbs.copper").change, null);
  await sql`DELETE FROM publication.metal_prices WHERE series_key='wb.copper' AND period_start='2026-08-01'`;
  assert.equal(quote(await read(), "wb.copper").change, null);
  await sql`UPDATE publication.metal_prices SET currency='USD' WHERE series_key='nbs.aluminum' AND period_start='2026-09-11'`;
  await assert.rejects(read(), /unit\/currency mismatch/);
});

test("latest groups, notes and footnote numbering follow enabled registry order without fixed source totals", async () => {
  await seed("wb.gold", "2026-09-01", "2026-09-30", "50", { period_label: "2026年9月" });
  await seed("wb.silver", "2026-08-01", "2026-08-31", "20", { period_label: "2026年8月" });
  const data = await read();
  assert.equal(data.latest.find((p) => p.tag === "月")?.label, "9月");
  assert.deepEqual(data.latest.find((p) => p.tag === "月")?.extras, [{ metals: ["银"], label: "8月", stale: false }]);
  assert.equal((await read(new Date("2027-01-01T00:00:00Z"))).latest.find((p) => p.tag === "月")?.label, "2026年9月");
  const refs = data.notes.filter((n) => n.ref !== null).map((n) => n.ref);
  assert.deepEqual(
    refs,
    refs.map((_n, i) => i + 1),
  );
  assert.equal(quote(data, "wb.gold").footnote, quote(data, "wb.platinum").footnote);
  assert.ok(!data.notes.some((n) => /\{tags\}|\{compare\}/.test(n.text)));
  const limited = structuredClone(raw);
  limited.notes.push({ text: "Should not appear", sources: ["imf"] }, { text: "One enabled source is enough", sources: ["nbs", "imf"] });
  const got = await read(NOW, limited);
  assert.ok(!got.notes.some((n) => n.text === "Should not appear"));
  assert.ok(got.notes.some((n) => n.text === "One enabled source is enough"));
  assert.ok(got.notes.some((n) => n.text.includes("转自国家统计局网站")));
});

test("daily conversion uses matching rates, skips missing-rate dates and compares the previous available pricing day", async () => {
  const enabled = structuredClone(raw);
  enabled.sources.find((s: { key: string }) => s.key === "cbr").enabled = true;
  for (const [day, price] of [
    ["2026-10-02", "100"],
    ["2026-10-05", "101"],
    ["2026-10-06", "200"],
  ]) {
    await seed("cbr.gold", day, day, price, { period_label: `${day} synthetic pricing day` });
    if (day !== "2026-10-06") await seed("cbr.usd", day, day, "10");
  }
  const data = await read(NOW, enabled),
    gold = quote(data, "cbr.gold");
  assert.match(gold.value!, /^314\.145115680*$/);
  assert.deepEqual([gold.period?.start, gold.unit, gold.currency, gold.change?.percent], ["2026-10-05", "美元/盎司", "USD", "1.0"]);
  assert.equal(gold.change?.previous.period.start, "2026-10-02", "weekends do not require an invented daily record");
  assert.match(gold.change!.previous.value, /^311\.0347680*$/);
  assert.ok(!data.metals.some((m) => m.quotes.some((q) => q.key === "cbr.usd")));
  assert.equal(data.metals.find((m) => m.key === "gold")!.quotes[0]!.key, "cbr.gold");
  await seed("cbr.gold", "2026-10-07", "2026-10-07", "102");
  await seed("cbr.usd", "2026-10-07", "2026-10-07", "10");
  assert.equal(quote(await read(NOW, enabled), "cbr.gold").change?.previous.period.start, "2026-10-05");
  await sql`UPDATE publication.metal_prices SET unit='Synthetic wrong rate unit' WHERE series_key='cbr.usd' AND period_start='2026-10-07'`;
  await assert.rejects(read(NOW, enabled), /unit\/currency mismatch/);
});

test("site-only price HTTP matches the reader, ignores generation time in ETags, and fails uncached on wrong units", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW.getTime() });
  await seed("nbs.copper", "2026-09-11", "2026-09-20", "100.0");
  const app = await buildApp("public-api");
  t.after(() => app.close());
  const first = await app.inject({ method: "GET", url: "/api/site/metal-prices" });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json(), await read());
  assert.equal(first.headers["cache-control"], "public, max-age=300, s-maxage=300");
  const etag = first.headers.etag!;
  assert.match(etag, /^W\/"metals-/);
  t.mock.timers.tick(1000);
  const unchanged = await app.inject({ method: "GET", url: "/api/site/metal-prices", headers: { "if-none-match": etag } });
  assert.equal(unchanged.statusCode, 304);
  assert.equal(unchanged.body, "");
  await sql`UPDATE publication.metal_prices SET unit='Synthetic mismatch' WHERE series_key='nbs.copper'`;
  const failed = await app.inject({ method: "GET", url: "/api/site/metal-prices", headers: { "if-none-match": etag } });
  assert.equal(failed.statusCode, 503);
  assert.match(String(failed.headers["cache-control"]), /no-store/);
});
