import "./setup.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { after, beforeEach, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { refreshMetalPrices } from "@amp/backend/jobs/publication";
import { recordRun } from "@amp/backend/jobs/queue";
import { readMetalPriceRuns } from "@amp/backend/operations/alerts";
import { NBS_LIST_URL, nbsFetcher } from "../packages/backend/src/publication/metal-prices/nbs.ts";
import { parseMetalPriceRegistry } from "../packages/backend/src/publication/metal-prices/registry.ts";
import type { FetchedPeriod } from "../packages/backend/src/publication/metal-prices/types.ts";

const sql = dbOf("publication");
const NOW = new Date("2026-10-06T04:00:00Z");
const fixture = (name: string) => readFileSync(new URL(`./fixtures/metal-prices/nbs/${name}.html`, import.meta.url), "utf8");
const [list, early, mid] = ["list", "release-previous", "release-latest"].map(fixture);
const data = JSON.parse(readFileSync(new URL("../industry/metal-prices.json", import.meta.url), "utf8"));
const registry = {
  ...data,
  sources: data.sources.filter((s: { key: string }) => s.key === "nbs"),
  items: data.items.filter((i: { source: string }) => i.source === "nbs"),
};
const parsed = parseMetalPriceRegistry(registry);
const get = async (url: string) => ({ status: 200, url, text: () => (url === NBS_LIST_URL ? list : url.includes("1965293") ? early : mid) });
const [first, second] = await nbsFetcher(parsed, get).fetch(async () => "2026-09-01");
const high: FetchedPeriod = { ...second, rows: second.rows.map((row) => (row.key === "nbs.copper" ? { ...row, value: "232034.25" } : row)) };
const force = { periodStart: second.period.start, held: [second.period.label] };
const options = { registry, now: NOW, source: "nbs" };
const fetchers = (...periods: FetchedPeriod[]) => ({ nbs: () => ({ sourceKeys: ["nbs" as const], fetch: async () => periods }) });
const run = (periods = [high], extra: Parameters<typeof refreshMetalPrices>[0] = {}) =>
  refreshMetalPrices({ ...options, fetchers: fetchers(...periods), ...extra });
const prices = async () => [...(await sql`SELECT * FROM publication.metal_prices ORDER BY series_key, period_start, release_label`)];
const jobs = async () => [...(await sql`SELECT * FROM job_runs ORDER BY id`)];
const snapshot = async () => [await prices(), await jobs()];
async function recorded(fn: () => ReturnType<typeof run>, job = "metals.prices") {
  try {
    return await recordRun(job, fn);
  } finally {
    await sql`UPDATE job_runs SET started_at = ${NOW}, finished_at = ${NOW}`;
  }
}
after(() => closeDb());
beforeEach(async () => {
  await sql`TRUNCATE publication.metal_prices, job_runs`;
});

test("dry-run reports inserts, touches and revisions with both tables byte-for-byte unchanged", async () => {
  let before = await snapshot();
  assert.equal((await run([second], { dryRun: true })).nbs.inserted, 10);
  assert.deepEqual(await snapshot(), before);
  await recorded(() => run([first]));
  before = await snapshot();
  const preview = (await run([first, second], { dryRun: true })).nbs;
  assert.deepEqual([preview.ok, preview.inserted, preview.touched], [true, 10, 10]);
  assert.deepEqual(await snapshot(), before);
  assert.equal((await run([high], { dryRun: true, force })).nbs.inserted, 10);
  assert.deepEqual(await snapshot(), before);
  await run([second]);
  before = await snapshot();
  const changed = { ...second, rows: second.rows.map((row) => (row.key === "nbs.copper" ? { ...row, value: "0108800.0" } : row)) };
  const result = (await run([changed], { dryRun: true })).nbs;
  assert.deepEqual(result.periods[0].changed, [{ key: "nbs.copper", before: "108770.0", after: "108800.0" }]);
  assert.equal(result.touched, 9);
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual((await run([changed])).nbs, result);
});

test("manual 2.1-times period clears the hold, records forced detail, and the schedule accepts its unchanged version", async () => {
  await recorded(() => run([first]));
  const blocked = await recorded(() => run());
  assert.match(blocked.nbs.periods[0].held!, /2.10 倍/);
  const held = (await readMetalPriceRuns(NOW)).sources.nbs.held;
  const result = await recorded(() => run([high], { force: { ...force, held } }), "metals.prices.manual");
  assert.deepEqual(result.nbs.forced, { period: second.period.label, skipped: ["行数", "倍数"] });
  assert.equal(result.nbs.inserted, 10);
  const manual = (await jobs()).at(-1)!;
  assert.deepEqual(manual.detail, result);
  const read = await readMetalPriceRuns(NOW);
  assert.deepEqual(read.sources.nbs.held, []);
  assert.deepEqual(read.sources.nbs.latest, result.nbs);
  const before = await prices();
  await assert.rejects(
    recorded(() => run([high], { force: { ...force, held: read.sources.nbs.held } }), "metals.prices.manual"),
    /没对上/,
  );
  assert.deepEqual(await prices(), before);
  const failed = (await jobs()).at(-1)!;
  assert.deepEqual([failed.status, failed.detail], ["failed", null]);
  assert.match(failed.error, /没对上/);
  assert.deepEqual((await readMetalPriceRuns(NOW)).sources.nbs.latest, result.nbs);
  assert.equal((await run()).nbs.ok, true);
});

test("force still holds invalid units, zeroes, hosts, duplicates, future periods and fetcher reasons without writing", async () => {
  await run([first]);
  const before = await snapshot();
  const bad: FetchedPeriod[] = [
    ...[{ unit: "千克" }, { value: "0" }].map((change) => ({
      ...high,
      rows: high.rows.map((row) => (row.key === "nbs.copper" ? { ...row, ...change } : row)),
    })),
    { ...high, release: { ...high.release, url: "https://example.com/price" } },
    { ...high, rows: [...high.rows, high.rows[0]] },
    { ...high, period: { ...high.period, end: "2026-10-07" } },
    { ...high, held: ["表头不符合来源规则"] },
  ];
  for (const period of bad) {
    assert.equal((await run([period], { force })).nbs.ok, false);
    assert.deepEqual(await snapshot(), before);
  }
});

test("an empty hold list fails the whole manual run before a failed fetch can replace the source record", async () => {
  await recorded(() => run([first]));
  await recorded(() => run());
  await recorded(() => run([high], { force }), "metals.prices.manual");
  const read = await readMetalPriceRuns(NOW);
  const before = await prices();
  let fetchCalls = 0;
  const failing = {
    nbs: () => ({
      sourceKeys: ["nbs" as const],
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("fixture transport unavailable");
      },
    }),
  };
  const failure = await recorded(() => run([high], { force: { ...force, held: read.sources.nbs.held }, fetchers: failing }), "metals.prices.manual").then(
    () => null,
    (error: unknown) => error,
  );
  const last = (await jobs()).at(-1)!;
  assert.deepEqual([last.status, last.detail], ["failed", null]);
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /没对上/);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(await prices(), before);
  assert.deepEqual((await readMetalPriceRuns(NOW)).sources.nbs.latest, read.sources.nbs.latest);
});

test("a target missing from fetched periods or held labels fails before earlier periods write; unknown sources fail", async () => {
  await run([first]);
  const before = await snapshot();
  for (const invalid of [
    { ...force, held: [] },
    { ...force, periodStart: "2026-08-01" },
  ]) {
    await assert.rejects(run([first, high], { force: invalid, now: new Date("2026-10-07") }), /没对上/);
    assert.deepEqual(await snapshot(), before);
  }
  await assert.rejects(run([high], { force, source: undefined }), /指定一个来源/);
  await assert.rejects(run([high], { source: "missing", dryRun: true }), /不存在或未启用/);
});

test("dry-run compares later fetched periods with the values it would have stored earlier", async () => {
  await run([first]);
  const later = { ...second, period: { start: "2026-09-21", end: "2026-09-30", label: "2026年9月下旬" } };
  const before = await snapshot();
  const preview = await run([high, later], { dryRun: true, force });
  assert.equal(preview.nbs.periods[0].inserted, 10);
  assert.match(preview.nbs.periods[1].held!, /0.47 倍/);
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await run([high, later], { force }), preview);
});

test("touching an older version in a dry-run keeps the newer revision as the next period's comparison", async () => {
  await run([first]);
  await run([high], { force });
  const revised = { ...second, release: { ...second.release, label: `${second.release.label}（修订）` } };
  const later = new Date("2026-10-06T05:00:00Z");
  await run([revised], { now: later });
  const next = { ...second, period: { start: "2026-09-21", end: "2026-09-30", label: "2026年9月下旬" } };
  const before = await snapshot();
  const preview = await run([high, next], { dryRun: true, now: later });
  assert.equal(preview.nbs.ok, true);
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await run([high, next], { now: later }), preview);
});

test("World Bank fetch context bypasses the stored-version cache only for dry-run and force, selecting one source", async () => {
  const source = { ...registry.sources[0], key: "worldbank", frequency: "month", currency: "USD", hosts: ["www.worldbank.org"] };
  const all = { ...data, sources: [...registry.sources, source], items: [...registry.items, { key: "wb.a", source: "worldbank", sourceName: "a", name: "a" }] };
  const wb = { ...second, source: "worldbank" as const, rows: [], held: ["fixture hold"] };
  const selected = {
    nbs: () => {
      throw new Error("wrong source fetched");
    },
    worldbank: () => ({
      sourceKeys: ["worldbank" as const],
      fetch: async (_newest: unknown, context?: { fetchedAt(source: "nbs", release: string): Promise<Date | null> }) => {
        assert.deepEqual(await context!.fetchedAt("nbs", first.release.label), expected);
        return [wb];
      },
    }),
  };
  await run([first]);
  let expected: Date | null = NOW;
  assert.equal((await refreshMetalPrices({ registry: all, source: "worldbank", fetchers: selected, now: NOW })).worldbank.error, null);
  expected = null;
  assert.equal((await refreshMetalPrices({ registry: all, source: "worldbank", fetchers: selected, now: NOW, dryRun: true })).worldbank.error, null);
  assert.equal((await refreshMetalPrices({ registry: all, source: "worldbank", fetchers: selected, now: NOW, force })).worldbank.error, null);
});

test("the no-argument script reads scheduled notes and leaves both tables unchanged", async () => {
  await recorded(() => run([first]));
  await recorded(() => run([]));
  const before = await snapshot();
  const clock = `import { mock } from "node:test"; mock.timers.enable({ apis: ["Date"], now: ${NOW.getTime()} });`;
  const output = spawnSync(process.execPath, ["--input-type=module", "-e", `${clock} await import("./scripts/metal-prices-check.ts");`], {
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(output.status, 0, output.stderr);
  assert.match(output.stdout, /nbs：成功/);
  assert.match(output.stdout, /这次一期都没有返回/);
  assert.match(output.stdout, /nbs 上次成功/);
  assert.deepEqual(await snapshot(), before);
  console.log(output.stdout.trim());
});
