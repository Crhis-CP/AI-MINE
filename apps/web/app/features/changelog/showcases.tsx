// Which changelog entries carry a showcase (TASK-0367). A major update finds its own by version; any other entry by its
// moment (date and time), which the reader copy never rewrites, unlike the title. A showcase names the real figures it
// draws, so the page reads only those, and the release lines its scenes already show, so they are not listed again.
import type { ReactNode } from "react";
import { useLiveData } from "./live/context";
import type { LiveBlock } from "./live/types";
import { Film } from "./player/Film";
import type { Script } from "./player/types";
import { type Release, releaseKey } from "./release";
import { Showcase202611 } from "./Showcase202611";

export interface Showcase {
  render: (release: Release) => ReactNode;
  /** The real figures it draws (read by the changelog loader, in parallel, with short deadlines). */
  live: readonly LiveBlock[];
  /** Release lines already shown by the showcase, left out of the list under it. */
  covers: readonly RegExp[];
}

/** The 2026-11-14/15 update as a short film (Owner 2026-11-21: “真实数据那种”“点开能看”). */
export const FILM_20261115: Script = {
  title: "首页先看本国，金属走势、热点榜与法规并排",
  scenes: [
    { kind: "title", ms: 3500, heading: "这次更新" },
    { kind: "feed", ms: 8000, heading: "首页先看本国", line: /本国最新的 5 条/, to: "/" },
    { kind: "trend", ms: 7000, heading: "金属走势线", line: /走势线/, to: "/metals" },
    { kind: "count", ms: 5500, heading: "热点榜", line: /72 小时/, to: "/hot" },
    { kind: "sideBySide", ms: 6000, heading: "法规页解读与原文并排", line: /左边解读/, to: "/policies" },
    { kind: "outro", ms: 4000, heading: "打开看看" },
  ],
};

function FilmShowcase({ script, release }: { script: Script; release: Release }) {
  return <Film script={script} data={useLiveData()} lines={release.body} id={`film-${releaseKey(release).replace(/\W/g, "")}`} />;
}

const film = (script: Script, live: readonly LiveBlock[]): Showcase => ({
  render: (release) => <FilmShowcase script={script} release={release} />,
  live,
  covers: script.scenes.flatMap((scene) => (scene.line ? [scene.line] : [])),
});

const BY_VERSION: Record<string, Showcase> = {
  "2026.11": { render: () => <Showcase202611 />, live: [], covers: [] },
};
const BY_MOMENT: Record<string, Showcase> = {
  "2026-11-15T02:24": film(FILM_20261115, ["countries", "metals", "hot"]),
};

export function showcaseFor(release: Release): Showcase | undefined {
  return (release.version ? BY_VERSION[release.version] : undefined) ?? BY_MOMENT[releaseKey(release)];
}

/** Every figure some showcase draws: the loader reads them alongside the changelog. */
export const LIVE_BLOCKS: ReadonlySet<LiveBlock> = new Set([...Object.values(BY_VERSION), ...Object.values(BY_MOMENT)].flatMap((one) => one.live));
