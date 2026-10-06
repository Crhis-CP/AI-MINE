// Metal price refresh (TASK-0069), shaped as the upstream leaderboard refresh: each enabled source's fetcher reads the
// periods from the newest stored one on (TASK-0057), and each is checked, then stored or held back whole on the fetcher's
// reasons or the check's; a failing source fails alone. The return value is the run record the schedule keeps in
// job_runs.detail.
import { checkPeriod } from "./check.ts";
import { nbsFetcher } from "./nbs.ts";
import { loadMetalPriceRegistry, parseMetalPriceRegistry } from "./registry.ts";
import { newestStart, previousValues, storedValues, storePeriod } from "./store.ts";
import type { FetchedPeriod, PageGetter } from "./types.ts";

/** One period of a source in the run record; TASK-0046 adds the series held back alone. */
export interface MetalPricePeriodRun {
  period: string;
  /** The release title. */
  version: string;
  inserted: number;
  /** Rows read again with the same value: only fetched_at moved (只更新时间). */
  touched: number;
  changed: { key: string; before: string; after: string }[];
  /** Why the period was held back, the fetcher's reasons then the check's ("等 <所属期>" behind a held earlier one); null when stored. */
  held: string | null;
  /** What the check did not compare and why ("没有上一期"); never holds the period back. */
  notes: string[];
}

/** One source of the run record; TASK-0049's digest reads it, so later cards add fields only. */
export interface MetalPriceSourceRun {
  /** No error, and no period held back or waiting for one ("no new version" is a success; notes do not count). */
  ok: boolean;
  at: string;
  /** The first 1000 characters, as source collection keeps them. */
  error: string | null;
  inserted: number;
  touched: number;
  periods: MetalPricePeriodRun[];
}

/** A period's entry in the run record, before it is checked. */
function blank({ period, release }: FetchedPeriod): MetalPricePeriodRun {
  return { period: period.label, version: release.label, inserted: 0, touched: 0, changed: [], held: null, notes: [] };
}

/** `registry` is data as in industry/metal-prices.json (tests narrow it), checked whole like the file. */
export async function refreshMetalPrices(opts: { registry?: unknown; get?: PageGetter; now?: Date } = {}) {
  // A bad registry throws here, so the schedule records a failed run rather than skipping entries.
  const registry = opts.registry === undefined ? loadMetalPriceRegistry() : parseMetalPriceRegistry(opts.registry);
  const now = opts.now ?? new Date();
  const fetchers = [nbsFetcher(registry, opts.get)];
  const record: Record<string, MetalPriceSourceRun> = {};
  for (const source of registry.sources.filter((candidate) => candidate.enabled)) {
    const run: MetalPriceSourceRun = { ok: false, at: now.toISOString(), error: null, inserted: 0, touched: 0, periods: [] };
    record[source.key] = run;
    const items = registry.items.filter((item) => item.source === source.key && item.enabled);
    try {
      const fetcher = fetchers.find((candidate) => candidate.sourceKeys.includes(source.key));
      if (!fetcher) throw new Error("没有这个来源的抓取器");
      const fetched = await fetcher.fetch(newestStart);
      // One period fetched twice (the list naming it under two addresses) fails the source: neither copy is guessed right.
      const twice = fetched.filter((one) => fetched.some((other) => other !== one && other.period.start === one.period.start));
      if (twice.length) throw new Error(`同一所属期抓到不止一份，不猜哪份为准：${twice.map((one) => `${one.period.label} ${one.release.url}`).join("、")}`);
      let waiting: string | null = null;
      for (const one of fetched) {
        const entry = blank(one);
        run.periods.push(entry);
        if (waiting) {
          entry.held = `等 ${waiting}`;
          continue;
        }
        const newest = await newestStart(source.key);
        const previous = await previousValues(source.key, one.period.start, items);
        // The stored newest period read again unchanged passed its checks when stored, or was stored by force (TASK-0049):
        // compared with the period before again, a forced one would be held back at every run.
        const stored = await storedValues(source.key, one);
        const unchanged = one.period.start === newest && one.rows.length === items.length && one.rows.every((row) => stored.get(row.key) === row.value);
        const { reasons, notes } = checkPeriod({ fetched: one, source, items, previous, newest, compareWithPrevious: !unchanged, now });
        entry.notes = notes;
        const held = [...one.held, ...reasons];
        if (held.length) {
          entry.held = held.join("；");
          // A held new period keeps every later one waiting: with them stored it would be older than the store and never
          // get in. The stored newest period read again does not, as it is stored already.
          if (!newest || one.period.start > newest) waiting = one.period.label;
          continue;
        }
        Object.assign(entry, await storePeriod(source, items, one, now));
        run.inserted += entry.inserted;
        run.touched += entry.touched;
      }
      run.ok = run.periods.every((entry) => entry.held === null);
    } catch (error) {
      run.error = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    }
  }
  return record;
}
