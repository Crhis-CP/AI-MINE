import { createContext } from "react";
import type { FilmData } from "../blocks/types";
import type { Script } from "../player/types";

/** One changelog film: its scenes and the figures recorded for it. */
export interface FilmReel {
  script: Script;
  data: FilmData;
}

/**
 * Each film by its entry's moment (“2026-11-15T02:24”), as the changelog loader hands them to the page: the scenes and
 * the recording travel with the page's data, so neither is in the page's scripts.
 */
export const FilmRecordings = createContext<Readonly<Record<string, FilmReel>>>({});
