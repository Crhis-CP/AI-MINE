// Metal price refresh (TASK-0069), shaped as the upstream leaderboard refresh: each enabled source's fetcher reads the
// periods from the newest stored one on (TASK-0057), and each is checked, then stored or held back whole on the fetcher's
// reasons or the check's; a failing source fails alone. The return value is the run record the schedule keeps in
// job_runs.detail.
// TASK-0046: sources are fetched two at a time, then checked and stored one after another; a series can be held back alone.
import { checkPeriod } from "./check.ts";
import { nbsFetcher } from "./nbs.ts";
import { loadMetalPriceRegistry, type MetalPriceSource, type MetalPriceSourceKey, parseMetalPriceRegistry } from "./registry.ts";
import { fetchedAt, latestValues, newestStart, previousValues, storedValues, storePeriod } from "./store.ts";
import type { FetchedPeriod, PageGetter } from "./types.ts";

/** Each source's fetcher by its key: a source is added by its registry entry and a line here (TASK-0046). */
const FETCHERS: Partial<Record<MetalPriceSourceKey, typeof nbsFetcher>> = { nbs: nbsFetcher };

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
  /** Series the fetcher held back alone, with its reasons (TASK-0046); present only then, and the source did not succeed. */
  heldSeries?: { key: string; reason: string }[];
}

/** One source of the run record; TASK-0049's digest reads it, so later cards add fields only. */
export interface MetalPriceSourceRun {
  /** No error, no period held back or waiting for one, no series held back alone ("no new version" is a success; notes do not count). */
  ok: boolean;
  at: string;
  /** The first 1000 characters, as source collection keeps them; a character cut in half is replaced (the record is jsonb). */
  error: string | null;
  inserted: number;
  touched: number;
  periods: MetalPricePeriodRun[];
  /** Present when the fetcher returned no period, by its source's own rule (TASK-0046); a success. */
  note?: string;
}

/** A period's entry in the run record, before it is checked. */
function blank({ period, release }: FetchedPeriod): MetalPricePeriodRun {
  return { period: period.label, version: release.label, inserted: 0, touched: 0, changed: [], held: null, notes: [] };
}

/** `registry` is data as in industry/metal-prices.json (tests narrow it), checked whole like the file. */
export async function refreshMetalPrices(opts: { registry?: unknown; get?: PageGetter; now?: Date; fetchers?: typeof FETCHERS } = {}) {
  // A bad registry throws here, so the schedule records a failed run rather than skipping entries.
  const registry = opts.registry === undefined ? loadMetalPriceRegistry() : parseMetalPriceRegistry(opts.registry);
  const now = opts.now ?? new Date();
  const fetchers = opts.fetchers ?? FETCHERS;
  const record: Record<string, MetalPriceSourceRun> = {};
  // Two sources' requests at a time, as the upstream refresh overlaps them; once all are back, each source is checked and
  // stored in registry order, one after another. A source registered without a fetcher fails alone.
  const sources = registry.sources.filter((candidate) => candidate.enabled);
  const fetching = async (source: MetalPriceSource) => {
    const fetcher = fetchers[source.key]?.(registry, opts.get);
    if (!fetcher) throw new Error("没有这个来源的抓取器");
    return fetcher.fetch(newestStart, { now, fetchedAt });
  };
  const outcomes: PromiseSettledResult<FetchedPeriod[]>[] = [];
  for (let start = 0; start < sources.length; start += 2) outcomes.push(...(await Promise.allSettled(sources.slice(start, start + 2).map(fetching))));
  for (const [i, source] of sources.entries()) {
    const run: MetalPriceSourceRun = { ok: false, at: now.toISOString(), error: null, inserted: 0, touched: 0, periods: [] };
    record[source.key] = run;
    const items = registry.items.filter((item) => item.source === source.key && item.enabled);
    try {
      const outcome = outcomes[i]!;
      if (outcome.status === "rejected") throw outcome.reason;
      const fetched = outcome.value;
      if (!fetched.length) run.note = "一期都没返回（版本没变或没有要读的期），这次没有下载价格";
      // One period fetched twice (the list naming it under two addresses) fails the source: neither copy is guessed right.
      const twice = fetched.filter((one) => fetched.some((other) => other !== one && other.period.start === one.period.start));
      if (twice.length) throw new Error(`同一所属期抓到不止一份，不猜哪份为准：${twice.map((one) => `${one.period.label} ${one.release.url}`).join("、")}`);
      let waiting: string | null = null;
      for (const one of fetched) {
        const entry = blank(one);
        if (one.heldSeries?.length) entry.heldSeries = one.heldSeries;
        run.periods.push(entry);
        if (waiting) {
          entry.held = `等 ${waiting}`;
          continue;
        }
        // Series held back alone are left out as if stopped: not missing to the check, and not stored.
        const alone = new Set(one.heldSeries?.map((series) => series.key));
        const kept = items.filter((item) => !alone.has(item.key));
        const rows = one.rows.filter((row) => !alone.has(row.key));
        const newest = await newestStart(source.key);
        const previous = await previousValues(source.key, one.period.start, items);
        // The stored newest period read again unchanged passed its checks when stored, or was stored by force (TASK-0049):
        // compared with the period before again, a forced one would be held back at every run.
        // A new version of it repeating each series' latest stored value is taken the same way, and not stored (TASK-0046).
        const stored = await storedValues(source.key, one);
        const known = stored.size ? stored : await latestValues(source.key, one.period.start);
        const unchanged = one.period.start === newest && rows.length === kept.length && rows.every((row) => known.get(row.key) === row.value);
        const { reasons, notes } = checkPeriod({ fetched: { ...one, rows }, source, items: kept, previous, newest, compareWithPrevious: !unchanged, now });
        entry.notes = notes;
        const held = [...one.held, ...(kept.length ? [] : ["这一期启用的品种全被单独扣下"]), ...reasons];
        if (held.length) {
          entry.held = held.join("；");
          // A held new period keeps every later one waiting: with them stored it would be older than the store and never
          // get in. The stored newest period read again does not, as it is stored already.
          if (!newest || one.period.start > newest) waiting = one.period.label;
          continue;
        }
        if (unchanged && !stored.size) entry.notes.push("和库里已有的一样，不另存");
        else Object.assign(entry, await storePeriod(source, kept, { ...one, rows }, now));
        run.inserted += entry.inserted;
        run.touched += entry.touched;
      }
      run.ok = run.periods.every((entry) => entry.held === null && !entry.heldSeries);
    } catch (error) {
      run.error = (error instanceof Error ? error.message : String(error)).slice(0, 1000).toWellFormed();
    }
  }
  return record;
}
