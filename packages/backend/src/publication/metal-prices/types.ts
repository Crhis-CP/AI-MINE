// Shapes of the metal price fetchers and their plausibility check (TASK-0057), after the upstream leaderboard fetchers
// ({sourceKeys, fetch()}, one per source). The World Bank and IMF fetchers return the same and the refresh calls them
// so; later cards add fields, never rename one.
import type { MetalPriceItem, MetalPriceSource, MetalPriceSourceKey } from "./registry.ts";

/** A page request: guardedFetch in production, fixtures by address in tests. `url` is where any redirects ended. */
export type PageGetter = (
  url: string,
  opts?: { maxBytes?: number; maxRedirects?: number },
) => Promise<{ status: number; url: string; text(): string; body?: Buffer }>;

/** A period as its source names it: calendar days, both ends included. */
export interface Period {
  start: string;
  end: string;
  label: string;
}

/** As the source writes it: whether the unit and value are what they should be is the check's to say. */
export interface PriceRow {
  key: string;
  unit: string;
  /** Surrounding whitespace and thousands separators dropped, nothing else. */
  value: string;
}

/** A period read from its release, before the plausibility check. */
export interface FetchedPeriod {
  source: MetalPriceSourceKey;
  period: Period;
  /** The release's title on the list is the version (release_label); the date is the one the list gives it. */
  release: { label: string; url: string; releasedOn: string | null };
  /** Enabled registered series only, in the table's order. */
  rows: PriceRow[];
  /** The source's own reasons to hold the period back whole, from pages that read fine; empty: none. */
  held: string[];
  /** Fetcher observations that do not hold a period back. */
  notes?: string[];
  /** Series held back alone, with the source's reasons (TASK-0046): their rows are neither checked nor stored. */
  heldSeries?: { key: string; reason: string }[];
}

/** The run's clock, and when a version (release) of a source was last fetched: null while no row of it is stored (TASK-0046). */
export type FetchContext = { now: Date; fetchedAt(source: MetalPriceSourceKey, release: string): Promise<Date | null> };

export interface Fetcher {
  sourceKeys: MetalPriceSourceKey[];
  /**
   * The periods to check, oldest first: the stored newest one (`newest` gives its start) again and every later one, or
   * the newest listed when nothing is stored (null), plus its predecessor where the source card permits; no earlier back-fill.
   * Throws when a page cannot be read as expected:
   * an error status, an address or redirect off the source's https hosts, a list naming no period, no price table (INV-33).
   */
  fetch(newest: (source: MetalPriceSourceKey) => Promise<string | null>, context?: FetchContext): Promise<FetchedPeriod[]>;
}

export interface PeriodCheckInput {
  fetched: FetchedPeriod;
  source: MetalPriceSource;
  /** The source's enabled series, less any the fetcher holds back alone (TASK-0046). */
  items: MetalPriceItem[];
  /** The still enabled series' values in the stored period before this one; absent before there is one. */
  previous?: ReadonlyMap<string, string> | null;
  /** Start of the source's newest stored period; absent before the first. */
  newest?: string | null;
  /** False (the stored newest period read again unchanged) skips the row count and ratio checks, with no note. */
  compareWithPrevious?: boolean;
  now: Date;
}

export interface PeriodCheckResult {
  /** Why the period is held back whole, beside the fetcher's own; empty: it passes. */
  reasons: string[];
  /** What was not compared and why ("没有上一期"); recorded with the period, never holding it back. */
  notes: string[];
}
