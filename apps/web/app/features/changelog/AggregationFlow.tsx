// How the site picks what readers see, drawn as a working pipeline on a console-like screen (Owner 2026-11-06: “穿起来，一条
// 收束线”, then “充满科技感的动态设计”, “更炫酷科技化，学习网上风格” — the dark product-pipeline look of developer and
// payments sites; “白天可以是白色，晚上再这个颜色…亮度高一些”). Labelled sources send lanes into five glass step cards in turn; at 筛选 two lanes turn off into a
// bin for the off-topic and repeated; the lanes thin from card to card, 5 → 3 → 2 → 1, and 发布 opens to the outlets.
// Comets race along the lanes, a wave of light passes through the cards, a scan reads 筛选, a gradient border turns
// round 精选, a sheen sweeps the screen. The colours run cool to warm: news comes in cyan, turns violet as it is sorted
// and merged, and leaves as the site's gold, like ore refined to metal. The words for each step sit under the screen.
// No counts are drawn: the thinning of the lanes tells the scale.
// The screen is white by day and bright navy by night (colours on `.flow-screen` in app.css). Drawn from fixed numbers,
// so the server and the browser draw the same. All motion is CSS (app.css, flow-*), so a reader who asks for less
// motion gets the still screen; the screen is decoration, the steps' words carry the content.
import { useId, useState } from "react";
import { type Phrase, useTr } from "../../i18n";
import "./changelog-flow.css";

export interface FlowStation {
  name: string;
  kicker: string;
  text: string;
}

type Side = "l" | "r" | "t" | "b";
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Layout {
  W: number;
  H: number;
  /** Which way the lanes run from step to step: across on a wide screen, down on a phone. */
  across: boolean;
  sources: Box[];
  steps: Box[];
  bin: Box;
  outlets: Box[];
}

/**
 * The screen's colours, set per theme on `.flow-screen` in app.css (white by day, bright navy by night): news comes in
 * cyan, turns violet as it is sorted and merged, and leaves as the site's gold; what 筛选 lets go is rose.
 */
const CYAN = "var(--fs-cyan)",
  VIOLET = "var(--fs-violet)",
  GOLD = "var(--fs-gold)",
  ROSE = "var(--fs-rose)";
/** The colour each one takes at a comet's head: deeper by day, near-white by night. */
const HOT: Record<string, string> = {
  [CYAN]: "var(--fs-cyan-head)",
  [VIOLET]: "var(--fs-violet-head)",
  [GOLD]: "var(--fs-gold-head)",
  [ROSE]: "var(--fs-rose-head)",
};
/** A colour at some strength over whatever is behind it. */
const mix = (color: string, percent: number) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;
/** Each step's colour: 采集 and 筛选 cyan, 归并 violet, 精选 and 发布 gold. */
const STEP_COLOR = [CYAN, CYAN, VIOLET, GOLD, GOLD] as const;
/** The colour of the lanes leaving each step for the next. */
const LANE_COLOR = [CYAN, VIOLET, VIOLET, GOLD] as const;
const SOURCES = ["部委", "协会", "矿企", "媒体", "交易所", "海外"] as const satisfies readonly Phrase[];
const CODES = ["INPUT", "FILTER", "MERGE", "SELECT", "OUTPUT"] as const;
/** How many lanes leave each step for the next: the stream thins as it goes. */
const LANES = [5, 3, 2, 1] as const;

const WIDE: Layout = {
  W: 1000,
  H: 330,
  across: true,
  sources: SOURCES.map((_, i) => ({ x: 48, y: 50 + i * 46, w: 68, h: 26 })),
  steps: [195, 360, 525, 690, 850].map((x) => ({ x, y: 165, w: 100, h: 50 })),
  bin: { x: 360, y: 292, w: 118, h: 28 },
  outlets: [105, 165, 225].map((y) => ({ x: 956, y, w: 64, h: 28 })),
};
const TALL: Layout = {
  W: 360,
  H: 800,
  across: false,
  sources: SOURCES.map((_, i) => ({ x: 70 + (i % 3) * 110, y: 44 + Math.floor(i / 3) * 40, w: 92, h: 28 })),
  steps: [205, 330, 455, 580, 705].map((y) => ({ x: 180, y, w: 128, h: 50 })),
  bin: { x: 312, y: 392, w: 84, h: 28 },
  outlets: [70, 180, 290].map((x) => ({ x, y: 775, w: 92, h: 28 })),
};

const OUT: Record<Side, readonly [number, number]> = { l: [-1, 0], r: [1, 0], t: [0, -1], b: [0, 1] };
const f = (n: number) => Number(n.toFixed(1));

/** A point on a box's edge, `offset` along that edge from its middle. */
function edge(box: Box, side: Side, offset = 0): [number, number] {
  if (side === "l" || side === "r") return [box.x + (side === "r" ? box.w / 2 : -box.w / 2), box.y + offset];
  return [box.x + offset, box.y + (side === "b" ? box.h / 2 : -box.h / 2)];
}

interface Lane {
  d: string;
  /** A little over the lane's length, for its comet's dashes. */
  len: number;
}

/** A lane leaving one box by one side and entering another by another, bending smoothly between. */
function lane(from: Box, fromSide: Side, fromOffset: number, to: Box, toSide: Side, toOffset: number): Lane {
  const [x0, y0] = edge(from, fromSide, fromOffset);
  const [x1, y1] = edge(to, toSide, toOffset);
  const reach = Math.hypot(x1 - x0, y1 - y0);
  const pull = reach * 0.5;
  const [ox, oy] = OUT[fromSide];
  const [ix, iy] = OUT[toSide];
  return {
    d: `M${f(x0)} ${f(y0)} C${f(x0 + ox * pull)} ${f(y0 + oy * pull)} ${f(x1 + ix * pull)} ${f(y1 + iy * pull)} ${f(x1)} ${f(y1)}`,
    len: Math.round(reach * 1.25),
  };
}

const spread = (k: number, n: number, gap: number) => (k - (n - 1) / 2) * gap;

function lanes(layout: Layout) {
  const { across, sources, steps, bin, outlets } = layout;
  const [enter, leave]: [Side, Side] = across ? ["l", "r"] : ["t", "b"];
  return {
    sources: sources.map((source, i) => ({ ...lane(source, leave, 0, steps[0]!, enter, spread(i, sources.length, across ? 6 : 8)), color: CYAN })),
    main: LANES.flatMap((n, j) =>
      Array.from({ length: n }, (_, k) => ({
        ...lane(steps[j]!, leave, spread(k, n, 9), steps[j + 1]!, enter, spread(k, n, 5)),
        color: LANE_COLOR[j] ?? GOLD,
      })),
    ),
    drop: [0, 1].map((k) => ({ ...lane(steps[1]!, across ? "b" : "r", spread(k, 2, across ? 18 : 12), bin, "t", spread(k, 2, 18)), color: ROSE })),
    out: outlets.map((outlet, k) => ({ ...lane(steps[4]!, leave, spread(k, 3, 8), outlet, enter, 0), color: GOLD })),
  };
}

/** A pseudo-random number from an index, so the comets start at different points but render the same each time. */
const jitter = (i: number) => {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};

/** A comet on a lane: a bright head leading a fading tail, both racing the lane's length. */
function Comet({ lane: { d, len }, i, ms, color, filter }: { lane: Lane; i: number; ms: number; color: string; filter: string }) {
  const tail = 34,
    head = 6;
  const delay = `${(-jitter(i) * ms).toFixed(0)}ms`;
  const motion = (from: number, to: number) => ({
    ["--from" as string]: `${from}`,
    ["--to" as string]: `${to}`,
    ["--flow-ms" as string]: `${Math.round(ms)}ms`,
    animationDelay: delay,
  });
  return (
    <g filter={filter}>
      <path
        d={d}
        className="flow-comet"
        fill="none"
        strokeWidth={2}
        strokeLinecap="round"
        opacity={0.55}
        strokeDasharray={`${tail} ${len + 80}`}
        style={{ ...motion(tail, -len), stroke: color }}
      />
      <path
        d={d}
        className="flow-comet"
        fill="none"
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeDasharray={`${head} ${len + 80}`}
        style={{ ...motion(head, -len - (tail - head)), stroke: HOT[color] ?? color }}
      />
    </g>
  );
}

const STEP_ICONS: Record<string, string> = {
  采集: "M4 13l2-7h12l2 7v5H4z M4 13h5l1.5 2h3l1.5-2h5",
  筛选: "M4 5h16l-6 7.5V18l-4 2v-7.5z",
  归并: "M6 4v3a5 5 0 0 0 5 5h1 M18 4v3a5 5 0 0 1-5 5h-1 M12 12v8",
  精选: "M12 3.5l2.6 5.3 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z",
  发布: "M4 11.5l16-7-5.5 16-3.2-6.3z M11.3 14.2l3.5-3.5",
};

/** Where a box sits on the screen, as a share of it, so the HTML labels ride the drawing at any width. */
const place = (layout: Layout, box: Box) => ({
  left: `${(box.x / layout.W) * 100}%`,
  top: `${(box.y / layout.H) * 100}%`,
  width: `${(box.w / layout.W) * 100}%`,
  height: `${(box.h / layout.H) * 100}%`,
});

/** One drawing of the pipeline, across or down. */
function Pipeline({
  layout,
  stations,
  outlets,
  active,
  id,
}: {
  layout: Layout;
  stations: FlowStation[];
  outlets: string[];
  active: number | null;
  id: string;
}) {
  const tr = useTr();
  const all = lanes(layout);
  const key = `${id}-${layout.across ? "w" : "t"}`;
  const bloom = `url(#${key}-bloom)`;
  const { W, H } = layout;
  return (
    <div className="relative" style={{ aspectRatio: `${W} / ${H}` }}>
      <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 size-full" aria-hidden="true">
        <defs>
          <pattern id={`${key}-grid`} width={24} height={24} patternUnits="userSpaceOnUse">
            <path d="M24 0H0V24" fill="none" strokeWidth={1} style={{ stroke: "var(--fs-grid)" }} />
          </pattern>
          <radialGradient id={`${key}-fade`} cx="50%" cy="45%" r="70%">
            <stop offset="0.35" stopColor="#fff" stopOpacity={1} />
            <stop offset="1" stopColor="#fff" stopOpacity={0} />
          </radialGradient>
          <mask id={`${key}-vignette`}>
            <rect width={W} height={H} fill={`url(#${key}-fade)`} />
          </mask>
          <radialGradient id={`${key}-halo`} cx="80%" cy="50%" r="40%">
            <stop offset="0" style={{ stopColor: GOLD, stopOpacity: "var(--fs-halo-warm)" }} />
            <stop offset="1" style={{ stopColor: GOLD, stopOpacity: 0 }} />
          </radialGradient>
          <radialGradient id={`${key}-cool`} cx="22%" cy="50%" r="45%">
            <stop offset="0" style={{ stopColor: CYAN, stopOpacity: "var(--fs-halo-cool)" }} />
            <stop offset="1" style={{ stopColor: CYAN, stopOpacity: 0 }} />
          </radialGradient>
          <filter id={`${key}-bloom`} filterUnits="userSpaceOnUse" x={-20} y={-20} width={W + 40} height={H + 40}>
            <feGaussianBlur stdDeviation={2.4} result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <rect width={W} height={H} fill={`url(#${key}-cool)`} />
        <rect width={W} height={H} fill={`url(#${key}-halo)`} />
        <rect width={W} height={H} fill={`url(#${key}-grid)`} mask={`url(#${key}-vignette)`} />
        {/* The lanes, faint, drawn in as the screen opens. */}
        {[...all.sources, ...all.main, ...all.out].map((l, i) => (
          <path
            key={l.d}
            d={l.d}
            pathLength={1}
            className="anim-draw"
            fill="none"
            strokeOpacity={0.32}
            strokeWidth={1}
            style={{ stroke: l.color, animationDelay: `${200 + i * 30}ms`, animationDuration: "900ms" }}
          />
        ))}
        {all.drop.map((l) => (
          <path key={l.d} d={l.d} fill="none" strokeOpacity={0.45} strokeWidth={1} strokeDasharray="3 4" style={{ stroke: ROSE }} />
        ))}
        {/* Comets racing the lanes: steady from the sources, quicker as the stream narrows, ember into the bin. */}
        {all.sources.map((l, i) => (
          <Comet key={`c-${l.d}`} lane={l} i={i} ms={2600 + jitter(i + 40) * 1400} color={l.color} filter={bloom} />
        ))}
        {all.main.map((l, i) => (
          <Comet key={`c-${l.d}`} lane={l} i={i + 10} ms={1500 + jitter(i + 60) * 700} color={l.color} filter={bloom} />
        ))}
        {all.drop.map((l, i) => (
          <Comet key={`c-${l.d}`} lane={l} i={i + 30} ms={1900} color={l.color} filter={bloom} />
        ))}
        {all.out.map((l, i) => (
          <Comet key={`c-${l.d}`} lane={l} i={i + 40} ms={1300 + i * 150} color={l.color} filter={bloom} />
        ))}
      </svg>
      {/* The sources, each with its signal light. */}
      {layout.sources.map((box, i) => (
        <div key={SOURCES[i]} className="absolute -translate-x-1/2 -translate-y-1/2" style={place(layout, box)}>
          <div
            className="flex size-full items-center justify-center gap-1.5 rounded-md border text-[11px] font-semibold whitespace-nowrap"
            style={{ borderColor: "var(--fs-chip-line)", background: "var(--fs-chip)", color: "var(--fs-ink-soft)" }}
          >
            <span
              className="flow-blink size-1.5 shrink-0 rounded-full"
              style={{ background: CYAN, animationDelay: `${Math.round(jitter(i + 90) * 1400)}ms` }}
            />
            {tr(SOURCES[i]!)}
          </div>
        </div>
      ))}
      {/* The steps: glass cards a wave of light passes through; 筛选 is read by a scan, 精选 has a turning border. */}
      {layout.steps.map((box, i) => {
        const station = stations[i];
        if (!station) return null;
        const lit = active === i;
        const color = STEP_COLOR[i] ?? GOLD;
        const body = (
          <div
            className="flow-node relative flex size-full items-center justify-center gap-1.5 overflow-hidden rounded-[9px] border px-2"
            style={{
              animationDelay: `${i * 360}ms`,
              ["--edge" as string]: mix(color, 40),
              ["--edge-hi" as string]: HOT[color],
              ["--glow" as string]: mix(color, 50),
              background: "var(--fs-card)",
              borderColor: lit ? HOT[color] : mix(color, 40),
              boxShadow: lit ? `0 0 26px ${mix(color, 60)}` : undefined,
            }}
          >
            {i === 1 && (
              <span
                className="flow-scan-card pointer-events-none absolute inset-0"
                style={{ background: `linear-gradient(180deg, transparent 40%, ${mix(CYAN, 33)} 50%, transparent 60%)` }}
              />
            )}
            <svg
              viewBox="0 0 24 24"
              className="relative size-4 shrink-0"
              aria-hidden="true"
              fill="none"
              style={{ stroke: color }}
              strokeWidth={1.9}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {STEP_ICONS[station.name] ? <path d={STEP_ICONS[station.name]} /> : <circle cx={12} cy={12} r={5} />}
            </svg>
            <span className="relative flex min-w-0 flex-col leading-tight">
              <span className="whitespace-nowrap text-[13px] font-bold" style={{ color: "var(--fs-ink)" }}>
                {station.name}
              </span>
              <span className="mono hidden text-[8.5px] tracking-[0.14em] lg:block" style={{ color: mix(color, 75) }}>
                {CODES[i] ?? ""}
              </span>
            </span>
          </div>
        );
        return (
          <div
            key={station.name}
            className="anim-pop-in absolute -translate-x-1/2 -translate-y-1/2"
            style={{ ...place(layout, box), animationDelay: `${300 + i * 140}ms` }}
          >
            {i === 3 ? (
              <div className="relative size-full overflow-hidden rounded-[10px] p-px">
                <span
                  className="flow-spin absolute left-1/2 top-1/2 aspect-square w-[180%] -translate-x-1/2 -translate-y-1/2"
                  style={{ background: `conic-gradient(from 0deg, transparent 0 55%, ${VIOLET} 70%, ${GOLD} 82%, ${HOT[GOLD]} 86%, transparent 94%)` }}
                />
                <div className="relative size-full">{body}</div>
              </div>
            ) : (
              body
            )}
          </div>
        );
      })}
      {/* What 筛选 lets go, and where 发布 sends the rest. */}
      <div className="absolute -translate-x-1/2 -translate-y-1/2" style={place(layout, layout.bin)}>
        <div
          className="flex size-full items-center justify-center gap-1 rounded-md border text-[10.5px] font-semibold whitespace-nowrap"
          style={{ borderColor: mix(ROSE, 40), background: mix(ROSE, 8), color: ROSE }}
        >
          <span>✕</span>
          {tr("无关 · 重复")}
        </div>
      </div>
      {layout.outlets.map((box, k) => (
        <div key={`${box.x}-${box.y}`} className="absolute -translate-x-1/2 -translate-y-1/2" style={place(layout, box)}>
          <span className="flow-ping absolute inset-0 rounded-md border" style={{ borderColor: GOLD, animationDelay: `${600 + k * 500}ms` }} />
          <div
            className="relative flex size-full items-center justify-center rounded-md border text-[11px] font-bold whitespace-nowrap"
            style={{ borderColor: mix(GOLD, 70), background: mix(GOLD, 12), color: HOT[GOLD], boxShadow: `0 0 14px ${mix(GOLD, 22)}` }}
          >
            {outlets[k] ?? ""}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The pipeline screen with the steps' words under it; a step's words light its card on the screen. */
export function Convergence({ stations, outlets }: { stations: FlowStation[]; outlets: string[] }) {
  const tr = useTr();
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [active, setActive] = useState<number | null>(null);
  return (
    <figure className="mt-3" onMouseLeave={() => setActive(null)}>
      <p className="animate-fade-up max-w-[40em] text-[14px] leading-[1.8] text-ink-2">
        {tr("很多来源的消息进来，层层筛掉、合并，最后留下值得看的那一小部分。")}
      </p>
      {/* The screen, like a running console: white by day, bright navy by night. It is decoration: the words below carry the steps. */}
      <div
        className="flow-screen animate-fade-up relative mt-5 overflow-hidden rounded-2xl border"
        style={{ background: "var(--fs-bg)", borderColor: "var(--fs-border)", boxShadow: "var(--fs-shadow)" }}
        aria-hidden="true"
      >
        <span
          className="pointer-events-none absolute inset-x-8 top-0 h-px"
          style={{ background: `linear-gradient(90deg, transparent, ${mix(CYAN, 55)}, ${mix(VIOLET, 55)}, ${mix(GOLD, 55)}, transparent)` }}
        />
        <div className="mono flex items-center justify-between px-4 pt-3 text-[10.5px] tracking-[0.16em]" style={{ color: "var(--fs-ink-soft)" }}>
          <span className="flex items-center gap-2">
            <span className="flow-blink size-1.5 rounded-full" style={{ background: CYAN }} />
            <span style={{ color: CYAN }}>PIPELINE</span>
            <span>/ {tr("资讯处理流程")}</span>
          </span>
          <span className="hidden sm:inline">01 → 05</span>
        </div>
        <div className="hidden px-2 pb-3 sm:block">
          <Pipeline layout={WIDE} stations={stations} outlets={outlets} active={active} id={id} />
        </div>
        <div className="px-2 pb-3 sm:hidden">
          <Pipeline layout={TALL} stations={stations} outlets={outlets} active={null} id={id} />
        </div>
        {/* A sheen sweeping the screen now and then. */}
        <span
          className="flow-sweep pointer-events-none absolute inset-y-0 left-0 w-1/4"
          style={{ background: "linear-gradient(90deg, transparent, var(--fs-sheen), transparent)" }}
        />
      </div>
      {/* The steps' words, in order under the screen. */}
      <ol className="mt-5 grid gap-x-4 gap-y-5 sm:grid-cols-5">
        {stations.map((station, i) => (
          <li
            key={station.name}
            className="animate-fade-up border-l-2 pl-3 transition-colors duration-200"
            style={{ animationDelay: `${300 + i * 120}ms`, borderColor: active === i ? "var(--accent)" : "var(--line)" }}
            onMouseEnter={() => setActive(i)}
            onFocus={() => setActive(i)}
          >
            <div className="mono flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.12em]" aria-hidden="true">
              <span className="text-accent">{String(i + 1).padStart(2, "0")}</span>
              <span className="text-ink-4">{`/ ${CODES[i] ?? ""}`}</span>
            </div>
            <div className={`mt-1 text-[16px] font-black transition-colors duration-200 ${active === i ? "text-accent" : "text-ink"}`}>{station.name}</div>
            <div className="mt-0.5 text-[12.5px] font-semibold text-ink-2">{station.kicker}</div>
            <p className="mt-1.5 text-[13px] leading-[1.75] text-ink-3">{station.text}</p>
            {i === stations.length - 1 && outlets.length > 0 && (
              <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] font-semibold text-accent">
                {outlets.map((label, k) => (
                  <span key={label} className="inline-flex items-center gap-2">
                    {k > 0 && <span className="size-1 rounded-full bg-accent/50" aria-hidden="true" />}
                    {label}
                  </span>
                ))}
              </p>
            )}
          </li>
        ))}
      </ol>
    </figure>
  );
}
