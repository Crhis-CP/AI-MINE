// The site's steps as one gathering line (Owner 2026-11-06: “穿起来，一条收束线”, many in and a few out, the steps
// threaded on it rather than drawn beside it). Thin threads come in from many sources and run into one band at 采集; at
// 筛选 a part of the band peels away and fades; at 归并 the strands inside it twist into a few stories; at 精选 it narrows
// and turns bright; at 发布 it leaves as one line that fans out to the outlets. Each step's badge sits on the band where
// it narrows, its words under it on a wide screen and beside it on a phone, where the band runs down the page. No counts
// are drawn: the narrowing tells the scale.
// Drawn from a fixed seed, so the server and the browser draw the same. The server and the first render draw the still
// line; news starts moving along it only once the browser says the reader allows motion (CSS cannot stop SMIL).
import { useEffect, useId, useState } from "react";
import { useTr } from "../../i18n";

export interface FlowStation {
  name: string;
  kicker: string;
  text: string;
}

const W = 1000,
  H = 220,
  MID = 110;
/** Where each of the five steps sits on the line. */
const X = [100, 300, 500, 700, 900] as const;
/** The kept band's half thickness at each step: it narrows all the way. */
const HALF = [27, 26, 16, 7, 1.8] as const;
/** At 采集 the band is 66–154; the part under 120 is the part 筛选 lets go. */
const BAND_TOP = 66,
  BAND_SPLIT = 120,
  BAND_BOTTOM = 154;
const SOURCES = 16;

type Point = readonly [number, number];
const f = (n: number) => Number(n.toFixed(1));

/** A smooth run through the points, level at each one (the shape of a gathering line). */
function run(points: readonly Point[], move = true): string {
  let d = move ? `M${f(points[0]![0])} ${f(points[0]![1])}` : "";
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]!;
    const [x1, y1] = points[i]!;
    const mid = (x0 + x1) / 2;
    d += ` C${f(mid)} ${f(y0)} ${f(mid)} ${f(y1)} ${f(x1)} ${f(y1)}`;
  }
  return d;
}

/** The kept band: from 66–120 at 采集, centred and narrowing from 筛选 on. */
const keptTop: Point[] = [[X[0], BAND_TOP], ...X.slice(1).map((x, i) => [x, MID - HALF[i + 1]!] as Point), [940, MID - 1.2]];
const keptBottom: Point[] = [[X[0], BAND_SPLIT], ...X.slice(1).map((x, i) => [x, MID + HALF[i + 1]!] as Point), [940, MID + 1.2]];
const BAND = `${run(keptTop)} L${keptBottom.at(-1)![0]} ${keptBottom.at(-1)![1]}${run([...keptBottom].reverse(), false)} Z`;
/** The part 筛选 lets go: it leaves the band's underside and fades as it drifts down. */
const PEEL = `${run([
  [X[0], BAND_SPLIT],
  [250, 150],
  [400, 198],
])} L400 212${run(
  [
    [400, 212],
    [250, 178],
    [X[0], BAND_BOTTOM],
  ],
  false,
)} Z`;

/** The strands inside the kept band: five at 采集, three stories at 归并, one line at 发布. */
const STRANDS: Point[][] = [
  [72, 91, 101, 106],
  [83, 101, 101, 106],
  [94, 110, 110, 110],
  [104, 119, 119, 114],
  [114, 129, 119, 114],
].map(([a, b, c, d]) => [
  [X[0], a!],
  [X[1], b!],
  [X[2], c!],
  [X[3], d!],
  [X[4], MID],
]);
/** Where the line fans out to the outlets. */
const RAYS = [MID - 20, MID, MID + 20] as const;

function seeded(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Source {
  d: string;
  /** The way a piece of news from this source travels: into the peel, or all the way to an outlet. */
  ride: string;
  kept: boolean;
}

const SOURCE_LINES: Source[] = (() => {
  const rand = seeded(11);
  return Array.from({ length: SOURCES }, (_, i) => {
    const start: Point = [f(rand() * 28), f(10 + ((H - 20) * (i + 0.5)) / SOURCES + (rand() - 0.5) * 8)];
    const end: Point = [X[0], f(BAND_TOP + 3 + ((BAND_BOTTOM - BAND_TOP - 6) * i) / (SOURCES - 1))];
    const d = run([start, end]);
    const kept = end[1] < BAND_SPLIT;
    if (!kept) return { d, kept, ride: run([start, end, [250, end[1] + 40], [390, 205]]) };
    const strand = STRANDS[Math.min(STRANDS.length - 1, Math.round(((end[1] - BAND_TOP) / (BAND_SPLIT - BAND_TOP)) * (STRANDS.length - 1)))]!;
    const ray = RAYS[i % RAYS.length]!;
    return { d, kept, ride: run([start, end, ...strand.slice(1), [940, MID], [992, ray]]) };
  });
})();

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

const STEP_ICONS: Record<string, string> = {
  采集: "M4 13l2-7h12l2 7v5H4z M4 13h5l1.5 2h3l1.5-2h5",
  筛选: "M4 5h16l-6 7.5V18l-4 2v-7.5z",
  归并: "M6 4v3a5 5 0 0 0 5 5h1 M18 4v3a5 5 0 0 1-5 5h-1 M12 12v8",
  精选: "M12 3.5l2.6 5.3 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z",
  发布: "M4 11.5l16-7-5.5 16-3.2-6.3z M11.3 14.2l3.5-3.5",
};

/** How strongly the band is coloured at each step: a quiet gold that ends bright. */
const TONE: readonly { color: string; opacity: number }[] = [
  { color: "var(--accent)", opacity: 0.26 },
  { color: "var(--accent)", opacity: 0.34 },
  { color: "var(--accent)", opacity: 0.5 },
  { color: "var(--hot)", opacity: 0.8 },
  { color: "var(--hot)", opacity: 1 },
];

function StepBadge({ name, step, lit, last }: { name: string; step: number; lit: boolean; last: boolean }) {
  const hot = step >= 3;
  return (
    <span
      className={`relative grid size-9 place-items-center rounded-full border-2 shadow-sm transition duration-200 lg:size-10 ${
        lit || last ? "border-hot bg-hot text-white" : hot ? "border-hot bg-surface text-hot" : "border-accent bg-surface text-accent"
      } ${lit ? "scale-110" : ""}`}
    >
      <svg
        viewBox="0 0 24 24"
        className="size-4 lg:size-[18px]"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {STEP_ICONS[name] ? <path d={STEP_ICONS[name]} /> : <circle cx={12} cy={12} r={5} />}
      </svg>
    </span>
  );
}

/** The band on a phone, one step to the next, running down beside the step's words. */
function RailSegment({ step, id }: { step: number; id: string }) {
  const half = [13, 9, 6, 3.2, 1.4, 0.6];
  const a = half[step]!,
    b = half[step + 1]!;
  const from = TONE[step]!,
    to = TONE[Math.min(TONE.length - 1, step + 1)]!;
  return (
    <svg viewBox="0 0 40 100" preserveAspectRatio="none" className="absolute left-0 top-5 h-full w-10 overflow-visible" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-rail-${step}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: from.color, stopOpacity: from.opacity }} />
          <stop offset="1" style={{ stopColor: to.color, stopOpacity: step === TONE.length - 1 ? 0 : to.opacity }} />
        </linearGradient>
      </defs>
      <path
        d={`M${20 - a} 0 C${20 - a} 50 ${20 - b} 50 ${20 - b} 100 L${20 + b} 100 C${20 + b} 50 ${20 + a} 50 ${20 + a} 0 Z`}
        fill={`url(#${id}-rail-${step})`}
      />
    </svg>
  );
}

/** One gathering line with the steps threaded on it; their words light their place on the line. */
export function Convergence({ stations, outlets }: { stations: FlowStation[]; outlets: string[] }) {
  const tr = useTr();
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const moving = useMotionAllowed();
  const [active, setActive] = useState<number | null>(null);
  const last = stations.length - 1;
  return (
    <figure className="mt-3" onMouseLeave={() => setActive(null)}>
      <p className="animate-fade-up max-w-[40em] text-[14px] leading-[1.8] text-ink-2">
        {tr("很多来源的消息进来，层层筛掉、合并，最后留下值得看的那一小部分。")}
      </p>
      {/* Wide screens: the line across, each step's words under its place on it. */}
      <div className="relative mt-6 hidden sm:block">
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full overflow-visible" aria-hidden="true">
          <defs>
            <linearGradient id={`${id}-band`} gradientUnits="userSpaceOnUse" x1={X[0]} y1={0} x2={X[4]} y2={0}>
              {TONE.map((tone, i) => (
                <stop key={tone.opacity} offset={i / (TONE.length - 1)} style={{ stopColor: tone.color, stopOpacity: tone.opacity }} />
              ))}
            </linearGradient>
            <linearGradient id={`${id}-peel`} gradientUnits="userSpaceOnUse" x1={X[0]} y1={0} x2={400} y2={0}>
              <stop offset="0" style={{ stopColor: "var(--accent)", stopOpacity: 0.26 }} />
              <stop offset="1" style={{ stopColor: "var(--ink-4)", stopOpacity: 0 }} />
            </linearGradient>
          </defs>
          {active !== null && <rect x={X[active]! - 100} y={0} width={200} height={H} rx={16} className="fill-accent-soft" />}
          {/* 采集: many thin threads, one from each kind of source, run into the band. */}
          {SOURCE_LINES.map((source, i) => (
            <path
              key={source.d}
              d={source.d}
              pathLength={1}
              className="anim-draw fill-none stroke-accent"
              strokeWidth={1}
              opacity={0.42}
              style={{ animationDelay: `${80 + i * 24}ms`, animationDuration: "700ms" }}
            />
          ))}
          <g className="animate-fade-up" style={{ animationDelay: "500ms" }}>
            {/* 筛选: the part that is let go peels off the underside and fades. */}
            <path d={PEEL} fill={`url(#${id}-peel)`} />
            {/* The band itself, narrowing step by step and turning bright. */}
            <path d={BAND} fill={`url(#${id}-band)`} />
            {/* 归并: the strands inside twist into a few stories, then one line. */}
            {STRANDS.map((strand) => (
              <path key={strand[0]![1]} d={run(strand)} className="fill-none stroke-surface" strokeWidth={1} opacity={0.6} />
            ))}
          </g>
          {/* 发布: one line out, fanning to the outlets. */}
          <path
            d={`M${X[4]} ${MID} L940 ${MID}${RAYS.map((y) => ` M940 ${MID} C966 ${MID} 966 ${y} 992 ${y}`).join("")}`}
            pathLength={1}
            className="anim-draw fill-none stroke-hot"
            strokeWidth={2}
            strokeLinecap="round"
            style={{ animationDelay: "1300ms", animationDuration: "600ms" }}
          />
          {RAYS.map((y, i) => (
            <circle
              key={y}
              cx={994}
              cy={y}
              r={4}
              className="anim-pop-in fill-hot"
              style={{ animationDelay: `${1700 + i * 90}ms`, transformBox: "fill-box", transformOrigin: "center" }}
            />
          ))}
          {/* News moving along the line: what is let go fades with the peel; the rest goes all the way out. */}
          {moving &&
            SOURCE_LINES.flatMap((source, i) =>
              (source.kept ? [0, 1] : [0]).map((k) => {
                const dur = source.kept ? 9 : 4.5;
                const begin = `${((i * 0.61 + k * 4.4) % dur).toFixed(2)}s`;
                return (
                  <circle
                    key={`${source.d}-${k}`}
                    r={source.kept ? 2.8 : 2.2}
                    className={source.kept ? "fill-hot stroke-surface" : "fill-ink-4"}
                    strokeWidth={source.kept ? 1.2 : 0}
                    opacity={0}
                  >
                    <animateMotion path={source.ride} dur={`${dur}s`} begin={begin} repeatCount="indefinite" />
                    <animate
                      attributeName="opacity"
                      values={source.kept ? "0;1;1;0" : "0;0.8;0.5;0"}
                      keyTimes={source.kept ? "0;0.04;0.95;1" : "0;0.1;0.7;1"}
                      dur={`${dur}s`}
                      begin={begin}
                      repeatCount="indefinite"
                    />
                  </circle>
                );
              }),
            )}
        </svg>
        {/* The steps, threaded on the band where it narrows. */}
        {stations.map((station, i) => (
          <span
            key={station.name}
            className="anim-pop-in absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${(X[i]! / W) * 100}%`, top: `${(MID / H) * 100}%`, animationDelay: `${250 + i * 260}ms` }}
          >
            <StepBadge name={station.name} step={i} lit={active === i} last={i === last} />
          </span>
        ))}
      </div>
      {/* The steps' words: under their place on the line on a wide screen; on a phone the band runs down beside them. */}
      <div className="relative mt-5 sm:hidden" aria-hidden="true">
        <svg viewBox="0 0 120 36" className="block h-9 w-[120px]" aria-hidden="true">
          {SOURCE_LINES.filter((_, i) => i % 2 === 0).map((source, i) => (
            <path
              key={source.d}
              d={`M${8 + i * 14} 0 C${8 + i * 14} 22 20 14 20 36`}
              pathLength={1}
              className="anim-draw fill-none stroke-accent"
              strokeWidth={1}
              opacity={0.45}
              style={{ animationDelay: `${60 + i * 40}ms` }}
            />
          ))}
        </svg>
      </div>
      <ol className="grid sm:mt-4 sm:grid-cols-5">
        {stations.map((station, i) => (
          <li
            key={station.name}
            className="animate-fade-up grid grid-cols-[40px_minmax(0,1fr)] gap-3 sm:block sm:px-2"
            style={{ animationDelay: `${400 + i * 260}ms` }}
            onMouseEnter={() => setActive(i)}
            onFocus={() => setActive(i)}
          >
            <div className="relative sm:hidden" aria-hidden="true">
              <RailSegment step={i} id={id} />
              <span className="relative block">
                <StepBadge name={station.name} step={i} lit={false} last={i === last} />
              </span>
            </div>
            <div className={`pb-7 pt-1.5 transition duration-200 sm:border-t-2 sm:pb-0 sm:pt-3 ${active === i ? "sm:border-accent" : "sm:border-line-soft"}`}>
              <div className="flex items-baseline gap-2">
                <span className="mono text-[11px] font-semibold text-ink-4">{String(i + 1).padStart(2, "0")}</span>
                <span className={`text-[16px] font-black transition-colors duration-200 ${active === i ? "text-accent" : "text-ink"}`}>{station.name}</span>
              </div>
              <div className={`mt-0.5 text-[12.5px] font-semibold ${i >= 3 ? "text-hot" : "text-accent"}`}>{station.kicker}</div>
              <p className="mt-1.5 text-[13px] leading-[1.7] text-ink-3">{station.text}</p>
              {i === last && outlets.length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {outlets.map((label) => (
                    <span key={label} className="rounded-full border border-hot/45 bg-hot/10 px-2.5 py-0.5 text-[12px] font-semibold text-hot">
                      {label}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </figure>
  );
}
