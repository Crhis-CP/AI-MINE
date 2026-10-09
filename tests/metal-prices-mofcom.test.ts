import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, beforeEach, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { mofcomFetcher, MOFCOM_URL } from "../packages/backend/src/publication/metal-prices/mofcom.ts";
import { loadMetalPriceRegistry, parseMetalPriceRegistry } from "../packages/backend/src/publication/metal-prices/registry.ts";
import { refreshMetalPrices } from "../packages/backend/src/publication/metal-prices/refresh.ts";
import type { PageGetter } from "../packages/backend/src/publication/metal-prices/types.ts";

const raw = JSON.parse(readFileSync(new URL("../industry/metal-prices.json", import.meta.url), "utf8"));
const registry = loadMetalPriceRegistry(),
  items = registry.items.filter((item) => item.source === "mofcom");
const narrowed = {
  ...raw,
  sources: raw.sources.filter((s: { key: string }) => s.key === "mofcom"),
  items: raw.items.filter((i: { source: string }) => i.source === "mofcom"),
};
const fixture = (id: string) => readFileSync(new URL(`./fixtures/metal-prices/mofcom/week-${id}.json`, import.meta.url), "utf8");
const NOW = new Date("2026-10-09T00:00:00Z"),
  sql = dbOf("publication");
after(() => closeDb());
beforeEach(async () => {
  await sql`TRUNCATE publication.metal_prices`;
});
function pages(edit: (id: string, text: string) => string = (_, text) => text, response: Partial<Awaited<ReturnType<PageGetter>>> = {}) {
  const calls: Parameters<PageGetter>[] = [];
  const get: PageGetter = async (url, opts) => {
    calls.push([url, opts]);
    return {
      status: 200,
      url,
      text: () => edit(new URLSearchParams(opts?.body).get("indexId")!, fixture(new URLSearchParams(opts?.body).get("indexId")!)),
      ...response,
    };
  };
  return { get, calls };
}
const run = async (get = pages().get, now = NOW) => (await refreshMetalPrices({ registry: narrowed, get, now })).mofcom;
const snapshot = () => sql`SELECT * FROM publication.metal_prices ORDER BY series_key, period_start`;
const mutate = (change: Partial<Record<"DATA" | "DATADATE" | "NAME" | "UNIT", string>> | "missing" | "empty-list") => (id: string, text: string) => {
  const data = JSON.parse(text);
  if (id === "224014") {
    if (change === "missing") data.datas.pop();
    else if (change === "empty-list") data.datas = [];
    else Object.assign(data.datas.at(-1), change);
  }
  return JSON.stringify(data);
};

test("weekly registry keeps the approved quotes, source-only IDs and attribution order", () => {
  assert.deepEqual(
    items.map((i) => [i.sourceId, i.metal, i.quote, i.spec]),
    [
      ["224011", "copper", "国内 · 铜 1#", null],
      ["224012", "aluminum", "国内 · 铝 A00", null],
      ["224014", "zinc", "国内 · 锌 1#", null],
    ],
  );
  const frequencies: string[] = registry.frequencies.map((f) => f.key);
  assert.ok(frequencies.indexOf("week") < frequencies.indexOf("ten_day"));
  if (frequencies.includes("day")) assert.ok(frequencies.indexOf("day") < frequencies.indexOf("week"));
  const n = registry.notes.findIndex((note) => note.sources?.includes("nbs"));
  assert.ok(registry.notes[n].text.startsWith("国内每旬价格来自国家统计局发布的"));
  assert.equal(registry.notes[n].text.match(/每旬/g)?.length, 1);
  assert.deepEqual(registry.notes[n + 1].sources, ["mofcom"]);
  assert.match(registry.notes[n + 1].text, /信息来源：商务预报/);
  const l = registry.officialLinks.findIndex((link) => link.name === "国家统计局 数据发布");
  assert.equal(registry.officialLinks[l + 1].name, "商务部 商务预报");
  for (const [key, field, value] of [
    ["mofcom.copper", "sourceId", undefined],
    ["nbs.copper", "sourceId", "224011"],
    ["mofcom", "frequency", "ten_day"],
  ] as const) {
    const d = structuredClone(raw);
    const target = (field === "frequency" ? d.sources : d.items).find((x: { key: string }) => x.key === key);
    if (value === undefined) delete target[field];
    else target[field] = value;
    assert.throws(() => parseMetalPriceRegistry(d), /sourceId|frequency/);
  }
});

test("recorded requests preserve two newest single-date periods and unrounded numeric tokens", async () => {
  const p = pages(),
    periods = await mofcomFetcher(registry, p.get).fetch(async () => null);
  assert.deepEqual(
    periods.map((one) => one.period),
    [
      { start: "2026-09-18", end: "2026-09-18", label: "2026年9月18日" },
      { start: "2026-09-25", end: "2026-09-25", label: "2026年9月25日" },
    ],
  );
  assert.deepEqual(
    periods[1].rows.map((row) => row.value),
    ["111975", "24340", "26689"],
  );
  assert.ok(periods[1].rows.every((row) => row.unit === "元/吨"));
  assert.deepEqual(periods[1].release, { label: "商务预报 2026-09-25", url: registry.sources.find((s) => s.key === "mofcom")!.officialUrl, releasedOn: null });
  assert.deepEqual(
    p.calls.map(([url, opts]) => [url, opts?.method, opts?.body, opts?.maxRedirects]),
    items.map((i) => [MOFCOM_URL, "POST", `indexId=${i.sourceId}&startDate=&endDate=&flg=2`, 0]),
  );
  const precise = pages((id, text) => (id === "224011" ? text.replace('"DATA":"111975"', '"DATA":111975.6000') : text));
  assert.equal((await mofcomFetcher(registry, precise.get).fetch(async () => "2026-09-25"))[0].rows[0].value, "111975.6000");
  const later = await mofcomFetcher(registry, pages().get).fetch(async () => "2026-09-11");
  assert.equal(later.length, 3);
});

test("first refresh stores six original values; repeated week touches only; revised excessive price holds the whole week", async () => {
  assert.equal((await run()).inserted, 6);
  const first = await snapshot();
  assert.equal((await run(pages().get, new Date(NOW.getTime() + 1000))).touched, 3);
  const again = await snapshot();
  assert.deepEqual(
    again.map(({ fetched_at: _, ...row }) => row),
    first.map(({ fetched_at: _, ...row }) => row),
  );
  const result = await run(pages((id, text) => (id === "224011" ? text.replace('"DATA":"111975"', '"DATA":"228194.4"') : text)).get);
  assert.equal(result.ok, false);
  assert.match(result.periods[0].held!, /倍/);
  assert.deepEqual(await snapshot(), again);
});

test("missing value or mismatched name holds only that metal; unit drift holds the whole period", async () => {
  for (const edit of ["missing", { DATA: "" }, { NAME: "铅（1#）" }] as const) {
    await sql`TRUNCATE publication.metal_prices`;
    const result = await run(pages(mutate(edit)).get);
    assert.equal(result.ok, false);
    assert.equal(result.inserted, 5);
    assert.equal(result.periods[1].heldSeries?.[0].key, "mofcom.zinc");
  }
  await sql`TRUNCATE publication.metal_prices`;
  const result = await run(pages(mutate({ UNIT: "元/千克" })).get);
  assert.equal(result.inserted, 3);
  assert.match(result.periods[1].held!, /单位/);
});

test("unreadable, empty, foreign-host and invalid-date replies fail without changing stored data", async () => {
  await run();
  const before = await snapshot();
  for (const get of [
    pages(() => "<html>验证页</html>").get,
    pages(undefined, { status: 404 }).get,
    pages(undefined, { url: "https://other.example/data" }).get,
    pages(mutate("empty-list")).get,
    pages(mutate({ DATADATE: "2026-02-30" })).get,
    pages(mutate({ DATADATE: "09-25" })).get,
  ]) {
    const result = await run(get);
    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.deepEqual(await snapshot(), before);
  }
});

test("weekly table checks refuse other sources, other periods, date ranges and malformed series keys", async () => {
  await run();
  for (const change of [
    { period_type: "ten_day" },
    { source: "worldbank", series_key: "wb.copper" },
    { period_end: "2026-09-26" },
    { series_key: "mofcom.Copper" },
  ])
    await assert.rejects(
      sql`UPDATE publication.metal_prices SET ${sql(change)} WHERE series_key='mofcom.copper' AND period_start='2026-09-25'`,
      (error: { code?: string }) => error.code === "23514",
    );
  assert.equal((await snapshot()).length, 6);
});
