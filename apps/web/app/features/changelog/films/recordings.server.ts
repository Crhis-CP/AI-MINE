// Every changelog film by its entry's moment (TASK-0367): its scenes (script.ts) and the figures captured for it once
// (snapshot.json, scripts/changelog-film-snapshot.ts). Each film keeps its own; adding a film adds a line here and never
// touches the others, so an older film stays exactly as it was recorded. Read on the server only: the loader hands the
// page the films of the entries it shows.
import type { FilmData } from "../blocks/types";
import type { FilmReel } from "./context";
import { FILM_20261115 } from "./2026-11-15/script";
import recording20261115 from "./2026-11-15/snapshot.json";

const FILMS: Readonly<Record<string, FilmReel>> = {
  "2026-11-15T02:24": { script: FILM_20261115, data: recording20261115 satisfies FilmData },
};

/** The films among these entries' moments. */
export function filmsFor(moments: readonly string[]): Record<string, FilmReel> {
  return Object.fromEntries(moments.filter((moment) => FILMS[moment]).map((moment) => [moment, FILMS[moment]!]));
}
