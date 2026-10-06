// Shapes of the metal price fetchers and their plausibility check (TASK-0057), after the upstream leaderboard fetchers
// ({sourceKeys, fetch()}, one per source). The World Bank and IMF fetchers return the same; the refresh calls them so.
import type { MetalPriceItem, MetalPriceSource, MetalPriceSourceKey } from "./registry.ts";

/** A page request: guardedFetch in production, fixtures by address in tests. `url` is where any redirects ended. */
export type PageGetter = (url: string) => Promise<{ status: number; url: string; text(): string }>;

/** A period as its source names it: calendar days, both ends included. */
export interface Period {
  start: string;
  end: string;
  label: string;
}

/** A period the source lists. Its release's title on the list is the version (release_label). */
export interface ListedPeriod {
  source: MetalPriceSourceKey;
  period: Period;
  release: { label: string; url: string; releasedOn: string | null };
}

export interface PriceRow {
  key: string;
  unit: string;
  /** As the source writes it, thousands separators dropped and nothing else. */
  value: string;
}

/** A listed period read from its release page, before any plausibility check. */
export interface FetchedPeriod extends ListedPeriod {
  /** The release's title as its own page gives it. */
  title: string;
  /** The leading header cells of the price table, NFKC with no whitespace. */
  header: string[];
  /** Enabled registered series only, in the table's order. */
  rows: PriceRow[];
  /** Reasons the fetcher itself found to hold the period back (two copies of the table that differ). */
  held: string[];
}

export interface Fetcher {
  sourceKeys: MetalPriceSourceKey[];
  /**
   * Lists what was published and reads the periods `pick` keeps, in its order. Throws on an error status, an address
   * or redirect off the source's https hosts, a list naming no period or a release without its price table (INV-33).
   */
  fetch(pick: (listed: ListedPeriod[]) => Promise<ListedPeriod[]>): Promise<FetchedPeriod[]>;
}

export interface PeriodCheckInput {
  fetched: FetchedPeriod;
  source: MetalPriceSource;
  /** The source's enabled series. */
  items: MetalPriceItem[];
  /** The still enabled series' values in the stored period before this one; absent before there is one. */
  previous?: ReadonlyMap<string, string> | null;
  /** Start of the source's newest stored period; absent before the first. */
  newest?: string | null;
  now: Date;
}

export interface PeriodCheckResult {
  /** Why the period is held back whole; empty: it passes. */
  held: string[];
  /** What was not checked and why ("没有上一期"). */
  notes: string[];
}
