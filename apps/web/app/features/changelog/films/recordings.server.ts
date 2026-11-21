// Every changelog film by its entry's moment (TASK-0367): its scenes (script.ts), the figures captured for it once
// (snapshot.json, scripts/changelog-film-snapshot.ts) and its takedown list (redactions.json, rule 7). Each film keeps
// its own; adding a film adds a line here and never touches the others, so an older film stays as it was recorded.
// Read on the server only: the loader hands the page the films of the entries it shows, takedowns already applied.
import type { FilmData } from "../blocks/types";
import type { FilmReel } from "./context";
import { FILM_20261115 } from "./2026-11-15/script";
import takenDown20261115 from "./2026-11-15/redactions.json";
import recording20261115 from "./2026-11-15/snapshot.json";
import { redact } from "./redact";

const FILMS: Readonly<Record<string, FilmReel>> = {
  "2026-11-15T02:24": { script: FILM_20261115, data: redact(recording20261115 satisfies FilmData, takenDown20261115 as string[]) },
};

/** The films among these entries' moments. */
export function filmsFor(moments: readonly string[]): Record<string, FilmReel> {
  return Object.fromEntries(moments.filter((moment) => FILMS[moment]).map((moment) => [moment, FILMS[moment]!]));
}
