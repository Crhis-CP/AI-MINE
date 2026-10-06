// Metal prices, refresh and store (TASK-0069): the bureau's pages come from the cropped fixtures by address (no network,
// no model, a fixed clock) into a temporary database. A period is stored as published or held back whole on the fetcher's
// reasons or the check's, a held new period keeps later ones waiting, a failing source fails alone, and the return value
// is the run record.
import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, beforeEach, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { refreshMetalPrices } from "@amp/backend/jobs/publication";
import { SCHEDULES } from "../apps/worker/src/schedules.ts";
import { NBS_LIST_URL, nbsFetcher } from "../packages/backend/src/publication/metal-prices/nbs.ts";
import type { MetalPricePeriodRun } from "../packages/backend/src/publication/metal-prices/refresh.ts";
import { parseMetalPriceRegistry } from "../packages/backend/src/publication/metal-prices/registry.ts";
import { storePeriod } from "../packages/backend/src/publication/metal-prices/store.ts";
import type { PageGetter } from "../packages/backend/src/publication/metal-prices/types.ts";
import type { MetalPriceSourceKey } from "../packages/backend/src/publication/metal-prices/registry.ts";
import type { FetchContext, FetchedPeriod } from "../packages/backend/src/publication/metal-prices/types.ts";

const sql = dbOf("publication");
after(() => closeDb());
beforeEach(async () => {
  await sql`TRUNCATE publication.metal_prices`;
});

const fixture = (name: string) => readFileSync(new URL(`./fixtures/metal-prices/nbs/${name}.html`, import.meta.url), "utf8");
const [list, early, mid] = ["list", "release-previous", "release-latest"].map(fixture);
const EARLY = "https://www.stats.gov.cn/sj/zxfb/202609/t20260914_1965293.html";
const MID = "https://www.stats.gov.cn/sj/zxfb/202609/t20260923_1965403.html";
const LATE = "https://www.stats.gov.cn/sj/zxfb/202610/t20261004_1965500.html";
const TAIL = "流通领域重要生产资料市场价格变动情况";
const [SEP1, SEP2, SEP3] = ["2026年9月上旬", "2026年9月中旬", "2026年9月下旬"];
const [NOW, LATER] = [new Date("2026-10-06T04:00:00Z"), new Date("2026-10-06T07:45:00Z")];
/** The list with each entry passed through `edit`: as it stood before 9月中旬, and with a 9月下旬 made from 9月中旬. */
const entries = (edit: (entry: string) => string) => list.replace(/<li>(?:(?!<\/li>)[\s\S])*<\/li>/g, edit);
const earlyList = entries((entry) => (entry.includes(SEP2) ? "" : entry));
const toLate = (entry: string) => entry.replaceAll(SEP2, SEP3).replaceAll("./202609/t20260923_1965403.html", "./202610/t20261004_1965500.html");
const lateList = entries((entry) => (entry.includes(SEP2) ? toLate(entry).replace("2026-09-24", "2026-10-04") + entry : entry));
const data: { sources: { key: string }[]; items: { key: string; source: string }[] } = JSON.parse(
  readFileSync(new URL("../industry/metal-prices.json", import.meta.url), "utf8"),
);
// Only the bureau's part: later cards add the World Bank and the IMF to the same file.
const registry = { sources: data.sources.filter((source) => source.key === "nbs"), items: data.items.filter((item) => item.source === "nbs") };
const parsed = parseMetalPriceRegistry(registry);
/** 本期价格 as the fixtures write it, by series, in the order of the bureau's table. */
const KEYS = "rebar wire_rod medium_plate hr_coil seamless_pipe angle_steel copper aluminum lead zinc".split(" ").map((key) => `nbs.${key}`);
const published = (values: string) => new Map(values.split(" ").map((value, i) => [KEYS[i], value]));
const EARLY_VALUES = published("3182.7 3367.1 3564.7 3351.6 4026.9 3469.8 110492.5 24356.3 16006.3 26991.9");
const MID_VALUES = published("3165.1 3353.7 3548.0 3308.9 4022.4 3433.1 108770.0 24191.7 15883.3 26257.5");

/** Fixtures by address; `change` swaps in edited copies. Any other address fails, as an unknown page would. */
const pages = (change: Record<string, string> = {}): PageGetter => {
  const html: Record<string, string> = { [NBS_LIST_URL]: list, [EARLY]: early, [MID]: mid, [LATE]: mid.replaceAll(SEP2, SEP3), ...change };
  return async (url) => {
    if (!(url in html)) throw new Error(`no fixture for ${url}`);
    return { status: 200, url, text: () => html[url] };
  };
};
const run = async (change: Record<string, string> = {}, now = NOW, given: unknown = registry) =>
  (await refreshMetalPrices({ registry: given, get: pages(change), now })).nbs;
function period(label: string, change: Partial<MetalPricePeriodRun> = {}): MetalPricePeriodRun {
  return { period: label, version: label + TAIL, inserted: 0, touched: 0, changed: [], held: null, notes: [], ...change };
}
const record = (ok: boolean, periods: MetalPricePeriodRun[], now = NOW) => {
  const sum = (field: "inserted" | "touched") => periods.reduce((total, one) => total + one[field], 0);
  return { ok, at: now.toISOString(), error: null, inserted: sum("inserted"), touched: sum("touched"), periods };
};
const NO_PREVIOUS = ["没有上一期"];
const COPPER_UP = { [MID]: mid.replace(">108770.0<", ">176788.0<") };
const COPPER_REASON = "nbs.copper 是 176788.0，是上一期 110492.5 的 1.60 倍，超出 0.67–1.5 倍";
const table = async () => [
  ...(await sql`SELECT series_key, period_start::text, release_label, value::text, first_fetched_at, fetched_at FROM publication.metal_prices
                ORDER BY period_start, release_label, series_key`),
];
const values = async (start: string) =>
  new Map((await sql`SELECT series_key, value::text FROM publication.metal_prices WHERE period_start = ${start}`).map((row) => [row.series_key, row.value]));

test("the first run stores the newest period alone, ten rows exactly as published; its record says there is no previous period", async () => {
  // A thousands separator written into a copy of the page is dropped, and nothing else changes.
  assert.deepEqual(await run({ [MID]: mid.replace(">108770.0<", ">108,770.0<") }), record(true, [period(SEP2, { inserted: 10, notes: NO_PREVIOUS })]));
  const rows = await sql`SELECT series_key, name_zh, grade, value::text, unit, source_unit, currency, period_type, period_start::text, period_end::text,
                                period_label, release_label, release_url, released_on::text FROM publication.metal_prices`;
  const release = { period_label: SEP2, release_label: SEP2 + TAIL, release_url: MID, released_on: "2026-09-24" };
  const fixed = { unit: "元/吨", source_unit: "吨", currency: "CNY", period_type: "ten_day", period_start: "2026-09-11", period_end: "2026-09-20", ...release };
  const expected = parsed.items.map((item) => [item.key, { name_zh: item.name, grade: item.grade, value: MID_VALUES.get(item.key), ...fixed }]);
  assert.equal(rows.length, 10);
  assert.deepEqual(Object.fromEntries(rows.map(({ series_key, ...row }) => [series_key, row])), Object.fromEntries(expected));
});

test("a later run reads the stored period again, moving only its fetched_at, and stores the new period after it", async () => {
  assert.deepEqual(await run({ [NBS_LIST_URL]: earlyList }), record(true, [period(SEP1, { inserted: 10, notes: NO_PREVIOUS })]));
  assert.deepEqual(await run({}, LATER), record(true, [period(SEP1, { touched: 10 }), period(SEP2, { inserted: 10 })], LATER));
  const times = await sql`SELECT period_start::text AS start, min(first_fetched_at) AS first, max(fetched_at) AS last FROM publication.metal_prices
                          GROUP BY 1 ORDER BY 1`;
  assert.deepEqual(
    [...times],
    [
      { start: "2026-09-01", first: NOW, last: LATER },
      { start: "2026-09-11", first: LATER, last: LATER },
    ],
  );
  assert.deepEqual([await values("2026-09-01"), await values("2026-09-11")], [EARLY_VALUES, MID_VALUES]);
});

test("a value changed in the same version replaces the old one, before and after recorded; a new version is a row beside the old one", async () => {
  await run();
  const changed = [{ key: "nbs.copper", before: "108770.0", after: "108800.0" }];
  const copper = { [MID]: mid.replace(">108770.0<", ">108800.0<") };
  assert.deepEqual(await run(copper, LATER), record(true, [period(SEP2, { touched: 9, changed, notes: NO_PREVIOUS })], LATER));
  assert.equal((await values("2026-09-11")).get("nbs.copper"), "108800.0");
  // The bureau's titles name the period, so a revised version only comes from another source: stored directly here.
  const [fetched] = await nbsFetcher(parsed, pages()).fetch(async () => null);
  const revised = { ...fetched, release: { ...fetched.release, label: `${fetched.release.label}（修订）` } };
  const before = await table();
  assert.deepEqual(await storePeriod(parsed.sources[0], parsed.items, revised, LATER), { inserted: 10, touched: 0, changed: [] });
  const rows = await table();
  assert.deepEqual([rows.length, rows.filter((row) => row.release_label === SEP2 + TAIL)], [20, before]);
});

test("a revised version: the next period is compared with the previous period's newest version, the stored newest with its own", async () => {
  await run({ [NBS_LIST_URL]: earlyList });
  const [sep1] = await nbsFetcher(parsed, pages()).fetch(async () => "2026-09-01");
  const rows = sep1!.rows.map((row) => (row.key === "nbs.copper" ? { ...row, value: "176788.0" } : row));
  await storePeriod(parsed.sources[0], parsed.items, { ...sep1!, rows, release: { ...sep1!.release, label: `${sep1!.release.label}（修订）` } }, LATER);
  const reason = "nbs.copper 是 108770.0，是上一期 176788.0 的 0.62 倍，超出 0.67–1.5 倍";
  assert.deepEqual(await run({}, LATER), record(false, [period(SEP1, { touched: 10 }), period(SEP2, { held: reason })], LATER));
});

test("a new period failing a check is held back whole and the next one waits for it, the store unchanged; they go in once it passes", async () => {
  await run({ [NBS_LIST_URL]: earlyList });
  const before = await table();
  const sep1 = period(SEP1, { touched: 10 });
  const held = [sep1, period(SEP2, { held: COPPER_REASON }), period(SEP3, { held: `等 ${SEP2}` })];
  assert.deepEqual(await run({ [NBS_LIST_URL]: lateList, ...COPPER_UP }), record(false, held));
  assert.deepEqual(await table(), before);
  assert.deepEqual(await run({ [NBS_LIST_URL]: lateList }), record(true, [sep1, period(SEP2, { inserted: 10 }), period(SEP3, { inserted: 10 })]));
});

test("the stored newest period failing when read again keeps its rows and holds nothing back: the next period is stored", async () => {
  await run({ [NBS_LIST_URL]: earlyList });
  const before = await table();
  const zero = { [EARLY]: early.replace(">110492.5<", ">0<") };
  const held = period(SEP1, { held: "nbs.copper 的数值 0 不大于 0", notes: NO_PREVIOUS });
  assert.deepEqual(await run(zero, LATER), record(false, [held, period(SEP2, { inserted: 10 })], LATER));
  assert.deepEqual((await table()).slice(0, 10), before);
  assert.deepEqual(await values("2026-09-11"), MID_VALUES);
});

test("a period stored by force, copper at 1.6 times the one before, read again unchanged is not compared again: only fetched_at moves", async () => {
  await run({ [NBS_LIST_URL]: earlyList });
  const [forced] = await nbsFetcher(parsed, pages(COPPER_UP)).fetch(async () => "2026-09-11");
  await storePeriod(parsed.sources[0], parsed.items, forced, NOW);
  const before = await table();
  assert.deepEqual(await run(COPPER_UP, LATER), record(true, [period(SEP2, { touched: 10 })], LATER));
  const moved = before.map((row) => (row.period_start === "2026-09-11" ? { ...row, fetched_at: LATER } : row));
  assert.deepEqual(await table(), moved);
  // Once any value changes, every check applies again: copper's ratio holds the period back.
  const zinc = { [MID]: COPPER_UP[MID].replace(">26257.5<", ">26300.0<") };
  assert.deepEqual(await run(zinc, LATER), record(false, [period(SEP2, { held: COPPER_REASON })], LATER));
});

test("a second copy of the price table differing by one number holds the period back whole through the refresh, naming the row", async () => {
  await run({ [NBS_LIST_URL]: earlyList });
  const before = await table();
  const price = /<table[\s\S]*<\/table>/.exec(mid)![0];
  const copy = { [MID]: mid.replace(price, () => price + price.replace(">108770.0<", ">108800.0<")) };
  const reason = "价格表第 2 份与第 1 份不同：第 1 份是“nbs.copper 吨 108770.0”，第 2 份是“nbs.copper 吨 108800.0”";
  assert.deepEqual(await run(copy), record(false, [period(SEP1, { touched: 10 }), period(SEP2, { held: reason })]));
  assert.deepEqual(await table(), before);
});

test("a failing source is recorded as failed with its reason, never as 'no new version'; the refresh does not throw, the store does not change", async () => {
  await run({ [NBS_LIST_URL]: earlyList });
  const before = await table();
  const away = "https://www.example.com/sj/zxfb/index.html";
  const failing: [PageGetter, string][] = [
    [() => Promise.reject(new Error("connect timeout")), "connect timeout"],
    [pages({ [NBS_LIST_URL]: entries((entry) => (entry.includes(TAIL) ? "" : entry)) }), "列表页没有认出任何一期（可能改版或是验证页）"],
    [async () => ({ status: 200, url: away, text: () => list }), `${NBS_LIST_URL} 跳到了 ${away}，不在登记的主机上或不是 https`],
    [() => Promise.reject(new Error(`${"超时".repeat(499)}超𠮷尾`)), `${"超时".repeat(499)}超\uFFFD`],
  ];
  for (const [get, error] of failing) assert.deepEqual((await refreshMetalPrices({ registry, get, now: LATER })).nbs, { ...record(false, [], LATER), error });
  assert.deepEqual(await table(), before);
  // A registry that fails its check throws instead: the schedule records a failed run rather than skipping entries.
  await assert.rejects(refreshMetalPrices({ registry: { ...registry, items: [] }, get: pages(), now: LATER }), /^Error: metal price registry: items/);
});

test("one period listed under two addresses fails the source, naming both, and neither copy is stored", async () => {
  await run({ [NBS_LIST_URL]: earlyList });
  const before = await table();
  const copy = MID.replace("1965403", "1965404");
  const twice = { [NBS_LIST_URL]: entries((entry) => (entry.includes(SEP2) ? entry + entry.replaceAll("1965403", "1965404") : entry)) };
  const error = `同一所属期抓到不止一份，不猜哪份为准：${SEP2} ${MID}、${SEP2} ${copy}`;
  assert.deepEqual(await run({ ...twice, [copy]: mid.replace(">108770.0<", ">108800.0<") }, LATER), { ...record(false, [], LATER), error });
  assert.deepEqual(await table(), before);
});

test("a stopped series gets no new rows and keeps its old ones, and no period is held back for lacking it", async () => {
  await run({ [NBS_LIST_URL]: earlyList });
  const stopped = { ...registry, items: registry.items.map((item) => (item.key === "nbs.zinc" ? { ...item, enabled: false } : item)) };
  const noZinc = { [MID]: mid.replace(/<tr\b(?:(?!<\/tr>)[\s\S])*锌锭(?:(?!<\/tr>)[\s\S])*<\/tr>/, "") };
  assert.deepEqual(await run(noZinc, LATER, stopped), record(true, [period(SEP1, { touched: 9 }), period(SEP2, { inserted: 9 })], LATER));
  const zinc = await sql`SELECT period_start::text AS start, fetched_at FROM publication.metal_prices WHERE series_key = 'nbs.zinc'`;
  assert.deepEqual([...zinc], [{ start: "2026-09-01", fetched_at: NOW }]);
});

test("a stopped source is not fetched and has no entry in the run record", async () => {
  const off = { ...registry, sources: registry.sources.map((source) => ({ ...source, enabled: false })) };
  assert.deepEqual(await refreshMetalPrices({ registry: off, get: () => Promise.reject(new Error("fetched")), now: NOW }), {});
});

test("two runs at the same moment: the second adds no rows and changes no values, the table is one run's, its record only 只更新时间; the schedule", async () => {
  await run();
  const once = await table();
  assert.deepEqual(await run(), record(true, [period(SEP2, { touched: 10 })]));
  assert.deepEqual(await table(), once);
  // Three times a day after the bureau's 09:30 release, a missed slot run once; with the collectors (no lane).
  const schedule = SCHEDULES.find((candidate) => candidate.name === "metals.prices");
  assert.deepEqual([schedule?.cron, schedule?.missed], ["45 9,15,21 * * *", "once"]);
});

test("with collection off the price schedule is not registered, like source collection", async () => {
  const was = process.env.COLLECT_ENABLED;
  process.env.COLLECT_ENABLED = "false";
  try {
    const { SCHEDULES: off } = await import(`../apps/worker/src/schedules.ts?${"collect-off"}`);
    assert.deepEqual(
      ["sources.schedule", "metals.prices"].map((name) => off.some((s: { name: string }) => s.name === name)),
      [false, false],
    );
  } finally {
    if (was === undefined) delete process.env.COLLECT_ENABLED;
    else process.env.COLLECT_ENABLED = was;
  }
});

// TASK-0046: fetchers made up here, on registries made up here. The monthly sources take keys the registry allows and the
// bureau's other fields; none of this is their data.
const monthly = (key: string, host: string) => ({ ...registry.sources[0], key, frequency: "month", currency: "USD", hosts: [host] });
const series = (key: string, source: string) => ({ key, source, sourceName: key, name: key });
const imf = { sources: [monthly("imf", "www.imf.org")], items: [series("imf.a", "imf"), series("imf.b", "imf")] };
const wb = { sources: [monthly("worldbank", "www.worldbank.org")], items: [series("wb.a", "worldbank")] };
const three = { sources: [...registry.sources, ...wb.sources, ...imf.sources], items: [...registry.items, ...wb.items, ...imf.items] };
const FILE = "https://www.imf.org/prices.xlsx";
/** A month of the made-up IMF source: the series' values as published. */
const month = (at: string, label: string, values: Record<string, string>, more: Partial<FetchedPeriod> = {}): FetchedPeriod => {
  const rows = Object.entries(values).map(([key, value]) => ({ key, unit: "吨", value }));
  return { source: "imf", period: { start: `${at}-01`, end: `${at}-28`, label: at }, release: { label, url: FILE, releasedOn: null }, rows, held: [], ...more };
};
const log: string[] = [];
const contexts: FetchContext[] = [];
/** A made-up fetcher: logs its request going out and, `turns` turns of the event loop later, coming back; then gives `periods()`. */
function fake(key: MetalPriceSourceKey, periods: () => FetchedPeriod[], turns = 1) {
  const fetch = async (_newest: unknown, context?: FetchContext) => {
    log.push(`${key} 发`);
    contexts.push(context!);
    for (let turn = 0; turn < turns; turn++) await new Promise(setImmediate);
    log.push(`${key} 回`);
    return periods();
  };
  return () => ({ sourceKeys: [key], fetch });
}
const imfRun = async (...months: FetchedPeriod[]) => (await refreshMetalPrices({ registry: imf, now: NOW, fetchers: { imf: fake("imf", () => months) } })).imf;
const JUNE = month("2026-06", "R1", { "imf.a": "10", "imf.b": "100" });

test("two sources are requested at a time, the third once both are back; one failing or with no fetcher fails alone; one returning nothing is noted, a success", async () => {
  const fetchers = { nbs: fake("nbs", () => []), worldbank: fake("worldbank", () => assert.fail("connect timeout"), 3), imf: fake("imf", () => [JUNE]) };
  const first = await refreshMetalPrices({ registry: three, now: NOW, fetchers });
  assert.deepEqual(log.splice(0), ["nbs 发", "worldbank 发", "nbs 回", "worldbank 回", "imf 发", "imf 回"]);
  const nothing = (now: Date) => ({ ...record(true, [], now), note: "一期都没返回（版本没变或没有要读的期），这次没有下载价格" });
  const june = period("2026-06", { version: "R1", inserted: 2, notes: NO_PREVIOUS });
  assert.deepEqual(first, { nbs: nothing(NOW), worldbank: { ...record(false, []), error: "connect timeout" }, imf: record(true, [june]) });
  // With no fetcher the World Bank alone fails. Each fetcher is given the run's clock and when a version was last fetched.
  const second = await refreshMetalPrices({ registry: three, now: LATER, fetchers: { ...fetchers, worldbank: undefined } });
  const missing = { ...record(false, [], LATER), error: "没有这个来源的抓取器" };
  assert.deepEqual(second, { nbs: nothing(LATER), worldbank: missing, imf: record(true, [period("2026-06", { version: "R1", touched: 2 })], LATER) });
  const { now, fetchedAt } = contexts.at(-1)!;
  assert.deepEqual([now, await fetchedAt("imf", "R1"), await fetchedAt("worldbank", "R1"), await fetchedAt("imf", "R2")], [LATER, LATER, null, null]);
});

test("a monthly source: a value at 2.1 or 0.45 times the month before holds the month back whole, the store unchanged; 2 and 0.5 times go in", async () => {
  await imfRun(JUNE);
  const before = await table();
  const july = (a: string, b: string) => month("2026-07", "R2", { "imf.a": a, "imf.b": b });
  const held = (reason: string) => record(false, [period("2026-07", { version: "R2", held: reason })]);
  assert.deepEqual(await imfRun(july("21", "100")), held("imf.a 是 21，是上一期 10 的 2.10 倍，超出 0.5–2 倍"));
  assert.deepEqual(await imfRun(july("10", "45")), held("imf.b 是 45，是上一期 100 的 0.45 倍，超出 0.5–2 倍"));
  assert.deepEqual(await table(), before);
  assert.deepEqual(await imfRun(july("20", "50")), record(true, [period("2026-07", { version: "R2", inserted: 2 })]));
});

test("a series held back alone: the rest of its month goes in, the record lists it, the source did not succeed; with all held back the month is held whole", async () => {
  await imfRun(JUNE);
  // The series held back is not checked (its 0 would hold the month) and not stored.
  const heldSeries = [{ key: "imf.b", reason: "说明对不上" }];
  const july = period("2026-07", { version: "R2", inserted: 1, heldSeries });
  assert.deepEqual(await imfRun(month("2026-07", "R2", { "imf.a": "11", "imf.b": "0" }, { heldSeries })), record(false, [july]));
  const all = [...heldSeries, { key: "imf.a", reason: "说明对不上" }];
  const august = period("2026-08", { version: "R3", held: "这一期启用的品种全被单独扣下", heldSeries: all });
  assert.deepEqual(await imfRun(month("2026-08", "R3", { "imf.a": "11", "imf.b": "100" }, { heldSeries: all })), record(false, [august]));
  assert.deepEqual([await values("2026-07-01"), await values("2026-08-01")], [new Map([["imf.a", "11"]]), new Map()]);
});

test("a new version repeating the stored newest period, copper at 1.6 times the one before, is not compared or stored; one changing a value is stored beside it", async () => {
  await run({ [NBS_LIST_URL]: earlyList });
  const [forced] = await nbsFetcher(parsed, pages(COPPER_UP)).fetch(async () => "2026-09-11");
  await storePeriod(parsed.sources[0], parsed.items, forced, NOW);
  const before = await table();
  const version = `${forced.release.label}（修订）`;
  const fetchers = (rows = forced.rows) => ({ nbs: fake("nbs", () => [{ ...forced, rows, release: { ...forced.release, label: version } }]) });
  const again = async (rows = forced.rows) => (await refreshMetalPrices({ registry, now: LATER, fetchers: fetchers(rows) })).nbs;
  assert.deepEqual(await again(), record(true, [period(SEP2, { version, notes: ["和库里已有的一样，不另存"] })], LATER));
  assert.deepEqual(await table(), before);
  // Copper back to the bureau's figure: every check applies and passes, and the new version is a row beside the old one.
  const copper = forced.rows.map((row) => (row.key === "nbs.copper" ? { ...row, value: "108770.0" } : row));
  assert.deepEqual(await again(copper), record(true, [period(SEP2, { version, inserted: 10 })], LATER));
  const rows = await table();
  assert.deepEqual([rows.length, rows.filter((row) => row.release_label !== version)], [30, before]);
});
