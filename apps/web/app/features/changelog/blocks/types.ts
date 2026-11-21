// The figures a changelog film draws (TASK-0367). A film is a recording of one moment (Owner 2026-11-21: like a video,
// independent of the live site): its figures were captured once from the site's public API by
// scripts/changelog-film-snapshot.ts and are kept beside its scenes (films/<date>/snapshot.json). Ordinary changes on
// the site never change them; a manual takedown still wins (rule 7, films/redact.ts). Headlines are shown, not linked.

/** One of the newest items of a country, as the home page's country block listed it then. */
export interface FilmItem {
  title: string;
  /** The English title, where the item had one then (English interface). */
  titleEn: string | null;
  source: string;
  /** When it entered the list (ISO). */
  at: string;
  /** Taken down by hand since the recording: drawn as “（该条已撤下）”, with no title, source or time. */
  removed?: boolean;
}

/** The newest items of one country at the time of the recording. */
export interface FilmCountry {
  code: string;
  items: FilmItem[];
}

/** One published period of a price: its label as the source names it, its dates and the price as published. */
export interface FilmPricePoint {
  label: string;
  start: string;
  end: string;
  value: string;
}

/** One metal's trend line: officially published periods only, oldest first, never interpolated. */
export interface FilmMetal {
  /** The metal's name (“铜”) and the quote's own title (“国际 · LME 现货价”). */
  metal: string;
  quote: string;
  source: string;
  unit: string;
  decimals: number | null;
  points: FilmPricePoint[];
}

/** The hot list then: how many events qualified in its window. */
export interface FilmHot {
  count: number;
  windowHours: number;
  computedAt: string | null;
}

export interface FilmData {
  /** When the figures were captured (ISO): the film says it is a recording of that day. */
  takenAt: string;
  countries: FilmCountry[];
  metals: FilmMetal[];
  hot: FilmHot | null;
}
