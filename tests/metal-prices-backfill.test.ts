import "./setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { backfillMetalPrices, cbrHistory, cochilcoHistoryPeriod } from "../modules/metals/backend/backfill.ts";
import { loadMetalPriceRegistry } from "../modules/metals/backend/registry.ts";
import { storePeriod } from "../modules/metals/backend/store.ts";
import type { PageGetter } from "../modules/metals/backend/types.ts";

after(closeDb);
beforeEach(async () => {
  await sql`DELETE FROM publication.metal_prices WHERE source IN ('cbr', 'cochilco')`;
});

const registry = loadMetalPriceRegistry();
const source = (key: string) => registry.sources.find((s) => s.key === key)!;
const items = (key: string) => registry.items.filter((i) => i.source === key && i.enabled);
const NOW = new Date("2026-10-20T04:00:00Z");

// Synthetic figures in the three page layouts seen over the years; none is a captured market value.
const CURRENT = [
  "martes, 13 de octubre de 2026",
  "octubre 13, 2026 Variación % 720 720",
  "Contado 400,000 -0,10",
  "US$/TM",
  "Contado 8.818,49 -0,10 520 520",
  "OTROS METALES Y LITIO",
  "US$/TM ¢US$/lb",
  "Aluminio 2.600,0 117,93 -0,10",
  "Plomo 1.800,0 81,65 0,20",
  "Níquel 15.000,0 680,39 -0,10",
  "Zinc 3.000,0 136,08 0,20",
  "Estaño 30.000,0 1.360,78 -0,10",
];
const OLDER = [
  "octubre 13, 2026 ISSN 0716-8225",
  "Contado 400,000 1,01 400,000",
  "US$/TM",
  "Contado 8.818,49 1,01",
  "OTROS METALES",
  "Aluminio 2.600,0 117,934 0,70 4.120,10 2.351,12",
  "Plomo 81,647 0,71 London Fix PM 4.136,75",
  "Níquel 15.000,0 680,389 0,07 4.204,40",
  "Zinc 3.000,0 136,078 0,02",
  "Estaño 1.707,776 1,76",
];
const period = (lines: string[]) => cochilcoHistoryPeriod(registry, "2026-10-13", "https://www.cochilco.cl/web/download/x.pdf", lines, "hash");
const values = (lines: string[]) => Object.fromEntries(period(lines).rows.map((row) => [row.key.split(".")[1], row.value]));

test("a series is taken only where the report prints the same price in US$/t and ¢/lb and the two agree", () => {
  assert.deepEqual(values(CURRENT), { copper: "8818.49", aluminum: "2600.0", lead: "1800.0", zinc: "3000.0", tin: "30000.0", nickel: "15000.0" });
  // The older layout wraps some rows: lead and tin lost their tonne price to another line and are left out, not guessed.
  assert.deepEqual(values(OLDER), { copper: "8818.49", aluminum: "2600.0", zinc: "3000.0", nickel: "15000.0" });
  assert.equal(period(OLDER).notes!.length, 2);
  // A holiday prints zeros; a row whose two prices disagree was not read whole.
  assert.deepEqual(values(["octubre 13, 2026", "Contado 0,00", "Contado 0,00", "Aluminio 2.600,0 99,000 0,1"]), {});
  assert.throws(() => period(["octubre 14, 2026", ...CURRENT.slice(2)]), /日期与列表不符/);
});

const METALS = (rows: [string, string, string][]) =>
  `<?xml version="1.0" encoding="windows-1251"?><Metall FromDate="20261001" ToDate="20261020">${rows
    .map(([date, code, price]) => `<Record Date="${date}" Code="${code}"><Buy>${price}</Buy><Sell>${price}</Sell></Record>`)
    .join("")}</Metall>`;
const DOLLARS = (rows: [string, string][]) =>
  `<?xml version="1.0" encoding="windows-1251"?><ValCurs ID="R01235">${rows
    .map(([date, v]) => `<Record Date="${date}" Id="R01235"><Nominal>1</Nominal><Value>${v}</Value></Record>`)
    .join("")}</ValCurs>`;
const cbrPages =
  (metals: string, dollars: string, asked: string[] = []): PageGetter =>
  async (url) => {
    asked.push(url);
    return { status: 200, url, text: () => (url.includes("xml_metall") ? metals : dollars) };
  };
const seedCbr = (fixing: string, gold: string) =>
  storePeriod(
    source("cbr"),
    items("cbr").filter((i) => i.key === "cbr.gold"),
    {
      source: "cbr",
      period: { start: fixing, end: fixing, label: `${fixing}定价` },
      release: { label: `seed ${fixing}`, url: "https://www.cbr.ru/seed", releasedOn: null },
      rows: [{ key: "cbr.gold", unit: "卢布/克", value: gold }],
      held: [],
    },
    NOW,
  );
const stored = async (src: string) =>
  (
    await sql<{ day: string; key: string; value: string }[]>`
    SELECT period_start::text AS day, series_key AS key, value::text AS value FROM publication.metal_prices WHERE source = ${src} ORDER BY 1, 2`
  ).map((r) => `${r.day} ${r.key.split(".")[1]} ${r.value}`);

test("Bank of Russia: the whole range comes from two requests; a day without its dollar rate is left out", async () => {
  const asked: string[] = [];
  const got = await cbrHistory(registry, "2026-10-01", "2026-10-20", async (url) => {
    asked.push(url);
    const text = url.includes("xml_metall")
      ? METALS([
          ["14.10.2026", "1", "10000,5"],
          ["14.10.2026", "2", "120,25"],
          ["15.10.2026", "1", "10100,0"],
        ])
      : DOLLARS([["14.10.2026", "80,5"]]);
    return { text: () => text };
  });
  assert.equal(asked.length, 2);
  assert.match(asked[1]!, /XML_dynamic\.asp\?date_req1=01\/10\/2026&date_req2=20\/10\/2026&VAL_NM_RQ=R01235$/);
  assert.deepEqual(
    got.map((p) => [p.period.start, p.rows.map((r) => `${r.key.split(".")[1]}=${r.value}`).join(" "), p.held.length]),
    [
      ["2026-10-13", "gold=10000.5 silver=120.25 usd=80.5", 0],
      ["2026-10-14", "gold=10100.0", 1],
    ],
  );
});

test("only days before the newest stored one that are not stored go in; a dry run writes nothing; a second run adds nothing", async () => {
  await seedCbr("2026-10-16", "10200");
  await seedCbr("2026-10-14", "10100");
  const pages = cbrPages(
    METALS([
      ["13.10.2026", "1", "10000,5"], // fixing 10-12: goes in
      ["14.10.2026", "1", "5000,0"], // fixing 10-13: under half the next day's price, left out
      ["15.10.2026", "1", "9999,0"], // fixing 10-14: stored already, untouched
      ["17.10.2026", "1", "10200,0"], // fixing 10-16: the newest stored day itself
      ["20.10.2026", "1", "10300,0"], // fixing 10-19: after the newest stored day, the schedule's job
    ]),
    DOLLARS([
      ["13.10.2026", "80,1"],
      ["14.10.2026", "80,2"],
      ["15.10.2026", "80,3"],
      ["17.10.2026", "80,4"],
      ["20.10.2026", "80,5"],
    ]),
  );
  const run = (apply: boolean) => backfillMetalPrices({ source: "cbr", from: "2026-10-01", limit: 400, apply, now: NOW, get: pages });
  const dry = await run(false);
  assert.equal(dry.missing, 2);
  assert.deepEqual(await stored("cbr"), ["2026-10-14 gold 10100", "2026-10-16 gold 10200"]);
  const done = await run(true);
  assert.deepEqual(
    done.days.map((d) => [d.day, d.stored]),
    [
      ["2026-10-12", ["cbr.gold", "cbr.usd"]],
      ["2026-10-13", ["cbr.usd"]],
    ],
  );
  assert.match(done.days[1]!.left[0]!, /cbr\.gold：5000\.0 是后一个有数的日子 10100 的 0\.50 倍/);
  assert.deepEqual(await stored("cbr"), [
    "2026-10-12 gold 10000.5",
    "2026-10-12 usd 80.1",
    "2026-10-13 usd 80.2",
    "2026-10-14 gold 10100",
    "2026-10-16 gold 10200",
  ]);
  const again = await run(true);
  assert.equal(
    again.days.reduce((n, d) => n + d.stored.length, 0),
    0,
    "10-13 has its dollar rate now, so it counts as stored",
  );
  assert.equal((await stored("cbr")).length, 5);
});

test("the limit takes the newest missing days first, so the chart grows backwards without a gap", async () => {
  await seedCbr("2026-10-16", "10200");
  const days = ["08", "09", "10", "13", "14", "15"];
  const pages = cbrPages(METALS(days.map((d) => [`${d}.10.2026`, "1", "10100,0"])), DOLLARS(days.map((d) => [`${d}.10.2026`, "80,0"])));
  const first = await backfillMetalPrices({ source: "cbr", from: "2026-10-01", limit: 2, apply: true, now: NOW, get: pages });
  assert.deepEqual([first.missing, first.remaining, first.days.map((d) => d.day)], [6, 4, ["2026-10-13", "2026-10-14"]]);
  const second = await backfillMetalPrices({ source: "cbr", from: "2026-10-01", limit: 2, apply: true, now: NOW, get: pages });
  assert.deepEqual([second.missing, second.remaining, second.days.map((d) => d.day)], [4, 2, ["2026-10-09", "2026-10-12"]]);
});

test("nothing stored yet: refuses, the schedule reads the newest day first", async () => {
  await assert.rejects(backfillMetalPrices({ source: "cbr", from: "2026-10-01", limit: 10, get: cbrPages("", "") }), /还没有任何一期入库/);
});

test("each day is compared with its nearest later day, stored or taken this run, whichever is nearer (TASK-0641)", async () => {
  // Stored: 10-14 gold 200 and 10-16 gold 10000. Missing: 10-15 (gold 10000) and 10-13 (gold 190).
  await seedCbr("2026-10-16", "10000");
  await seedCbr("2026-10-14", "200");
  const pages = cbrPages(
    METALS([
      ["14.10.2026", "1", "190,0"], // fixing 10-13: next is the stored 10-14 (200), not this run's 10-15 (10000)
      ["16.10.2026", "1", "10000,0"], // fixing 10-15
      ["17.10.2026", "1", "10000,0"],
    ]),
    DOLLARS([
      ["14.10.2026", "80,1"],
      ["16.10.2026", "80,2"],
      ["17.10.2026", "80,3"],
    ]),
  );
  const done = await backfillMetalPrices({ source: "cbr", from: "2026-10-01", limit: 400, apply: false, now: NOW, get: pages });
  assert.deepEqual(
    done.days.map((d) => [d.day, d.stored]),
    [
      ["2026-10-13", ["cbr.gold", "cbr.usd"]],
      ["2026-10-15", ["cbr.gold", "cbr.usd"]],
    ],
  );
});

test("--before moves a later run past days that never go in (TASK-0641)", async () => {
  await seedCbr("2026-10-16", "10100");
  const days = ["09", "10", "13", "14", "15"];
  // No dollar rate on the two newest effective days: they never go in.
  const pages = cbrPages(METALS(days.map((d) => [`${d}.10.2026`, "1", "10100,0"])), DOLLARS(days.slice(0, 3).map((d) => [`${d}.10.2026`, "80,0"])));
  const first = await backfillMetalPrices({ source: "cbr", from: "2026-10-01", limit: 2, apply: true, now: NOW, get: pages });
  assert.deepEqual(
    first.days.map((d) => [d.day, d.stored.length]),
    [
      ["2026-10-13", 0],
      ["2026-10-14", 0],
    ],
  );
  assert.equal(first.earliest, "2026-10-13");
  const again = await backfillMetalPrices({ source: "cbr", from: "2026-10-01", limit: 2, apply: true, now: NOW, get: pages });
  assert.deepEqual(
    again.days.map((d) => d.day),
    ["2026-10-13", "2026-10-14"],
    "without --before the same two days take the limit again",
  );
  const past = await backfillMetalPrices({ source: "cbr", from: "2026-10-01", before: first.earliest!, limit: 2, apply: true, now: NOW, get: pages });
  assert.deepEqual(
    past.days.map((d) => [d.day, d.stored]),
    [
      ["2026-10-09", ["cbr.gold", "cbr.usd"]],
      ["2026-10-12", ["cbr.gold", "cbr.usd"]],
    ],
  );
});
