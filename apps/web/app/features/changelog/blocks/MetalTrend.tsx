// A metal price's trend line as the film recorded it (TASK-0367): one point per officially published period, joined in
// order and never filled in. Pointing at the line, or the arrow keys once it has focus, shows that period's price as
// published. Screen readers hear one announcement per step: the slider's value on a key, the live region when a press
// ends; moving the pointer is not read aloud.
import { type KeyboardEvent, type PointerEvent, useState } from "react";
import { IntentLink as Link } from "../../../components/ui/IntentLink";
import { useTr } from "../../../i18n";
import { plot, priceLabel, usePeriodLabel, usePriceWords } from "./format";
import type { FilmMetal } from "./types";

const W = 240,
  H = 64,
  PAD = 4;

function Line({ metal }: { metal: FilmMetal }) {
  const tr = useTr();
  const say = usePriceWords();
  const period = usePeriodLabel();
  const pts = plot(metal);
  const last = metal.points.length - 1;
  const [at, setAt] = useState(last);
  // What the live region says: set when a press ends (a key step is announced by the slider's own value).
  const [said, setSaid] = useState("");
  const point = metal.points[at]!;
  const up = Number(metal.points[last]!.value) >= Number(metal.points[0]!.value);
  const stroke = up ? "var(--hot)" : "var(--ok)";
  const path = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const pick = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    setAt(Math.max(0, Math.min(last, Math.round(((e.clientX - box.left) / box.width) * last))));
  };
  const text = (i: number) => `${period(metal.points[i]!)} ${priceLabel(metal.points[i]!.value, metal.decimals)} ${say(metal.unit)}`;
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: last }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const step = Math.max(0, Math.min(last, next));
    setAt(step);
  };
  const valueText = text(at);
  return (
    <figure className="min-w-0">
      <figcaption className="flex items-baseline justify-between gap-2 text-[12px] text-ink-3">
        <span className="min-w-0 truncate">
          <b className="font-semibold text-ink">{say(metal.metal)}</b> {say(metal.quote)}
        </span>
        <span className="shrink-0 text-ink-4">{say(metal.unit)}</span>
      </figcaption>
      <div
        className="mt-1 cursor-crosshair touch-pan-y rounded-sm focus-visible:outline-2 focus-visible:outline-accent"
        tabIndex={0}
        role="slider"
        aria-label={tr("{metal}价格走势，共 {count} 期", { metal: say(metal.metal), count: metal.points.length })}
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={at}
        aria-valuetext={valueText}
        onPointerDown={pick}
        onPointerMove={pick}
        onPointerUp={() => setSaid(valueText)}
        onKeyDown={key}
      >
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full overflow-visible" aria-hidden="true">
          <path d={`${path}V${H}H${PAD}Z`} fill={stroke} opacity={0.1} />
          <path d={path} pathLength={1} fill="none" stroke={stroke} strokeWidth={1.6} strokeLinejoin="round" className="anim-draw" />
          <line x1={pts[at]![0]} x2={pts[at]![0]} y1={0} y2={H} stroke="var(--ink-4)" strokeWidth={0.75} />
          <circle cx={pts[at]![0]} cy={pts[at]![1]} r={3.2} fill="var(--surface)" stroke={stroke} strokeWidth={1.6} />
        </svg>
      </div>
      <p className="sr-only" aria-live="polite">
        {said}
      </p>
      <p className="mt-0.5 flex justify-between gap-2 text-[11.5px] text-ink-4" aria-hidden="true">
        <span className="truncate">{period(point)}</span>
        <span className="mono shrink-0 tabular-nums text-ink-2">{priceLabel(point.value, metal.decimals)}</span>
      </p>
    </figure>
  );
}

export function MetalTrend({ metals }: { metals: FilmMetal[] }) {
  const tr = useTr();
  return (
    <div className="space-y-3">
      {metals.map((metal) => (
        <Line key={`${metal.metal}-${metal.quote}`} metal={metal} />
      ))}
      <Link to="/metals" className="inline-flex min-h-10 items-center text-[13px] font-semibold text-accent hover:text-hot">
        {tr("查看金属价格")} →
      </Link>
    </div>
  );
}
