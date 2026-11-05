// Metal price rows (TASK-0069): a checked period is added or brought up to date in one transaction, and nothing is ever
// deleted. Values go in and come out as text (value::text): the driver reads numeric as a JS number, which would lose
// the figure as the source wrote it (packages/platform/config/src/index.ts). Only enabled series are written.
import { sql } from "@amp/backend/db";
import type { MetalPriceItem, MetalPriceSource } from "./registry.ts";
import type { FetchedPeriod, PriceHold } from "./types.ts";

/** A value held back alone as publication.metal_price_holds keeps it: enough to add it to the price table on release. */
export interface StoredHold extends PriceHold {
  periodEnd: string;
  releaseLabel: string;
  releaseUrl: string;
  releasedOn: string | null;
  heldAt: Date;
}

/**
 * What a stored period does to the source's holds, in the same transaction as its rows (DEC-78补充 item 4): series it
 * holds back alone, earlier holds it releases (the held row goes into the price table beside the new one) or discards.
 * `by` is who decided (the schedule, or the manual run), `period` the deciding period's label.
 */
export interface HoldDecisions {
  by: string;
  period: string;
  hold: { item: MetalPriceItem; value: string; was: string; reason: string }[];
  release: { item: MetalPriceItem; hold: StoredHold; reason: string }[];
  discard: { hold: StoredHold; reason: string }[];
}

/** The source's open holds by series; at most one per series. */
export async function openHolds(source: string): Promise<Map<string, StoredHold>> {
  const rows = await sql<
    {
      series_key: string;
      period_start: string;
      period_end: string;
      period_label: string;
      value: string;
      release_label: string;
      release_url: string;
      released_on: string | null;
      held_at: Date;
    }[]
  >`SELECT series_key, period_start::text, period_end::text, period_label, value::text AS value, release_label, release_url,
      released_on::text, held_at FROM publication.metal_price_holds WHERE source = ${source} AND status = 'held'`;
  return new Map(
    rows.map((row) => [
      row.series_key,
      {
        key: row.series_key,
        periodStart: row.period_start,
        periodEnd: row.period_end,
        periodLabel: row.period_label,
        value: row.value,
        releaseLabel: row.release_label,
        releaseUrl: row.release_url,
        releasedOn: row.released_on,
        heldAt: row.held_at,
      },
    ]),
  );
}

/** Every open hold, oldest first, for the informational alert. */
export async function allOpenHolds() {
  return sql<{ source: string; series_key: string; period_label: string; value: string; compared_value: string; reason: string; held_at: Date }[]>`
    SELECT source, series_key, period_label, value::text AS value, compared_value::text AS compared_value, reason, held_at
    FROM publication.metal_price_holds WHERE status = 'held' ORDER BY held_at, series_key`;
}

/** Each given series' latest value stored in a period before `start` (its newest version): the last value that went in. */
export async function acceptedValues(source: string, start: string, keys: string[]): Promise<Map<string, string>> {
  if (!keys.length) return new Map();
  const rows = await sql<{ series_key: string; value: string }[]>`
    SELECT DISTINCT ON (series_key) series_key, value::text AS value FROM publication.metal_prices
    WHERE source = ${source} AND series_key IN ${sql(keys)} AND period_start < ${start}
    ORDER BY series_key, period_start DESC, first_fetched_at DESC`;
  return new Map(rows.map((row) => [row.series_key, row.value]));
}

/** A completed source check is separate from re-reading or changing its current price workbook. */
export async function storePriceCheck(source: string, checkedAt: Date, ok: boolean, changed: boolean) {
  await sql`INSERT INTO publication.metal_price_checks(source,checked_at,ok,changed)
    VALUES(${source},${checkedAt},${ok},${changed}) ON CONFLICT(source) DO UPDATE
    SET checked_at=EXCLUDED.checked_at,ok=EXCLUDED.ok,changed=EXCLUDED.changed
    WHERE metal_price_checks.checked_at<=EXCLUDED.checked_at`;
}

/** The start of the source's newest stored period; null before its first. */
export async function newestStart(source: string): Promise<string | null> {
  const [row] = await sql<{ start: string | null }[]>`SELECT max(period_start)::text AS start FROM publication.metal_prices WHERE source = ${source}`;
  return row?.start ?? null;
}

/** The given series' values in the newest period stored before `start`, from that period's latest version. */
export async function previousValues(source: string, start: string, items: MetalPriceItem[]): Promise<Map<string, string>> {
  const rows = await sql<{ series_key: string; value: string }[]>`
    SELECT DISTINCT ON (series_key) series_key, value::text AS value FROM publication.metal_prices
    WHERE source = ${source} AND period_start = (SELECT max(period_start) FROM publication.metal_prices WHERE source = ${source} AND period_start < ${start})
    ORDER BY series_key, first_fetched_at DESC`;
  return new Map(rows.filter((row) => items.some((item) => item.key === row.series_key)).map((row) => [row.series_key, row.value]));
}

/** The values stored for the period in this version (release), by series; empty when it is not stored. */
export async function storedValues(source: string, { period, release }: Pick<FetchedPeriod, "period" | "release">): Promise<Map<string, string>> {
  const rows = await sql<{ series_key: string; value: string }[]>`
    SELECT series_key, value::text AS value FROM publication.metal_prices
    WHERE source = ${source} AND period_start = ${period.start} AND release_label = ${release.label}`;
  return new Map(rows.map((row) => [row.series_key, row.value]));
}

/** Each series' value in the period's newest stored version; empty when the period is not stored (TASK-0046). */
export async function latestValues(source: string, start: string): Promise<Map<string, string>> {
  const rows = await sql<{ series_key: string; value: string }[]>`
    SELECT DISTINCT ON (series_key) series_key, value::text AS value FROM publication.metal_prices
    WHERE source = ${source} AND period_start = ${start} ORDER BY series_key, first_fetched_at DESC`;
  return new Map(rows.map((row) => [row.series_key, row.value]));
}

/** When a version (release) of the source was last fetched; null while no row of it is stored (TASK-0046). */
export async function fetchedAt(source: string, release: string): Promise<Date | null> {
  const [row] = await sql<{ at: Date | null }[]>`
    SELECT max(fetched_at) AS at FROM publication.metal_prices WHERE source = ${source} AND release_label = ${release}`;
  return row?.at ?? null;
}

/** The same-version changes storePeriod would make, without a transaction or any writes (TASK-0076). */
export async function previewPeriod(source: MetalPriceSource, items: MetalPriceItem[], fetched: FetchedPeriod) {
  const before = await storedValues(source.key, fetched);
  const rows = items.map((item) => ({ key: item.key, value: fetched.rows.find((row) => row.key === item.key)!.value.replace(/^0+(?=\d)/, "") }));
  return {
    inserted: rows.filter((row) => !before.has(row.key)).length,
    touched: rows.filter((row) => before.get(row.key) === row.value).length,
    changed: rows
      .filter((row) => before.has(row.key) && before.get(row.key) !== row.value)
      .map((row) => ({ key: row.key, before: before.get(row.key)!, after: row.value })),
  };
}

/** Latest-version values after a simulated write; touching an older version does not make it the latest. */
export async function previewLatestValues(source: string, { period, release, rows }: FetchedPeriod, now: Date) {
  const saved = await sql<{ series_key: string; value: string; release_label: string; first_fetched_at: Date }[]>`
    SELECT series_key, value::text AS value, release_label, first_fetched_at FROM publication.metal_prices
    WHERE source = ${source} AND period_start = ${period.start} ORDER BY first_fetched_at DESC`;
  const values = new Map([...saved].reverse().map((row) => [row.series_key, row.value]));
  for (const row of rows) {
    const latest = saved.find((one) => one.series_key === row.key);
    const exists = saved.some((one) => one.series_key === row.key && one.release_label === release.label);
    if (!latest || latest.release_label === release.label || (!exists && now > latest.first_fetched_at))
      values.set(row.key, row.value.replace(/^0+(?=\d)/, ""));
  }
  return values;
}

/**
 * A row of the same version (release) read again moves fetched_at only, or takes the new value too when the source now
 * writes it differently (before and after are returned); a new version of a period is a row beside the old one.
 * `items` are the series to store (less any held back alone); `holds` are written in the same transaction.
 */
export async function storePeriod(source: MetalPriceSource, items: MetalPriceItem[], fetched: FetchedPeriod, now: Date, holds?: HoldDecisions) {
  const { period, release } = fetched;
  const fixed = { source: source.key, currency: source.currency, period_type: source.frequency, period_start: period.start, period_end: period.end };
  const seen = { period_label: period.label, release_label: release.label, release_url: release.url, released_on: release.releasedOn };
  const series = (item: MetalPriceItem) => ({
    series_key: item.key,
    name_zh: item.name,
    grade: item.grade,
    benchmark: item.benchmark,
    delivery_basis: item.deliveryBasis,
    unit: item.unit,
    source_unit: item.sourceUnit,
  });
  const rows = items.map((item) => {
    const value = fetched.rows.find((row) => row.key === item.key)!.value;
    return { ...series(item), value, ...fixed, ...seen, first_fetched_at: now, fetched_at: now };
  });
  return sql.begin(async (tx) => {
    const stored = await tx<{ series_key: string; value: string }[]>`
      SELECT series_key, value::text AS value FROM publication.metal_prices
      WHERE source = ${source.key} AND period_start = ${period.start} AND release_label = ${release.label} FOR UPDATE`;
    const before = new Map(stored.map((row) => [row.series_key, row.value]));
    const after = rows.length
      ? await tx<{ series_key: string; value: string }[]>`
      INSERT INTO publication.metal_prices ${tx(rows)}
      ON CONFLICT (series_key, period_start, release_label) DO UPDATE SET value = EXCLUDED.value, fetched_at = EXCLUDED.fetched_at
      RETURNING series_key, value::text AS value`
      : [];
    const changed = after.filter((row) => before.has(row.series_key) && before.get(row.series_key) !== row.value);
    if (holds) {
      const decided = { decided_at: now, decided_by: holds.by, decided_period: holds.period };
      for (const { hold, reason } of holds.discard)
        await tx`UPDATE publication.metal_price_holds SET ${tx({ status: "discarded", decision: reason, ...decided })}
          WHERE series_key = ${hold.key} AND status = 'held'`;
      for (const { item, hold, reason } of holds.release) {
        // The held value goes in as the version it was read from, first fetched when it was held.
        const row = {
          ...series(item),
          value: hold.value,
          ...fixed,
          period_start: hold.periodStart,
          period_end: hold.periodEnd,
          period_label: hold.periodLabel,
          release_label: hold.releaseLabel,
          release_url: hold.releaseUrl,
          released_on: hold.releasedOn,
          first_fetched_at: hold.heldAt,
          fetched_at: hold.heldAt,
        };
        await tx`INSERT INTO publication.metal_prices ${tx(row)}
          ON CONFLICT (series_key, period_start, release_label) DO UPDATE SET value = EXCLUDED.value`;
        await tx`UPDATE publication.metal_price_holds SET ${tx({ status: "released", decision: reason, ...decided })}
          WHERE series_key = ${hold.key} AND status = 'held'`;
      }
      for (const { item, value, was, reason } of holds.hold)
        await tx`INSERT INTO publication.metal_price_holds ${tx({
          source: source.key,
          series_key: item.key,
          period_start: period.start,
          period_end: period.end,
          period_label: period.label,
          release_label: release.label,
          release_url: release.url,
          released_on: release.releasedOn,
          value,
          compared_value: was,
          reason,
          held_at: now,
          held_by: holds.by,
        })}`;
    }
    return {
      inserted: after.filter((row) => !before.has(row.series_key)).length,
      touched: after.filter((row) => before.get(row.series_key) === row.value).length,
      changed: changed.map((row) => ({ key: row.series_key, before: before.get(row.series_key)!, after: row.value })),
    };
  });
}
