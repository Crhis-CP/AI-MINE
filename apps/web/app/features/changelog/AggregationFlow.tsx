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
// draw the same. It moves like an instrument at work (Owner 2026-11-06: “充满科技感的动态设计”): short lights race along
// the lines, a scan sweeps the filter stretch, rings ping where strands join and at the outlets, a reticle turns on the
// bright point. All of it is CSS (app.css, flow-*), so a reader who asks for less motion gets the still drawing.
import { useId, useState } from "react";
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

/** What each step does, as an instrument would label it. */
const CODES = ["INPUT", "FILTER", "MERGE", "SELECT", "OUTPUT"] as const;
/** Where the strands that tell the same story run together, at the end of 归并. */
const JOINS = [-1, -0.5, 0, 0.5, 1].map((k) => MID + k * 0.27 * SPREAD);
const OUTLETS = [-1, 0, 1].map((k) => MID + k * 0.3 * SPREAD);

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
  const relayed = lines.filter((line, k) => line.kept && k % 3 === 1);
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
      {step === 1 && (
        <line
          x1={2}
          x2={54}
          y1={6}
          y2={6}
          className="flow-scan stroke-accent"
          strokeWidth={1}
          opacity={0.7}
          vectorEffect="non-scaling-stroke"
          style={{ ["--flow-scan-y" as string]: "62px" }}
        />
      )}
      {/* Lights hand on from one step to the next, down the rail. */}
      {relayed.map((line, k) => (
        <path
          key={`pulse-${line.d}`}
          d={line.d}
          pathLength={1}
          className="flow-relay stroke-accent"
          fill="none"
          strokeWidth={1.6}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          style={{ ["--flow-ms" as string]: "6s", animationDelay: `${step * 1.2 + k * 0.5}s` }}
        />
      ))}
    </svg>
  );
}

/** One gathering line with the steps threaded on it; their words light their stretch of the line. */
export function Convergence({ stations, outlets }: { stations: FlowStation[]; outlets: string[] }) {
  const tr = useTr();
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
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
          <filter id={`${id}-bloom`} filterUnits="userSpaceOnUse" x={-20} y={-20} width={W + 40} height={H + 40}>
            <feGaussianBlur stdDeviation={2.2} result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <pattern id={`${id}-grid`} width={20} height={20} patternUnits="userSpaceOnUse">
            <circle cx={10} cy={10} r={0.9} className="fill-ink-4" opacity={0.28} />
          </pattern>
          <linearGradient id={`${id}-scan`} gradientUnits="objectBoundingBox" x1={0} y1={0} x2={1} y2={0}>
            <stop offset="0" style={{ stopColor: "var(--accent)", stopOpacity: 0 }} />
            <stop offset="1" style={{ stopColor: "var(--accent)", stopOpacity: 0.22 }} />
          </linearGradient>
          <radialGradient id={`${id}-glow`}>
            <stop offset="0" style={{ stopColor: "var(--accent)", stopOpacity: 0.45 }} />
            <stop offset="1" style={{ stopColor: "var(--accent)", stopOpacity: 0 }} />
          </radialGradient>
        </defs>
        {active !== null && <rect x={active * 200} y={0} width={200} height={H} className="fill-accent-softer" />}
        {/* A faint instrument grid and a ruler along the bottom. */}
        <rect x={0} y={0} width={W} height={H} fill={`url(#${id}-grid)`} />
        {Array.from({ length: 51 }, (_, k) => k * 20).map((x) => (
          <line
            key={`tick-${x}`}
            x1={x + 0.5}
            x2={x + 0.5}
            y1={H}
            y2={x % 100 === 0 ? H - 7 : H - 3.5}
            className="stroke-ink-4"
            strokeWidth={0.8}
            opacity={0.45}
          />
        ))}
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
        {/* Lights racing along the lines: on the lines let go they fade with them; the rest run all the way out. */}
        <g filter={`url(#${id}-bloom)`}>
          <g mask={`url(#${id}-out-mask)`}>
            {dropped
              .filter((_, k) => k % 2 === 0)
              .map((line, k) => (
                <path
                  key={`pulse-${line.d}`}
                  d={line.d}
                  pathLength={1}
                  className="flow-pulse stroke-ink-4"
                  fill="none"
                  strokeWidth={1.4}
                  strokeLinecap="round"
                  style={{ ["--flow-ms" as string]: "2.6s", animationDelay: `${-((k * 0.83) % 2.6)}s` }}
                />
              ))}
          </g>
          {kept.map((line, k) => (
            <path
              key={`pulse-${line.d}`}
              d={line.d}
              pathLength={1}
              className="flow-pulse stroke-accent"
              fill="none"
              strokeWidth={1.4}
              strokeLinecap="round"
              style={{ ["--flow-ms" as string]: `${4 + (k % 4) * 0.45}s`, animationDelay: `${-((k * 1.13) % 5)}s` }}
            />
          ))}
        </g>
        {/* 筛选: a scan sweeps the stretch, reading each piece as it goes by. */}
        <g className="flow-scan" style={{ ["--flow-scan-x" as string]: "186px" }}>
          <rect x={196} y={4} width={16} height={H - 12} fill={`url(#${id}-scan)`} />
          <line x1={212} x2={212} y1={4} y2={H - 8} className="stroke-accent" strokeWidth={1} opacity={0.7} />
        </g>
        {/* 归并: where the strands of one story run together, a ring pings. */}
        {JOINS.map((y, k) => (
          <g key={`join-${y}`}>
            <circle cx={600} cy={y} r={2.2} className="flow-ping fill-none stroke-accent" strokeWidth={0.8} style={{ animationDelay: `${k * 0.42}s` }} />
            <circle cx={600} cy={y} r={1.8} className="fill-accent" />
          </g>
        ))}
        {/* 精选: the bright point, with a reticle turning on it. */}
        <g className="animate-fade-up" style={{ animationDelay: "1500ms" }}>
          <circle cx={FOCUS} cy={MID} r={18} fill={`url(#${id}-glow)`} />
          <circle cx={FOCUS} cy={MID} r={13} className="flow-spin fill-none stroke-accent" strokeWidth={0.9} strokeDasharray="3 4.2" />
          {[0, 90, 180, 270].map((deg) => (
            <line
              key={deg}
              x1={FOCUS}
              x2={FOCUS}
              y1={MID - 17}
              y2={MID - 22}
              className="stroke-accent"
              strokeWidth={1}
              transform={`rotate(${deg} ${FOCUS} ${MID})`}
            />
          ))}
          <circle cx={FOCUS} cy={MID} r={3} className="fill-accent" />
          <circle cx={FOCUS} cy={MID} r={3} className="flow-ping fill-none stroke-accent" strokeWidth={0.8} />
          {/* 发布: the ends it opens to send their signal out. */}
          {OUTLETS.map((y, k) => (
            <g key={`out-${y}`}>
              <circle cx={990} cy={y} r={2.6} className="flow-ping fill-none stroke-accent" strokeWidth={0.8} style={{ animationDelay: `${0.6 + k * 0.5}s` }} />
              <circle cx={990} cy={y} r={2.6} className="fill-accent" />
            </g>
          ))}
        </g>
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
                <span className="absolute left-7 top-[40%] grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center">
                  <span className="flow-spin absolute inset-0 rounded-full border border-dashed border-accent" />
                  <span className="size-[7px] rounded-full bg-accent shadow-[0_0_8px_var(--accent)]" />
                </span>
              )}
            </div>
            <div className="pb-6 pt-4 sm:pb-2 sm:pt-4">
              <div className="mono flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.12em]" aria-hidden="true">
                <span className="text-accent">{String(i + 1).padStart(2, "0")}</span>
                <span className="text-ink-4">/</span>
                <span className="text-ink-4">{CODES[i] ?? ""}</span>
              </div>
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
