// How a flood of source news becomes the few things worth reading (Owner 2026-11-06: the changelog should show the
// site's logic, many in and a few out, not only list the steps). Five stages line up with the step cards below:
// many dots stream in from the sources, pour through a funnel where the unrelated ones fade, merge into a few
// glowing clusters (one story each), and a handful of picks travel on to the web, phone and feed. No counts are
// drawn: the density tells the scale. The motion is SVG animation; with reduced motion the same picture stands still.
import { useEffect, useState } from "react";
import { useTr } from "../../i18n";

const W = 1000,
  H = 200;
/** Stage centres, one per step column (采集, 筛选, 归并, 精选, 发布). */
const X = [100, 300, 500, 700, 900] as const;
const CLUSTERS = [42, 72, 100, 128, 158] as const;
const PICKS = [62, 100, 138] as const;
const OUTLETS = [50, 100, 150] as const;

/** A fixed pseudo-random sequence, so the server and the browser draw the same picture. */
function seeded(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Fate = "dropped" | "merged" | "picked";
interface Particle {
  fate: Fate;
  path: string;
  begin: number;
  /** Where it rests in the still picture. */
  still: [number, number];
}

const DUR = 7;
const COUNT = 96;
const PARTICLES: Particle[] = (() => {
  const rand = seeded(11);
  const list: Particle[] = [];
  for (let i = 0; i < COUNT; i++) {
    const y0 = 14 + rand() * (H - 28);
    const neck = 92 + rand() * 16;
    // Many in, fewer through: roughly half fade at the funnel, most of the rest join a story, a few are picked.
    const fate: Fate = i % 10 === 3 ? "picked" : i % 2 === 0 ? "dropped" : "merged";
    const cluster = CLUSTERS[Math.floor(rand() * CLUSTERS.length)]!;
    const start = `M${-20 + rand() * 30} ${y0.toFixed(1)}`;
    const toFunnel = `C${X[0] + 60} ${y0.toFixed(1)} ${X[1] - 60} ${neck.toFixed(1)} ${X[1] + 60} ${neck.toFixed(1)}`;
    let path: string;
    let still: [number, number];
    if (fate === "dropped") {
      path = `${start} C${X[0] + 60} ${y0.toFixed(1)} ${X[1] - 80} ${(y0 * 0.6 + 40).toFixed(1)} ${X[1] - 10} ${(y0 * 0.5 + 50).toFixed(1)} L${X[1] + 10} ${H + 10}`;
      still = [X[0] - 70 + rand() * 140, y0];
    } else if (fate === "merged") {
      path = `${start} ${toFunnel} C${X[2] - 80} ${neck.toFixed(1)} ${X[2] - 50} ${cluster} ${X[2]} ${cluster}`;
      still = [X[1] + 40 + rand() * 80, neck];
    } else {
      const pick = PICKS[i % PICKS.length]!;
      const outlet = OUTLETS[i % OUTLETS.length]!;
      path = `${start} ${toFunnel} C${X[2] - 80} ${neck.toFixed(1)} ${X[2] - 50} ${cluster} ${X[2]} ${cluster} C${X[3] - 60} ${cluster} ${X[3] - 60} ${pick} ${X[3]} ${pick} C${X[4] - 80} ${pick} ${X[4] - 80} ${outlet} ${X[4] - 30} ${outlet}`;
      still = [X[3], pick];
    }
    list.push({ fate, path, begin: (i * DUR) / COUNT, still });
  }
  return list;
})();

/** Fade in at the source; the dropped fade at the funnel, the merged inside their story, the picked at the outlet. */
const OPACITY: Record<Fate, { values: string; keyTimes: string }> = {
  dropped: { values: "0;0.9;0.9;0", keyTimes: "0;0.08;0.55;1" },
  merged: { values: "0;0.9;0.9;0", keyTimes: "0;0.08;0.85;1" },
  picked: { values: "0;1;1;0", keyTimes: "0;0.06;0.92;1" },
};

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

export function AggregationFlow() {
  const tr = useTr();
  const reduced = useReducedMotion();
  const tags = [tr("多个来源一起收"), tr("无关、重复的筛掉"), tr("同一件事合成一页"), tr("挑出值得看的"), tr("网页、手机、订阅都能看")];
  return (
    <figure className="mt-4" aria-label={tr("很多来源的消息进来，层层筛掉、合并，最后留下值得看的那一小部分。")}>
      <p className="animate-fade-up max-w-[40em] text-[14px] leading-[1.8] text-ink-2">
        {tr("很多来源的消息进来，层层筛掉、合并，最后留下值得看的那一小部分。")}
      </p>
      <div className="relative mt-3 overflow-hidden rounded-control border border-line-soft bg-bg-sunk/50">
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" aria-hidden="true">
          {/* Stage bands, the funnel, the stories, the picks and the outlets. */}
          {X.map((x, i) => (
            <rect key={x} x={x - 100} y={0} width={200} height={H} className={i % 2 ? "fill-accent-soft" : "fill-transparent"} opacity={0.35} />
          ))}
          <path
            d={`M${X[1] - 80} 8 C${X[1] - 20} 8 ${X[1] + 10} 80 ${X[1] + 70} 86 M${X[1] - 80} ${H - 8} C${X[1] - 20} ${H - 8} ${X[1] + 10} 120 ${X[1] + 70} 114`}
            className="fill-none stroke-accent"
            strokeWidth={2}
            opacity={0.55}
          />
          {/* Faint guides: the funnel's neck feeds the stories, the stories feed the picks, the picks reach the outlets. */}
          <g className="fill-none stroke-accent" strokeWidth={1.2} opacity={0.28}>
            {CLUSTERS.map((y) => (
              <path key={`n${y}`} d={`M${X[1] + 70} 100 C${X[2] - 70} 100 ${X[2] - 60} ${y} ${X[2] - 12} ${y}`} />
            ))}
            {PICKS.map((y, i) => (
              <path key={`p${y}`} d={`M${X[2] + 12} ${CLUSTERS[i + 1]} C${X[3] - 60} ${CLUSTERS[i + 1]} ${X[3] - 60} ${y} ${X[3] - 14} ${y}`} />
            ))}
            {PICKS.map((y, i) => (
              <path key={`o${y}`} d={`M${X[3] + 14} ${y} C${X[4] - 80} ${y} ${X[4] - 80} ${OUTLETS[i]} ${X[4] - 30} ${OUTLETS[i]}`} />
            ))}
          </g>
          {CLUSTERS.map((y, i) => (
            <g key={y}>
              <circle
                cx={X[2]}
                cy={y}
                r={11}
                className={`fill-accent ${reduced ? "" : "map-pulse"}`}
                opacity={0.18}
                style={{ animationDelay: `${i * 0.6}s` }}
              />
              <circle cx={X[2]} cy={y} r={6.5} className="fill-accent" opacity={0.85} />
            </g>
          ))}
          {PICKS.map((y) => (
            <path
              key={y}
              transform={`translate(${X[3]} ${y})`}
              d="M0 -10 L2.9 -3.6 L9.5 -3.1 L4.4 1.3 L5.9 8.1 L0 4.6 L-5.9 8.1 L-4.4 1.3 L-9.5 -3.1 L-2.9 -3.6 Z"
              className="fill-hot"
            />
          ))}
          {OUTLETS.map((y, i) => (
            <g key={y} transform={`translate(${X[4] + 4} ${y})`} className="stroke-ink-2" fill="none" strokeWidth={2} strokeLinecap="round">
              {i === 0 && <path d="M-16 -10 h32 v20 h-32 z M-6 14 h12" />}
              {i === 1 && <path d="M-8 -14 h16 v28 h-16 z M-2 10 h4" />}
              {i === 2 && (
                <>
                  <path d="M-9 -9 a18 18 0 0 1 18 18 M-9 -1 a10 10 0 0 1 10 10" />
                  <circle cx={-8} cy={8} r={1.6} className="fill-ink-2" stroke="none" />
                </>
              )}
            </g>
          ))}
          {/* The flow itself: each dot rides its path; in the still picture it rests where its stage is. */}
          {PARTICLES.map((p, i) =>
            reduced ? (
              <circle
                key={p.path}
                cx={p.still[0]}
                cy={p.still[1]}
                r={p.fate === "picked" ? 5 : 3}
                className={p.fate === "picked" ? "fill-hot" : p.fate === "dropped" ? "fill-ink-4" : "fill-accent"}
                opacity={p.fate === "dropped" ? 0.45 : 0.85}
              />
            ) : (
              <circle key={p.path} r={p.fate === "picked" ? 5 : 3} className={p.fate === "picked" ? "fill-hot" : "fill-accent"} opacity={0}>
                <animateMotion
                  path={p.path}
                  dur={`${p.fate === "picked" ? DUR * 1.15 : DUR}s`}
                  begin={`${(p.begin + (i % 3) * 0.13).toFixed(2)}s`}
                  repeatCount="indefinite"
                />
                <animate
                  attributeName="opacity"
                  values={OPACITY[p.fate].values}
                  keyTimes={OPACITY[p.fate].keyTimes}
                  dur={`${p.fate === "picked" ? DUR * 1.15 : DUR}s`}
                  begin={`${(p.begin + (i % 3) * 0.13).toFixed(2)}s`}
                  repeatCount="indefinite"
                />
              </circle>
            ),
          )}
        </svg>
        <ol className="grid grid-cols-5 border-t border-line-soft">
          {tags.map((tag, i) => (
            <li
              key={tag}
              className="animate-fade-up px-1 py-2 text-center text-[11.5px] font-semibold leading-[1.4] text-ink-3 sm:text-[12.5px]"
              style={{ animationDelay: `${300 + i * 140}ms` }}
            >
              {tag}
            </li>
          ))}
        </ol>
      </div>
    </figure>
  );
}
