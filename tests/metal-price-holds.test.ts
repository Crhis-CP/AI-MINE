// A metal price held back alone after a jump (DEC-78补充·五项决定 item 4), as readers and the owner see it: the page keeps
// the last value that went in and marks the quote 待下期确认 through its footnote (the public contract is unchanged), and
// the daily digest carries an informational item, not the period-blocked one. Synthetic rows in a temporary database.
import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, beforeEach, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { metalFindings } from "../modules/metals/backend/alerts.ts";
import { HELD_MARK, loadMetalPrices } from "../modules/metals/backend/read.ts";
import { parseMetalPriceRegistry } from "../modules/metals/backend/registry.ts";
import { HELD_MARK as PAGE_MARK, isHeld } from "../modules/metals/web/quotes.ts";

const NOW = new Date("2026-10-06T04:00:00Z");
const raw = JSON.parse(readFileSync(new URL("../industry/metal-prices.json", import.meta.url), "utf8"));
const registry = parseMetalPriceRegistry(raw);
after(() => closeDb());
beforeEach(async () => {
  await sql`TRUNCATE publication.metal_prices, publication.metal_price_holds, job_runs`;
});

/** A stored price of a registered series, as the refresh writes it. */
async function price(key: string, start: string, end: string, label: string, value: string) {
  const item = registry.items.find((i) => i.key === key)!;
  const source = registry.sources.find((s) => s.key === item.source)!;
  await sql`INSERT INTO publication.metal_prices ${sql({
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
    period_label: label,
    value,
    release_label: `${label}合成版本`,
    release_url: source.officialUrl,
    released_on: end,
    first_fetched_at: NOW,
    fetched_at: NOW,
  })}`;
}
/** An open hold of the series' value in the period. */
async function hold(key: string, start: string, end: string, label: string, value: string, was: string) {
  const item = registry.items.find((i) => i.key === key)!;
  const source = registry.sources.find((s) => s.key === item.source)!;
  await sql`INSERT INTO publication.metal_price_holds ${sql({
    source: source.key,
    series_key: key,
    period_start: start,
    period_end: end,
    period_label: label,
    release_label: `${label}合成版本`,
    release_url: source.officialUrl,
    released_on: end,
    value,
    compared_value: was,
    reason: `${key} 是 ${value}，是上一期 ${was} 的 2.00 倍，超出 0.67–1.5 倍`,
    held_at: NOW,
    held_by: "metals.prices",
  })}`;
}
const quotes = (prices: Awaited<ReturnType<typeof loadMetalPrices>>) => prices.metals.flatMap((metal) => metal.quotes);
const footnote = (prices: Awaited<ReturnType<typeof loadMetalPrices>>, key: string) => {
  const ref = quotes(prices).find((quote) => quote.key === key)!.footnote;
  return prices.notes.find((note) => note.ref === ref) ?? null;
};

test("the page and the API keep the last value of a held quote and mark it through its footnote, with no invented number", async () => {
  assert.equal(PAGE_MARK, HELD_MARK);
  for (const key of ["nbs.copper", "nbs.zinc"]) await price(key, "2026-09-01", "2026-09-10", "2026年9月上旬", key === "nbs.copper" ? "100" : "50");
  await price("nbs.zinc", "2026-09-11", "2026-09-20", "2026年9月中旬", "51");
  await hold("nbs.copper", "2026-09-11", "2026-09-20", "2026年9月中旬", "200", "100");
  const prices = await loadMetalPrices(NOW, raw);
  const copper = quotes(prices).find((quote) => quote.key === "nbs.copper")!;
  const zinc = quotes(prices).find((quote) => quote.key === "nbs.zinc")!;
  // The last value that went in, its own period and comparison: the held 200 appears nowhere.
  assert.deepEqual([copper.value, copper.period?.label, copper.change], ["100", "2026年9月上旬", null]);
  assert.equal(JSON.stringify(prices).includes('"200"'), false);
  assert.equal(
    footnote(prices, "nbs.copper")?.text,
    "待下期确认：2026年9月中旬公布的这一报价较上一期变动超出常规范围，暂不更新，这里仍是上一期已核对的数值；下一期公布后自动确认或更正。",
  );
  assert.deepEqual([isHeld(prices, copper), isHeld(prices, zinc)], [true, false]);
  assert.deepEqual([zinc.value, zinc.period?.label, zinc.footnote], ["51", "2026年9月中旬", null]);
  // Released (or discarded), the mark goes.
  await sql`UPDATE publication.metal_price_holds SET status = 'released', decided_at = ${NOW}, decided_by = 'metals.prices', decision = '确认', decided_period = '2026年9月下旬'`;
  const after = await loadMetalPrices(NOW, raw);
  assert.equal(isHeld(after, quotes(after).find((quote) => quote.key === "nbs.copper")!), false);
  assert.equal(
    after.notes.some((note) => note.text.startsWith(HELD_MARK)),
    false,
  );
});

test("a held quote's registered footnote follows the mark with its link; others sharing it keep the plain one; a held rate marks its conversions", async () => {
  for (const key of ["wb.copper", "wb.aluminum"]) await price(key, "2026-08-01", "2026-08-31", "2026年8月", "9000");
  await hold("wb.copper", "2026-09-01", "2026-09-30", "2026年9月", "19000", "9000");
  await price("cbr.gold", "2026-10-05", "2026-10-05", "2026年10月5日", "10000");
  await price("cbr.usd", "2026-10-05", "2026-10-05", "2026年10月5日", "80");
  await hold("cbr.usd", "2026-10-06", "2026-10-06", "2026年10月6日", "160", "80");
  const prices = await loadMetalPrices(NOW, raw);
  const lme = registry.footnotes.find((note) => note.key === "lme")!;
  assert.match(footnote(prices, "wb.copper")!.text, new RegExp(`^${HELD_MARK}：2026年9月公布的.*${lme.text.slice(0, 10)}`));
  assert.equal(footnote(prices, "wb.aluminum")!.text, lme.text);
  const gold = quotes(prices).find((quote) => quote.key === "cbr.gold")!;
  assert.equal(isHeld(prices, gold), true);
  assert.deepEqual(footnote(prices, "cbr.gold")!.link, registry.footnotes.find((note) => note.key === "cbr")!.link);
  assert.equal(isHeld(prices, quotes(prices).find((quote) => quote.key === "cbr.silver")!), true);
});

test("an open hold is an informational digest item, not the period-blocked alert; none open, no item", async () => {
  assert.equal(
    (await metalFindings(NOW.getTime())).some((finding) => finding.key === "metals.hold"),
    false,
  );
  await price("nbs.copper", "2026-09-01", "2026-09-10", "2026年9月上旬", "100");
  await hold("nbs.copper", "2026-09-11", "2026-09-20", "2026年9月中旬", "200", "100");
  const findings = await metalFindings(NOW.getTime());
  const item = findings.find((finding) => finding.key === "metals.hold")!;
  assert.equal(item.level, "digest");
  assert.equal(item.title, "金属价格有 1 个报价跳变较大，单独扣下等下一期确认");
  assert.equal(item.action, "不用处理，仅供知悉");
  assert.match(item.detail!, /nbs\.copper 2026年9月中旬 200（比较值 100，/);
  assert.equal(
    findings.some((finding) => finding.key === "metals.fetch"),
    false,
  );
});
