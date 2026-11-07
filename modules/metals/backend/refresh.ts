// Each enabled price source reads the
// periods from the newest stored one on (TASK-0057), and each is checked, then stored or held back whole on the fetcher's
// reasons or the check's; a failing source fails alone. The return value is the run record the schedule keeps in
// job_runs.detail. A price jump holds that series alone and the next period releases or discards it (DEC-78补充 item 4):
// those decisions are written with the period, kept in publication.metal_price_holds and listed in the record.
import { checkPeriod } from "./check.ts";
import { cbrFetcher } from "./cbr.ts";
import { cochilcoFetcher } from "./cochilco.ts";
import { mofcomFetcher } from "./mofcom.ts";
import { nbsFetcher } from "./nbs.ts";
import { loadMetalPriceRegistry, type MetalPriceSource, type MetalPriceSourceKey, parseMetalPriceRegistry } from "./registry.ts";
import {
  acceptedValues,
  fetchedAt,
  type HoldDecisions,
  latestValues,
  newestStart,
  openHolds,
  previousValues,
  previewLatestValues,
  previewPeriod,
  storedValues,
  storePeriod,
  storePriceCheck,
  type StoredHold,
} from "./store.ts";
import type { FetchedPeriod, PageGetter } from "./types.ts";
import { safeFetcher } from "./safe.ts";
import { worldbankFetcher } from "./worldbank.ts";

/** Each source's fetcher by its key: a source is added by its registry entry and a line here (TASK-0046). */
const FETCHERS: Partial<Record<MetalPriceSourceKey, typeof nbsFetcher>> = {
  nbs: nbsFetcher,
  worldbank: worldbankFetcher,
  cbr: cbrFetcher,
  mofcom: mofcomFetcher,
  cochilco: cochilcoFetcher,
  safe: safeFetcher,
};

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
  /**
   * Series held back alone after a price jump, waiting for the next period (待下期确认); the period's other series are
   * stored and the source still succeeds. Present only then; `again` marks a hold of this period already on record.
   */
  pending?: { key: string; value: string; reason: string; again?: true }[];
  /** Earlier holds this period confirmed: the held value went in with this one. */
  released?: { key: string; period: string; value: string; reason: string }[];
  /** Earlier holds this period did not confirm (or a held period read again differently): the held value was dropped. */
  discarded?: { key: string; period: string; value: string; reason: string }[];
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
    /** Who decides holds and releases in the audit table: the schedule's job name unless a manual run says otherwise. */
    by?: string;
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
      // The source's open holds, kept up to date as each period decides them (in a dry run only here, never in the table).
      const holds = await openHolds(source.key);
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
        // A series held in an earlier period is decided against the held value, else against the last value that went in.
        const earlier = kept.filter((item) => (holds.get(item.key)?.periodStart ?? one.period.start) < one.period.start).map((item) => item.key);
        const accepted = await acceptedValues(source.key, one.period.start, earlier);
        for (const [start, values] of [...projected].sort(([a], [b]) => a.localeCompare(b)))
          for (const key of earlier) if (start < one.period.start && values.has(key)) accepted.set(key, values.get(key)!);
        const check = checkPeriod({
          fetched: { ...one, rows },
          source,
          items: kept,
          previous,
          newest,
          compareWithPrevious,
          holds,
          accepted,
          current: known,
          now,
        });
        const { reasons, notes } = check;
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
        // Jumps and holds still waiting stay out of the price table; everything else of the period goes in.
        const aside = new Set([...(check.jumps ?? []).map((jump) => jump.key), ...(check.still ?? []).map((hold) => hold.key)]);
        const repeat = unchanged && !stored.size;
        const storing = repeat ? [] : kept.filter((item) => !aside.has(item.key));
        const storedRows = rows.filter((row) => storing.some((item) => item.key === row.key));
        const series = (key: string) => kept.find((item) => item.key === key)!;
        const decisions: HoldDecisions = {
          by: opts.by ?? "metals.prices",
          period: one.period.label,
          hold: (check.jumps ?? []).map(({ key, value, was, reason }) => ({ item: series(key), value, was, reason })),
          release: (check.releases ?? []).map(({ key, reason }) => ({ item: series(key), hold: holds.get(key)!, reason })),
          discard: (check.discards ?? []).map(({ key, reason }) => ({ hold: holds.get(key)!, reason })),
        };
        const pending = [
          ...(check.still ?? []).map((hold) => ({ key: hold.key, value: hold.value, reason: "同一期再次读到同一数值，仍待下期确认", again: true as const })),
          ...decisions.hold.map(({ item, value, reason }) => ({ key: item.key, value, reason })),
        ];
        const decided = (list: { hold: StoredHold; reason: string }[]) =>
          list.map(({ hold, reason }) => ({ key: hold.key, period: hold.periodLabel, value: hold.value, reason }));
        if (pending.length) entry.pending = pending;
        if (decisions.release.length) entry.released = decided(decisions.release);
        if (decisions.discard.length) entry.discarded = decided(decisions.discard);
        const decides = decisions.hold.length + decisions.release.length + decisions.discard.length > 0;
        if (repeat) entry.notes.push("和库里已有的一样，不另存");
        if (opts.dryRun) {
          if (!repeat) Object.assign(entry, await previewPeriod(source, storing, { ...one, rows: storedRows }));
          projected.set(one.period.start, await previewLatestValues(source.key, { ...one, rows: storedRows }, now));
          // A released value is in the store from here on, as far as the later periods of this preview are concerned.
          for (const { hold } of decisions.release) {
            const values = projected.get(hold.periodStart) ?? (await latestValues(source.key, hold.periodStart));
            projected.set(hold.periodStart, values.set(hold.key, hold.value));
          }
        } else if (!repeat || decides) Object.assign(entry, await storePeriod(source, storing, { ...one, rows: storedRows }, now, decisions));
        for (const { hold } of [...decisions.discard, ...decisions.release]) holds.delete(hold.key);
        for (const { item, value } of decisions.hold)
          holds.set(item.key, {
            key: item.key,
            periodStart: one.period.start,
            periodEnd: one.period.end,
            periodLabel: one.period.label,
            value,
            releaseLabel: one.release.label,
            releaseUrl: one.release.url,
            releasedOn: one.release.releasedOn,
            heldAt: now,
          });
        run.inserted += entry.inserted;
        run.touched += entry.touched;
      }
      run.ok = run.periods.every((entry) => entry.held === null && !entry.heldSeries);
    } catch (error) {
      run.error = (error instanceof Error ? error.message : String(error)).slice(0, 1000).toWellFormed();
    }
    if (!opts.dryRun) {
      try {
        await storePriceCheck(source.key, opts.now ?? new Date(), run.ok, run.inserted > 0 || run.periods.some((period) => period.changed.length > 0));
      } catch {
        run.ok = false;
        run.error = [run.error, "检查记录未能保存，原报价保持"].filter(Boolean).join("；");
      }
    }
  }
  return record;
}
