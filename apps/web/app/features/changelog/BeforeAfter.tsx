// One redesign change shown as a picture (Owner 2026-11-06: “这些应该用图片说，以前什么样子现在什么样子”): the old
// and the new screen of the same page, same size. Page screens are stacked and a handle reveals one over the other; the
// handle is a native range input, so it drags with mouse or finger and moves with the arrow keys. Marks and phone
// screens, which say nothing when cut in half, stand side by side. Screen readers get both pictures' text.
import { useId, useState } from "react";
import { useTr } from "../../i18n";

export interface Comparison {
  before: string;
  after: string;
  width: number;
  height: number;
}

const badge = "pointer-events-none absolute bottom-2 rounded-full px-2.5 py-0.5 text-[12px] font-semibold shadow-sm";

export function BeforeAfter({ value, label, side = false }: { value: Comparison; label: string; side?: boolean }) {
  const tr = useTr();
  const id = useId();
  const [position, setPosition] = useState(50);
  const img = (src: string, alt: string, extra = "") => (
    <img
      src={src}
      width={value.width}
      height={value.height}
      alt={alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      className={`block h-auto w-full select-none ${extra}`}
    />
  );
  const before = (
    <span className={`${badge} left-2 bg-ink/75 text-bg`} aria-hidden="true">
      {tr("改版前")}
    </span>
  );
  const after = (
    <span className={`${badge} right-2 bg-accent text-white`} aria-hidden="true">
      {tr("改版后")}
    </span>
  );
  if (side)
    return (
      <figure className="m-0 grid grid-cols-2 gap-2">
        {[
          [value.before, tr("改版前：{label}", { label }), before],
          [value.after, tr("改版后：{label}", { label }), after],
        ].map(([src, alt, mark]) => (
          <div key={String(src)} className="relative overflow-hidden rounded-control border border-line bg-bg-sunk">
            {img(String(src), String(alt))}
            {mark}
          </div>
        ))}
      </figure>
    );
  return (
    <figure className="m-0">
      <div className="relative overflow-hidden rounded-control border border-line bg-bg-sunk" style={{ aspectRatio: `${value.width} / ${value.height}` }}>
        {img(value.after, tr("改版后：{label}", { label }))}
        <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}>
          {img(value.before, tr("改版前：{label}", { label }), "h-full object-cover object-left-top")}
        </div>
        <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-accent" style={{ left: `calc(${position}% - 1px)` }} aria-hidden="true">
          <span className="absolute top-1/2 left-1/2 flex size-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-accent bg-bg text-[13px] font-bold text-accent shadow-md">
            ⇆
          </span>
        </div>
        {before}
        {after}
        <input
          id={id}
          type="range"
          min={0}
          max={100}
          step={1}
          value={position}
          onChange={(event) => setPosition(Number(event.currentTarget.value))}
          aria-label={tr("拖动比较改版前后：{label}", { label })}
          className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
        />
      </div>
    </figure>
  );
}
