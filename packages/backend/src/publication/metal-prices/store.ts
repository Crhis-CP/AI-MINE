// Metal price rows (TASK-0069): a checked period is added or brought up to date in one transaction, and nothing is ever
// deleted. Values go in and come out as text (value::text): the driver reads numeric as a JS number, which would lose
// the figure as the source wrote it (packages/platform/config/src/index.ts). Only enabled series are written.
import { dbOf } from "../../db.ts";
import type { MetalPriceItem, MetalPriceSource } from "./registry.ts";
import type { FetchedPeriod } from "./types.ts";

const sql = dbOf("publication");

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

/**
 * A row of the same version (release) read again moves fetched_at only, or takes the new value too when the source now
 * writes it differently (before and after are returned); a new version of a period is a row beside the old one.
 */
export async function storePeriod(source: MetalPriceSource, items: MetalPriceItem[], fetched: FetchedPeriod, now: Date) {
  const { period, release } = fetched;
  const fixed = { source: source.key, currency: source.currency, period_type: source.frequency, period_start: period.start, period_end: period.end };
  const seen = { period_label: period.label, release_label: release.label, release_url: release.url, released_on: release.releasedOn };
  const rows = items.map((item) => {
    const series = { series_key: item.key, name_zh: item.name, grade: item.grade, benchmark: item.benchmark, delivery_basis: item.deliveryBasis };
    const value = fetched.rows.find((row) => row.key === item.key)!.value;
    return { ...series, unit: item.unit, source_unit: item.sourceUnit, value, ...fixed, ...seen, first_fetched_at: now, fetched_at: now };
  });
  return sql.begin(async (tx) => {
    const stored = await tx<{ series_key: string; value: string }[]>`
      SELECT series_key, value::text AS value FROM publication.metal_prices
      WHERE source = ${source.key} AND period_start = ${period.start} AND release_label = ${release.label} FOR UPDATE`;
    const before = new Map(stored.map((row) => [row.series_key, row.value]));
    const after = await tx<{ series_key: string; value: string }[]>`
      INSERT INTO publication.metal_prices ${tx(rows)}
      ON CONFLICT (series_key, period_start, release_label) DO UPDATE SET value = EXCLUDED.value, fetched_at = EXCLUDED.fetched_at
      RETURNING series_key, value::text AS value`;
    const changed = after.filter((row) => before.has(row.series_key) && before.get(row.series_key) !== row.value);
    return {
      inserted: after.filter((row) => !before.has(row.series_key)).length,
      touched: after.filter((row) => before.get(row.series_key) === row.value).length,
      changed: changed.map((row) => ({ key: row.series_key, before: before.get(row.series_key)!, after: row.value })),
    };
  });
}
