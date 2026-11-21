// Real figures a changelog showcase can show (TASK-0367, Owner 2026-11-21: “真实数据那种”). The changelog loader reads
// them from the public site API on the server and keeps only what the blocks draw, so the page carries a few hundred
// bytes of each instead of the full answers. A block whose read failed is null and draws its still sketch instead.

/** One of the newest items of a country, as the home page's country block lists it. */
export interface LiveItem {
  id: string;
  title: string;
  /** The English title, where the item has one (English interface). */
  titleEn: string | null;
  source: string;
  /** When it entered the list (ISO). */
  at: string;
}

/** The newest items of one country (the pool's lean read, the same five the home page opens with). */
export interface LiveCountry {
  code: string;
  items: LiveItem[];
}

/** One published period of a price: its label as the source names it and the price as published. */
export interface LivePricePoint {
  label: string;
  end: string;
  value: string;
}

/** One metal's trend line: official published periods only, oldest first, never interpolated. */
export interface LiveMetal {
  key: string;
  /** The metal's name (“铜”) and the quote's own title (“国际 · LME 现货价”). */
  metal: string;
  quote: string;
  source: string;
  unit: string;
  decimals: number | null;
  points: LivePricePoint[];
}

/** The hot list as it stands: how many events qualify in its window. */
export interface LiveHot {
  count: number;
  windowHours: number;
  computedAt: string | null;
}

export interface LiveData {
  countries: LiveCountry[] | null;
  metals: LiveMetal[] | null;
  hot: LiveHot | null;
}

export type LiveBlock = keyof LiveData;

export const NO_LIVE_DATA: LiveData = { countries: null, metals: null, hot: null };
