// Which changelog entries carry a showcase (TASK-0367). A major update finds its own by version; any other entry its film
// by its moment (date and time), which the reader copy never rewrites, unlike the title. Each entry keeps its own: a
// later showcase is added beside the earlier ones, never in their place (Owner 2026-11-21). Films (scenes and recording)
// are registered in films/recordings.server.ts and come with the page's data.
import type { ReactNode } from "react";
import type { FilmReel } from "./films/context";
import { Film } from "./player/Film";
import { type Release, releaseKey } from "./release";
import { Showcase202611 } from "./Showcase202611";

const BY_VERSION: Record<string, () => ReactNode> = {
  "2026.11": () => <Showcase202611 />,
};

/** The entry's showcase: its major update's by version, else its own film among the page's films. */
export function showcaseFor(release: Release, films: Readonly<Record<string, FilmReel>>): (() => ReactNode) | undefined {
  const own = release.version ? BY_VERSION[release.version] : undefined;
  if (own) return own;
  const film = films[releaseKey(release)];
  return film ? () => <Film script={film.script} data={film.data} id={`film-${releaseKey(release).replace(/\W/g, "")}`} /> : undefined;
}
