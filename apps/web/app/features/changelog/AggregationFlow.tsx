// The site's steps as one gathering line (Owner 2026-11-06: “穿起来，一条收束线”, many in and a few out, drawn with care).
// Drawn like the site's survey map: fine hairlines, evenly spaced, in the brand's gold. Each step has its own stretch of
// the line, set off by dashed survey marks, with its words right under it (beside it on a phone, where the line runs
// down the page):
//   采集  many lines come in across the whole height;
//   筛选  the outer lines turn away and fade, the rest draw in;
//   归并  the lines that tell the same story run together, a few strands;
//   精选  the strands close to a bright point;
//   发布  from that point the line opens to where readers read.
// No counts are drawn: the closing of the lines tells the scale. Drawn from fixed numbers, so the server and the browser
// draw the same; the server and the first render draw the still line, and glints move along it only once the browser
// says the reader allows motion (CSS cannot stop SMIL).
import { useEffect, useId, useState } from "react";
import { useTr } from "../../i18n";

export interface FlowStation {
  name: string;
  kicker: string;
  text: string;
}

const W = 1000,
  H = 200,
  MID = 100,
  /** How far from the middle a line at the edge sits, in the wide drawing. */
  SPREAD = 88;
const LINES = 36;
/** Lines this close to the middle are kept at 筛选; the outer ones turn away. */
const KEEP = 0.58;
/** Where the line closes to a point, inside 发布. */
const FOCUS = 880;

type Point = readonly [number, number];
const f = (n: number) => Number(n.toFixed(1));

interface Line {
  kept: boolean;
  /** Along the line (0–1000) and across it (−1 to 1). */
  points: Point[];
}

const GEOMETRY: Line[] = Array.from({ length: LINES }, (_, i) => {
  const o = -1 + (2 * (i + 0.5)) / LINES;
  if (Math.abs(o) > KEEP) {
    const away = Math.sign(o) * Math.min(1.16, Math.abs(o) * 1.28);
    return {
      kept: false,
      points: [
        [0, o],
        [200, o * 0.9],
        [350, away],
      ],
    };
  }
  const u = o / KEEP;
  return {
    kept: true,
    points: [
      [0, o],
      [200, o * 0.86],
      [400, u * 0.36],
      [600, (Math.round(u * 2) / 2) * 0.27],
      [800, Math.round(u) * 0.07],
      [FOCUS, 0],
      [990, Math.round(u) * 0.3],
    ],
  };
});

/** A smooth run through the points, level at each one, so the line crosses every step mark straight. */
function run(points: readonly Point[]): string {
  let d = `M${f(points[0]![0])} ${f(points[0]![1])}`;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]!;
    const [x1, y1] = points[i]!;
    const mid = (x0 + x1) / 2;
    d += ` C${f(mid)} ${f(y0)} ${f(mid)} ${f(y1)} ${f(x1)} ${f(y1)}`;
  }
  return d;
}
/** The same, running down the page: level across, so the pieces of a phone's rail join without a kink. */
function runDown(points: readonly Point[]): string {
  let d = `M${f(points[0]![0])} ${f(points[0]![1])}`;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]!;
    const [x1, y1] = points[i]!;
    const mid = (y0 + y1) / 2;
    d += ` C${f(x0)} ${f(mid)} ${f(x1)} ${f(mid)} ${f(x1)} ${f(y1)}`;
  }
  return d;
}

const WIDE = GEOMETRY.map((line) => ({ ...line, d: run(line.points.map(([x, p]) => [x, MID + p * SPREAD] as Point)) }));

/** Where a line sits across at any point along it, for cutting the phone's rail into the steps' stretches. */
function across(points: readonly Point[], x: number): number {
  for (let i = 1; i < points.length; i++) {
    const [x0, p0] = points[i - 1]!;
    const [x1, p1] = points[i]!;
    if (x <= x1) {
      const t = (x - x0) / (x1 - x0);
      return p0 + (p1 - p0) * t * t * (3 - 2 * t);
    }
  }
  return points.at(-1)![1];
}

/** The colour of the line along its way: a quiet warm grey that turns to gold and ends bright. */
const TONE: readonly { color: string; opacity: number }[] = [
  { color: "var(--ink-4)", opacity: 0.5 },
  { color: "var(--ink-4)", opacity: 0.6 },
  { color: "var(--accent)", opacity: 0.6 },
  { color: "var(--accent)", opacity: 0.8 },
  { color: "var(--accent)", opacity: 1 },
  { color: "var(--accent)", opacity: 1 },
];

/** False on the server and on the first render; true once the browser says the reader has not asked for less motion. */
function useMotionAllowed() {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setAllowed(!query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return allowed;
}

/** A phone's rail: the line's stretch for one step, running down beside its words. */
function Rail({ step, id }: { step: number; id: string }) {
  const from = step * 200,
    to = from + 200;
  const half = 26;
  const toRail = (x: number, p: number): Point => [28 + p * half, (x - from) / 2];
  const lines = GEOMETRY.filter((_, i) => i % 2 === 0).flatMap((line) => {
    const end = line.points.at(-1)![0];
    if (end <= from) return [];
    const inside = line.points.filter(([x]) => x > from && x < Math.min(to, end));
    const last = Math.min(to, end);
    const points = [toRail(from, across(line.points, from)), ...inside.map(([x, p]) => toRail(x, p)), toRail(last, across(line.points, last))];
    return [{ kept: line.kept, d: runDown(points) }];
  });
  return (
    <svg viewBox="0 0 56 100" preserveAspectRatio="none" className="absolute inset-y-0 left-0 h-full w-14" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-rail-${step}`} x1="0" y1="0" x2="0" y2="100" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: TONE[step]!.color, stopOpacity: TONE[step]!.opacity }} />
          <stop offset="1" style={{ stopColor: TONE[step + 1]!.color, stopOpacity: TONE[step + 1]!.opacity }} />
        </linearGradient>
        <linearGradient id={`${id}-rail-fade-${step}`} x1="0" y1="0" x2="0" y2="100" gradientUnits="userSpaceOnUse">
          <stop offset={step === 0 ? "0" : "0.15"} stopColor="white" stopOpacity={step === 0 ? 0 : 1} />
          <stop offset={step === 0 ? "0.35" : "0.6"} stopColor="white" stopOpacity={step === 0 ? 1 : 0} />
        </linearGradient>
        <mask id={`${id}-rail-mask-${step}`} maskUnits="userSpaceOnUse" x="-10" y="-10" width="76" height="120">
          <rect x="-10" y="-10" width="76" height="120" fill={`url(#${id}-rail-fade-${step})`} />
        </mask>
      </defs>
      <g mask={step === 0 ? `url(#${id}-rail-mask-${step})` : undefined}>
        {lines.map((line) => (
          <path
            key={line.d}
            d={line.d}
            fill="none"
            stroke={`url(#${id}-rail-${step})`}
            strokeWidth={line.kept ? 0.9 : 0.7}
            vectorEffect="non-scaling-stroke"
            mask={!line.kept && step === 1 ? `url(#${id}-rail-mask-${step})` : undefined}
          />
        ))}
      </g>
    </svg>
  );
}

/** One gathering line with the steps threaded on it; their words light their stretch of the line. */
export function Convergence({ stations, outlets }: { stations: FlowStation[]; outlets: string[] }) {
  const tr = useTr();
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const moving = useMotionAllowed();
  const [active, setActive] = useState<number | null>(null);
  const kept = WIDE.filter((line) => line.kept);
  const dropped = WIDE.filter((line) => !line.kept);
  return (
    <figure className="mt-3" onMouseLeave={() => setActive(null)}>
      <p className="animate-fade-up max-w-[40em] text-[14px] leading-[1.8] text-ink-2">
        {tr("很多来源的消息进来，层层筛掉、合并，最后留下值得看的那一小部分。")}
      </p>
      {/* Wide screens: the line across, each step's stretch set off by survey marks, its words under it. */}
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-7 hidden h-auto w-full overflow-visible sm:block" aria-hidden="true">
        <defs>
          <linearGradient id={`${id}-beam`} gradientUnits="userSpaceOnUse" x1={0} y1={0} x2={W} y2={0}>
            {TONE.map((tone, i) => (
              <stop key={`${tone.color}${tone.opacity}`} offset={i / (TONE.length - 1)} style={{ stopColor: tone.color, stopOpacity: tone.opacity }} />
            ))}
          </linearGradient>
          {/* Lines come in faint at the left edge; the ones 筛选 lets go fade as they turn away. */}
          <linearGradient id={`${id}-in`} gradientUnits="userSpaceOnUse" x1={0} y1={0} x2={90} y2={0}>
            <stop offset="0" stopColor="white" stopOpacity={0} />
            <stop offset="1" stopColor="white" stopOpacity={1} />
          </linearGradient>
          <linearGradient id={`${id}-out`} gradientUnits="userSpaceOnUse" x1={200} y1={0} x2={350} y2={0}>
            <stop offset="0" stopColor="white" stopOpacity={1} />
            <stop offset="1" stopColor="white" stopOpacity={0} />
          </linearGradient>
          <mask id={`${id}-in-mask`} maskUnits="userSpaceOnUse" x={-10} y={-10} width={W + 20} height={H + 20}>
            <rect x={-10} y={-10} width={W + 20} height={H + 20} fill={`url(#${id}-in)`} />
          </mask>
          <mask id={`${id}-out-mask`} maskUnits="userSpaceOnUse" x={-10} y={-10} width={W + 20} height={H + 20}>
            <rect x={-10} y={-10} width={W + 20} height={H + 20} fill={`url(#${id}-out)`} />
          </mask>
          <radialGradient id={`${id}-glow`}>
            <stop offset="0" style={{ stopColor: "var(--accent)", stopOpacity: 0.45 }} />
            <stop offset="1" style={{ stopColor: "var(--accent)", stopOpacity: 0 }} />
          </radialGradient>
        </defs>
        {active !== null && <rect x={active * 200} y={0} width={200} height={H} className="fill-accent-softer" />}
        {/* The survey marks between the steps. */}
        {[0, 200, 400, 600, 800].map((x) => (
          <line key={x} x1={x + 0.5} x2={x + 0.5} y1={0} y2={H} className="stroke-ink-4" strokeWidth={1} strokeDasharray="2 5" opacity={0.35} />
        ))}
        <g mask={`url(#${id}-in-mask)`}>
          <g mask={`url(#${id}-out-mask)`}>
            {dropped.map((line, i) => (
              <path
                key={line.d}
                d={line.d}
                pathLength={1}
                className="anim-draw"
                fill="none"
                stroke={`url(#${id}-beam)`}
                strokeWidth={0.75}
                style={{ animationDelay: `${i * 14}ms`, animationDuration: "900ms" }}
              />
            ))}
          </g>
          {kept.map((line, i) => (
            <path
              key={line.d}
              d={line.d}
              pathLength={1}
              className="anim-draw"
              fill="none"
              stroke={`url(#${id}-beam)`}
              strokeWidth={0.9}
              style={{ animationDelay: `${120 + i * 14}ms`, animationDuration: "1800ms" }}
            />
          ))}
        </g>
        {/* The bright point where it closes, and the ends it opens to. */}
        <g className="animate-fade-up" style={{ animationDelay: "1500ms" }}>
          <circle cx={FOCUS} cy={MID} r={16} fill={`url(#${id}-glow)`} />
          <circle cx={FOCUS} cy={MID} r={3} className="fill-accent" />
          {[-1, 0, 1].map((k) => (
            <circle key={k} cx={990} cy={MID + k * 0.3 * SPREAD} r={2.6} className="fill-accent" />
          ))}
        </g>
        {/* Glints moving along the line: on the lines let go they fade; on the rest they go all the way out. */}
        {moving &&
          WIDE.filter((_, i) => i % 3 === 1).map((line, i) => {
            const dur = line.kept ? 7 : 3.2;
            const begin = `${((i * 1.37) % dur).toFixed(2)}s`;
            return (
              <circle key={line.d} r={line.kept ? 1.9 : 1.5} className="fill-accent" opacity={0}>
                <animateMotion path={line.d} dur={`${dur}s`} begin={begin} repeatCount="indefinite" />
                <animate
                  attributeName="opacity"
                  values={line.kept ? "0;0.9;0.9;0" : "0;0.6;0"}
                  keyTimes={line.kept ? "0;0.08;0.94;1" : "0;0.25;1"}
                  dur={`${dur}s`}
                  begin={begin}
                  repeatCount="indefinite"
                />
              </circle>
            );
          })}
      </svg>
      {/* The steps' words: under their stretch on a wide screen; on a phone the line runs down beside them. */}
      <ol className="mt-4 grid sm:mt-0 sm:grid-cols-5">
        {stations.map((station, i) => (
          <li
            key={station.name}
            className="animate-fade-up relative grid grid-cols-[56px_minmax(0,1fr)] gap-4 border-t border-dashed border-ink-4/30 sm:block sm:border-t-0 sm:border-l sm:pl-4 sm:pr-3"
            style={{ animationDelay: `${300 + i * 160}ms` }}
            onMouseEnter={() => setActive(i)}
            onFocus={() => setActive(i)}
          >
            <div className="relative sm:hidden" aria-hidden="true">
              <Rail step={i} id={id} />
              {i === stations.length - 1 && (
                <span className="absolute left-7 top-[40%] size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent shadow-[0_0_0_5px_var(--accent-soft)]" />
              )}
            </div>
            <div className="pb-6 pt-4 sm:pb-2 sm:pt-4">
              <div className="mono text-[11px] font-semibold tracking-[0.12em] text-accent">{String(i + 1).padStart(2, "0")}</div>
              <div className={`mt-1 text-[17px] font-black tracking-wide transition-colors duration-200 ${active === i ? "text-accent" : "text-ink"}`}>
                {station.name}
              </div>
              <div className="mt-0.5 text-[12.5px] font-semibold text-ink-2">{station.kicker}</div>
              <p className="mt-2 text-[13px] leading-[1.75] text-ink-3">{station.text}</p>
              {i === stations.length - 1 && outlets.length > 0 && (
                <p className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] font-semibold text-accent">
                  {outlets.map((label, k) => (
                    <span key={label} className="inline-flex items-center gap-2">
                      {k > 0 && <span className="size-1 rounded-full bg-accent/50" aria-hidden="true" />}
                      {label}
                    </span>
                  ))}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </figure>
  );
}
