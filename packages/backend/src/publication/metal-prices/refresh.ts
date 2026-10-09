// Metal price refresh (TASK-0069), shaped as the upstream leaderboard refresh: each enabled source's fetcher reads the
// periods from the newest stored one on (TASK-0057), and each is checked, then stored or held back whole on the fetcher's
// reasons or the check's; a failing source fails alone. The return value is the run record the schedule keeps in
// job_runs.detail.
import { checkPeriod } from "./check.ts";
import { cbrFetcher } from "./cbr.ts";
import { mofcomFetcher } from "./mofcom.ts";
import { nbsFetcher } from "./nbs.ts";
import { loadMetalPriceRegistry, type MetalPriceSource, type MetalPriceSourceKey, parseMetalPriceRegistry } from "./registry.ts";
import { fetchedAt, latestValues, newestStart, previousValues, previewLatestValues, previewPeriod, storedValues, storePeriod } from "./store.ts";
import type { FetchedPeriod, PageGetter } from "./types.ts";
import { worldbankFetcher } from "./worldbank.ts";

/** Each source's fetcher by its key: a source is added by its registry entry and a line here (TASK-0046). */
const FETCHERS: Partial<Record<MetalPriceSourceKey, typeof nbsFetcher>> = { nbs: nbsFetcher, worldbank: worldbankFetcher, cbr: cbrFetcher, mofcom: mofcomFetcher };

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

/** One source of the run record; TASK-0071's digest reads it, so later cards add fields only. */
export interface MetalPriceSourceRun {
  /** No error, no period held back or waiting for one, no series held back alone ("no new version" is a success; notes do not count). */
  ok: boolean;
  at: string;
  /** The first 1000 characters, as source collection keeps them; a character cut in half is replaced (the record is jsonb). */
  error: string | null;
  inserted: number;
  touched: number;
  periods: MetalPricePeriodRun[];
  /** "这次一期都没有返回" when the fetcher returned no period, whatever the reason: the refresh cannot tell (TASK-0046). A success. */
  note?: string;
  /** Only this period skips comparison with the previous one (TASK-0076); all other checks still apply. */
  forced?: { period: string; skipped: ["行数", "倍数"] };
}

/** A period's entry in the run record, before it is checked. */
function blank({ period, release }: FetchedPeriod): MetalPricePeriodRun {
  return { period: period.label, version: release.label, inserted: 0, touched: 0, changed: [], held: null, notes: [] };
}

/** `registry` is data as in industry/metal-prices.json (tests narrow it), checked whole like the file. */
export async function refreshMetalPrices(
  opts: {
    registry?: unknown;
    get?: PageGetter;
    now?: Date;
    fetchers?: typeof FETCHERS;
    source?: string;
    dryRun?: boolean;
    force?: { periodStart: string; held: string[] };
  } = {},
) {
  // A bad registry throws here, so the schedule records a failed run rather than skipping entries.
  const registry = opts.registry === undefined ? loadMetalPriceRegistry() : parseMetalPriceRegistry(opts.registry);
  const now = opts.now ?? new Date();
  const record: Record<string, MetalPriceSourceRun> = {};
  // Requests go out two sources at a time, as upstream; once all are back, each source is checked and stored in turn, in registry order.
  const sources = registry.sources.filter((candidate) => candidate.enabled && (opts.source === undefined || candidate.key === opts.source));
  if (opts.source !== undefined && !sources.length) throw new Error(`来源 ${opts.source} 不存在或未启用`);
  if (opts.force && !opts.source) throw new Error("强制入库必须指定一个来源");
  if (opts.force && !opts.force.held.length) throw new Error(`强制所属期 ${opts.force.periodStart} 没对上：不在被扣下清单里`);
  const fetching = async (source: MetalPriceSource) => {
    const fetcher = (opts.fetchers ?? FETCHERS)[source.key]?.(registry, opts.get);
    if (!fetcher) throw new Error("没有这个来源的抓取器");
    return fetcher.fetch(newestStart, { now, fetchedAt: opts.dryRun || opts.force ? async () => null : fetchedAt });
  };
  const outcomes: PromiseSettledResult<FetchedPeriod[]>[] = [];
  for (let start = 0; start < sources.length; start += 2) outcomes.push(...(await Promise.allSettled(sources.slice(start, start + 2).map(fetching))));
  // Refuse a mismatched manual request before any period can write; recordRun must mark the whole run failed.
  const forcedOutcome = opts.force ? outcomes[0] : undefined;
  if (forcedOutcome?.status === "fulfilled") {
    const target = forcedOutcome.value.find((one) => one.period.start === opts.force!.periodStart);
    if (!target || !opts.force!.held.includes(target.period.label)) throw new Error(`强制所属期 ${opts.force!.periodStart} 没对上：未抓到或不在被扣下清单里`);
  }
  for (const [i, source] of sources.entries()) {
    const run: MetalPriceSourceRun = { ok: false, at: now.toISOString(), error: null, inserted: 0, touched: 0, periods: [] };
    record[source.key] = run;
    const items = registry.items.filter((item) => item.source === source.key && item.enabled);
    try {
      const outcome = outcomes[i]!;
      if (outcome.status === "rejected") throw outcome.reason;
      const fetched = outcome.value;
      if (opts.force) run.forced = { period: fetched.find((one) => one.period.start === opts.force!.periodStart)!.period.label, skipped: ["行数", "倍数"] };
      if (!fetched.length) run.note = "这次一期都没有返回";
      // One period fetched twice (the list naming it under two addresses) fails the source: neither copy is guessed right.
      const twice = fetched.filter((one) => fetched.some((other) => other !== one && other.period.start === one.period.start));
      if (twice.length) throw new Error(`同一所属期抓到不止一份，不猜哪份为准：${twice.map((one) => `${one.period.label} ${one.release.url}`).join("、")}`);
      let waiting: string | null = null;
      const projected = new Map<string, Map<string, string>>();
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
        const newest = [...projected.keys(), (await newestStart(source.key)) ?? ""].sort().at(-1) || null;
        const previousStart = [...projected.keys()]
          .filter((start) => start < one.period.start)
          .sort()
          .at(-1);
        const previous = previousStart ? projected.get(previousStart)! : await previousValues(source.key, one.period.start, items);
        // The stored newest period read again unchanged passed its checks when stored, or was stored by force (TASK-0076):
        // compared with the period before again, a forced one would be held back at every run.
        // A new version of it repeating each series' latest stored value is taken the same way, and not stored (TASK-0046).
        const stored = await storedValues(source.key, one);
        const known = stored.size ? stored : await latestValues(source.key, one.period.start);
        const unchanged = one.period.start === newest && rows.length === kept.length && rows.every((row) => known.get(row.key) === row.value);
        const compareWithPrevious = !unchanged && one.period.start !== opts.force?.periodStart;
        const { reasons, notes } = checkPeriod({ fetched: { ...one, rows }, source, items: kept, previous, newest, compareWithPrevious, now });
        entry.notes = [...(one.notes ?? []), ...notes];
        const held = [...one.held, ...(kept.length ? [] : ["这一期启用的品种全被单独扣下"]), ...reasons];
        if (held.length) {
          entry.held = held.join("；");
          // A held new period keeps every later one waiting: with them stored it would be older than the store and never
          // get in. The stored newest period read again does not, as it is stored already.
          // A rejected daily fixing must not indefinitely block later days; daily gaps are not back-filled.
          if (source.frequency !== "day" && (!newest || one.period.start > newest)) waiting = one.period.label;
          continue;
        }
        if (unchanged && !stored.size) entry.notes.push("和库里已有的一样，不另存");
        else Object.assign(entry, opts.dryRun ? await previewPeriod(source, kept, { ...one, rows }) : await storePeriod(source, kept, { ...one, rows }, now));
        if (opts.dryRun) projected.set(one.period.start, await previewLatestValues(source.key, { ...one, rows: unchanged && !stored.size ? [] : rows }, now));
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
