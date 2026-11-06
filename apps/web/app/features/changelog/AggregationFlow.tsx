// The site's steps as one gathering line (Owner 2026-11-06: “穿起来，一条收束线”, many in and a few out, the steps
// threaded on it rather than drawn beside it). Thin threads come in from many sources; at 筛选 about half of them end,
// the rest draw together; at 归并 they twist into a few strands, one story each; at 精选 the strands narrow to two
// bright lines; at 发布 one line runs on to where readers read. Each step's badge sits on the line where it narrows,
// its card below; news keeps flowing along the threads. No counts are drawn: the narrowing tells the scale.
// SVG animation from a fixed seed, so the server and the browser draw the same; reduced motion keeps the still line.
import { useEffect, useState } from "react";
import { useTr } from "../../i18n";

export interface FlowStation {
  name: string;
  kicker: string;
  text: string;
}

const W = 1000,
  H = 200,
  MID = 100;
/** Where each of the five steps sits on the line. */
const X = [100, 300, 500, 700, 900] as const;
const THREADS = 26;
/** The stories the kept threads twist into, and the two lines the picks narrow to. */
const STORIES = [70, 90, 110, 130] as const;
const PICKS = [92, 108] as const;

function seeded(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Thread {
  kept: boolean;
  /** The thread's own drawn path: a dropped one ends at the filter, a kept one at its story. */
  d: string;
  /** The whole way a piece of news on it travels to the readers. */
  ride: string;
}

const LINES: Thread[] = (() => {
  const rand = seeded(7);
  const threads: Thread[] = [];
  for (let i = 0; i < THREADS; i++) {
    const y = 12 + ((H - 24) * (i + 0.5)) / THREADS + (rand() - 0.5) * 4;
    const kept = i % 2 === 1;
    const story = STORIES[Math.min(STORIES.length - 1, Math.floor((i / THREADS) * STORIES.length))]!;
    const pick = PICKS[story < MID ? 0 : 1]!;
    const near = MID + (y - MID) * 0.42;
    if (!kept) {
      const end = MID + (y - MID) * 0.62;
      const d = `M0 ${y.toFixed(1)} C${X[0] + 70} ${y.toFixed(1)} ${X[1] - 90} ${end.toFixed(1)} ${X[1] - 18} ${end.toFixed(1)}`;
      threads.push({ kept, d, ride: d });
    } else {
      const d = `M0 ${y.toFixed(1)} C${X[0] + 70} ${y.toFixed(1)} ${X[1] - 80} ${near.toFixed(1)} ${X[1]} ${near.toFixed(1)} C${X[1] + 90} ${near.toFixed(1)} ${X[2] - 90} ${story} ${X[2]} ${story}`;
      const ride = `${d} C${X[2] + 90} ${story} ${X[3] - 90} ${pick} ${X[3]} ${pick} C${X[3] + 90} ${pick} ${X[4] - 90} ${MID} ${X[4]} ${MID} L${W} ${MID}`;
      threads.push({ kept, d, ride });
    }
  }
  return threads;
})();

/** Two pieces of news per thread: on dropped threads they fade at the filter; one in three kept ones travels on. */
const NEWS = LINES.flatMap((line, i) =>
  [0, 1].map((k) => ({
    line,
    key: `${i}-${k}`,
    dur: line.kept ? 8 : 4.2,
    begin: ((i * 0.53 + k * 3.7) % 8).toFixed(2),
    through: line.kept && (i + k) % 3 === 0,
  })),
);

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

const STEP_ICONS: Record<string, string> = {
  采集: "M4 13l2-7h12l2 7v5H4z M4 13h5l1.5 2h3l1.5-2h5",
  筛选: "M4 5h16l-6 7.5V18l-4 2v-7.5z",
  归并: "M6 4v3a5 5 0 0 0 5 5h1 M18 4v3a5 5 0 0 1-5 5h-1 M12 12v8",
  精选: "M12 3.5l2.6 5.3 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z",
  发布: "M4 11.5l16-7-5.5 16-3.2-6.3z M11.3 14.2l3.5-3.5",
};

/** One gathering line with the steps threaded on it; their cards below light their place on the line. */
export function Convergence({ stations, outlets }: { stations: FlowStation[]; outlets: string[] }) {
  const tr = useTr();
  const reduced = useReducedMotion();
  const [active, setActive] = useState<number | null>(null);
  const lit = (i: number) => active === i;
  return (
    <figure className="mt-4" onMouseLeave={() => setActive(null)}>
      <p className="animate-fade-up max-w-[40em] text-[14px] leading-[1.8] text-ink-2">
        {tr("很多来源的消息进来，层层筛掉、合并，最后留下值得看的那一小部分。")}
      </p>
      <div className="relative mt-4">
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full overflow-visible" aria-hidden="true">
          {/* The step under the reader's pointer: its stretch of the line lights. */}
          {active !== null && <rect x={X[active]! - 100} y={0} width={200} height={H} rx={14} className="fill-accent-soft" opacity={0.7} />}
          {/* 采集 → 筛选 → 归并: many thin threads; the dropped ones end at the filter, the kept ones draw into stories. */}
          {LINES.map((line, i) => (
            <path
              key={line.d}
              d={line.d}
              pathLength={1}
              className={`anim-draw fill-none ${line.kept ? "stroke-accent" : "stroke-ink-4"}`}
              strokeWidth={line.kept ? 1.4 : 1}
              opacity={line.kept ? 0.6 : 0.35}
              style={{ animationDelay: `${120 + i * 18}ms`, animationDuration: "900ms" }}
            />
          ))}
          {/* 归并 → 精选: the stories, thicker, narrowing to two bright lines. */}
          {STORIES.map((y, i) => (
            <path
              key={y}
              d={`M${X[2]} ${y} C${X[2] + 90} ${y} ${X[3] - 90} ${PICKS[y < MID ? 0 : 1]} ${X[3]} ${PICKS[y < MID ? 0 : 1]}`}
              pathLength={1}
              className="anim-draw fill-none stroke-accent"
              strokeWidth={3}
              strokeLinecap="round"
              opacity={0.85}
              style={{ animationDelay: `${900 + i * 60}ms`, animationDuration: "700ms" }}
            />
          ))}
          {/* 精选 → 发布: two bright lines become one, and it runs on to the readers. */}
          {PICKS.map((y) => (
            <path
              key={y}
              d={`M${X[3]} ${y} C${X[3] + 90} ${y} ${X[4] - 90} ${MID} ${X[4]} ${MID}`}
              pathLength={1}
              className="anim-draw fill-none stroke-hot"
              strokeWidth={4}
              strokeLinecap="round"
              style={{ animationDelay: "1500ms", animationDuration: "600ms" }}
            />
          ))}
          <path
            d={`M${X[4]} ${MID} L${W - 8} ${MID} M${W - 22} ${MID - 9} L${W - 8} ${MID} L${W - 22} ${MID + 9}`}
            pathLength={1}
            className="anim-draw fill-none stroke-hot"
            strokeWidth={5}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ animationDelay: "2000ms", animationDuration: "500ms" }}
          />
          {/* News moving along the threads: faint on the dropped ones, bright on the way out. */}
          {!reduced &&
            NEWS.map((n) => (
              <circle key={n.key} r={n.through ? 4.2 : 2.6} className={n.through ? "fill-hot" : n.line.kept ? "fill-accent" : "fill-ink-4"} opacity={0}>
                <animateMotion path={n.through ? n.line.ride : n.line.d} dur={`${n.dur}s`} begin={`${n.begin}s`} repeatCount="indefinite" />
                <animate
                  attributeName="opacity"
                  values={n.through ? "0;1;1;0" : n.line.kept ? "0;0.9;0.9;0" : "0;0.7;0.5;0"}
                  keyTimes={n.through ? "0;0.05;0.94;1" : "0;0.1;0.85;1"}
                  dur={`${n.dur}s`}
                  begin={`${n.begin}s`}
                  repeatCount="indefinite"
                />
              </circle>
            ))}
        </svg>
        {/* The steps, threaded on the line where it narrows. */}
        {stations.map((station, i) => (
          <span
            key={station.name}
            className="anim-pop-in absolute top-1/2 grid -translate-x-1/2 -translate-y-1/2 place-items-center"
            style={{ left: `${(X[i]! / W) * 100}%`, animationDelay: `${300 + i * 380}ms` }}
          >
            {i === stations.length - 1 && <span className="notice-breathe absolute inset-0 rounded-full bg-hot/20" aria-hidden="true" />}
            <span
              className={`relative grid size-8 place-items-center rounded-full border-2 bg-surface shadow-sm transition duration-200 sm:size-11 ${
                lit(i) ? "scale-110 border-hot bg-hot text-white" : i >= 3 ? "border-hot text-hot" : "border-accent text-accent"
              }`}
            >
              <svg
                viewBox="0 0 24 24"
                className="size-4 sm:size-5"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                {STEP_ICONS[station.name] ? <path d={STEP_ICONS[station.name]} /> : <circle cx={12} cy={12} r={5} />}
              </svg>
            </span>
          </span>
        ))}
      </div>
      {/* The cards, each under its place on the line; on a phone they stack, numbered as on the line. */}
      <ol className="mt-3 grid gap-2 sm:grid-cols-5 sm:gap-0">
        {stations.map((station, i) => (
          <li
            key={station.name}
            className="animate-fade-up sm:px-1.5"
            style={{ animationDelay: `${500 + i * 380}ms` }}
            onMouseEnter={() => setActive(i)}
            onFocus={() => setActive(i)}
          >
            <div
              className={`h-full rounded-control border px-3.5 py-3 transition duration-200 ${
                lit(i) ? "-translate-y-1 border-accent bg-accent-soft/70 shadow-sm" : "border-line-soft bg-bg-sunk/60"
              }`}
            >
              <div className="flex items-baseline gap-2">
                <span className="mono text-[11px] font-semibold text-ink-4">{String(i + 1).padStart(2, "0")}</span>
                <span className="text-[16px] font-black text-ink">{station.name}</span>
              </div>
              <div className={`mt-0.5 text-[12.5px] font-semibold ${lit(i) ? "text-hot" : "text-accent"}`}>{station.kicker}</div>
              <p className="mt-2 text-[12.5px] leading-[1.7] text-ink-3">{station.text}</p>
            </div>
          </li>
        ))}
      </ol>
      {outlets.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <span className="animate-fade-up text-[12px] font-semibold text-ink-3" style={{ animationDelay: "2200ms" }}>
            {tr("公开出去")} →
          </span>
          {outlets.map((label, i) => (
            <span key={label} className="anim-slide-in-x inline-flex" style={{ animationDelay: `${2300 + i * 120}ms` }}>
              <span className="rounded-full border border-hot/50 bg-hot/10 px-3 py-1 text-[12.5px] font-semibold text-hot transition duration-200 hover:-translate-y-0.5 hover:bg-hot hover:text-white">
                {label}
              </span>
            </span>
          ))}
        </div>
      )}
    </figure>
  );
}
