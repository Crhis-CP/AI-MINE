// The film's place on the page (TASK-0367): a poster frame with a play button, and under it the storyboard, every scene
// drawn still with the figures the film recorded (a snapshot of one day, said so on both). Pressing play loads the player (and Three.js) for the first time; with
// reduced motion, or where the browser cannot draw WebGL, the button leads to the storyboard instead. Nothing of the
// player is in the page's own scripts or in the server's render.
import { type ComponentType, type ReactNode, useEffect, useRef, useState } from "react";
import { useTr } from "../../../i18n";
import { CountryLatest } from "../blocks/CountryLatest";
import { countryName, priceLabel, usePriceWords, useSnapshotCaption } from "../blocks/format";
import { HotCount } from "../blocks/HotCount";
import { MetalTrend } from "../blocks/MetalTrend";
import type { FilmData } from "../blocks/types";
import { PolicySketch } from "../PolicySketch";
import { type Scene, type Script, scriptMs } from "./types";

/**
 * Whether this browser can play the film, asked once (each probe takes a drawing context of its own). Three.js 0.187
 * draws with WebGL 2 only, so a browser with WebGL 1 alone gets the storyboard; so does one whose player failed to start.
 */
let webglSupport: boolean | undefined;
function webgl(): boolean {
  if (webglSupport === undefined) {
    const gl = document.createElement("canvas").getContext("webgl2");
    webglSupport = !!gl;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  }
  return webglSupport;
}

export interface PlayerProps {
  script: Script;
  data: FilmData;
  onClose: () => void;
  /** The player could not start (no drawing context, a scene that would not build): the page shows the storyboard. */
  onFail: () => void;
}

/** The still form of each scene kind that has content of its own; the title and closing scenes have none. */
function Still({ scene, data }: { scene: Scene; data: FilmData }): ReactNode {
  switch (scene.kind) {
    case "feed":
      return <CountryLatest countries={data.countries} />;
    case "trend":
      return <MetalTrend metals={data.metals} />;
    case "count":
      return <HotCount hot={data.hot} />;
    case "sideBySide":
      return <PolicySketch />;
    default:
      return null;
  }
}

export const storyScenes = (script: Script) => script.scenes.filter((scene) => scene.kind !== "title" && scene.kind !== "outro");

export function Storyboard({ script, data, id }: { script: Script; data: FilmData; id: string }) {
  const tr = useTr();
  const caption = useSnapshotCaption();
  return (
    <>
      <p className="mt-4 text-[12px] text-ink-4">{caption(data.takenAt)}</p>
      <ol id={id} tabIndex={-1} aria-label={tr("分镜")} className="mt-2 grid gap-3 outline-none sm:grid-cols-2 lg:grid-cols-3">
        {storyScenes(script).map((scene, i) => {
          return (
            <li
              key={scene.heading}
              className={`animate-fade-up flex min-w-0 flex-col rounded-control border border-line bg-bg-sunk/60 p-4 ${scene.kind === "feed" ? "sm:col-span-2 lg:col-span-3" : ""}`}
              style={{ animationDelay: `${200 + i * 120}ms` }}
            >
              <div className="flex items-baseline gap-2">
                <span className="mono text-[11px] font-semibold text-ink-4">{String(i + 1).padStart(2, "0")}</span>
                <h3 className="text-[15.5px] font-bold text-ink">{tr(scene.heading)}</h3>
              </div>
              {scene.text && <p className="mt-1 text-[13px] leading-[1.75] text-ink-3">{tr(scene.text)}</p>}
              <div className="mt-3 flex-1">
                <Still scene={scene} data={data} />
              </div>
            </li>
          );
        })}
      </ol>
    </>
  );
}

const IconPlay = () => (
  <svg viewBox="0 0 24 24" className="size-7 translate-x-0.5" aria-hidden="true">
    <path d="M7 4.5v15l12.5-7.5z" fill="currentColor" />
  </svg>
);

/**
 * The poster frame: the film's title and the figures it shows, kept clear of one another (the day it was recorded is
 * said once, above the storyboard, where screen readers read it too).
 * Wide screens keep a film's proportions; on phones and tablets the frame has a fixed height that holds the English
 * title in three lines, the day and the figures, so nothing below moves while the web font arrives.
 */
function Poster({ script, data, still, onPlay }: { script: Script; data: FilmData; still: boolean; onPlay: () => void }) {
  const tr = useTr();
  const say = usePriceWords();
  const seconds = Math.round(scriptMs(script) / 1000);
  const metal = data.metals[0];
  const chips = [
    ...data.countries.filter((c) => countryName(c.code)).map((c) => `${tr(countryName(c.code)!)} · ${tr("{n} 条", { n: c.items.length })}`),
    ...(metal ? [`${say(metal.metal)} ${priceLabel(metal.points.at(-1)!.value, metal.decimals)}`] : []),
    ...(data.hot ? [tr("热点榜前 {n} 件", { n: data.hot.count })] : []),
    `${tr("解读")} | ${tr("原文")}`,
  ];
  return (
    <button
      type="button"
      onClick={onPlay}
      aria-label={still ? tr("查看分镜：{title}", { title: tr(script.title) }) : tr("播放演示：{title}（约 {s} 秒）", { title: tr(script.title), s: seconds })}
      className="flow-screen film-poster group/poster relative flex h-[23rem] w-full overflow-hidden rounded-control border text-left xl:h-auto xl:aspect-[16/7]"
    >
      <span className="relative flex w-full flex-col justify-between gap-6 p-5 sm:p-7">
        <span>
          <span className="film-kicker block text-[12px] font-semibold tracking-wide">{still ? tr("分镜") : tr("演示 · 约 {s} 秒", { s: seconds })}</span>
          <span className="film-title mt-1.5 line-clamp-3 max-w-[20em] text-[20px] font-black leading-[1.3] sm:text-[26px]">{tr(script.title)}</span>
        </span>
        <span className="flex items-end justify-between gap-4">
          <span className="film-chips flex flex-wrap gap-1.5">
            {chips.map((chip) => (
              <span key={chip} className="film-chip rounded-full border px-2.5 py-0.5 text-[12px] font-semibold">
                {chip}
              </span>
            ))}
          </span>
          <span
            className="ml-auto grid size-14 shrink-0 place-items-center rounded-full bg-hot text-white shadow-lg transition duration-200 group-hover/poster:scale-110 group-focus-visible/poster:scale-110 sm:size-16"
            aria-hidden="true"
          >
            {still ? <span className="text-[22px] leading-none">↓</span> : <IconPlay />}
          </span>
        </span>
      </span>
    </button>
  );
}

/** The poster, the storyboard, and the player once asked for. */
export function Film({ script, data, id }: { script: Script; data: FilmData; id: string }) {
  const tr = useTr();
  const [still, setStill] = useState(false);
  const [note, setNote] = useState(false);
  const [Player, setPlayer] = useState<ComponentType<PlayerProps> | null>(null);
  const [open, setOpen] = useState(false);
  const poster = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setStill(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const toStoryboard = () => {
    const board = document.getElementById(`${id}-board`);
    board?.scrollIntoView({ block: "start" });
    board?.focus({ preventScroll: true });
  };
  const play = () => {
    const drawable = webgl();
    if (still || !drawable) {
      setNote(!drawable && !still);
      return toStoryboard();
    }
    if (Player) return setOpen(true);
    if (!import.meta.env.SSR)
      import("./runtime").then(
        (module) => {
          setPlayer(() => module.PlayerDialog);
          setOpen(true);
        },
        () => {
          setNote(true);
          toStoryboard();
        },
      );
  };
  return (
    <section className="mt-6" aria-label={tr("本次更新亮点")}>
      <div ref={poster} className="animate-fade-up" style={{ animationDelay: "200ms" }}>
        <Poster script={script} data={data} still={still} onPlay={play} />
      </div>
      {note && <p className="mt-2 text-[12.5px] text-ink-3">{tr("这个浏览器放不了动画，下面是同样内容的分镜。")}</p>}
      <Storyboard script={script} data={data} id={`${id}-board`} />
      {Player && open && (
        <Player
          script={script}
          data={data}
          onClose={() => {
            setOpen(false);
            poster.current?.querySelector("button")?.focus();
          }}
          onFail={() => {
            webglSupport = false;
            setOpen(false);
            setNote(true);
            toStoryboard();
          }}
        />
      )}
    </section>
  );
}
