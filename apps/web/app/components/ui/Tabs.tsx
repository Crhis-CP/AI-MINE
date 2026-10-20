import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { IntentLink } from "./IntentLink";
import { IconChevronLeft, IconChevronRight } from "../icons";
import { useEntrance } from "../../lib/hydration";

/** Where each switch's thumb sat when it last left, relative to its track. */
const thumbs = new Map<string, { left: number; width: number; at: number }>();

function placeOf(el: HTMLElement) {
  const tab = el.parentElement!.getBoundingClientRect();
  const track = el.closest("[data-pill-track]")?.getBoundingClientRect();
  return { left: tab.left - (track?.left ?? 0), width: tab.width, at: Date.now() };
}

/**
 * The white thumb inside the chosen option. It is rendered in place (so it is right without
 * JavaScript) and, when the choice moves, glides over from where the previous thumb was.
 */
function Thumb({ id }: { id: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const entrance = useEntrance();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const now = placeOf(el);
    const prev = thumbs.get(id);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (entrance && !reduce && prev && now.at - prev.at < 1000 && (prev.left !== now.left || prev.width !== now.width) && el.animate) {
      el.animate(
        [
          { transform: `translateX(${prev.left - now.left}px)`, width: `${prev.width}px` },
          { transform: "translateX(0)", width: `${now.width}px` },
        ],
        { duration: 300, easing: "cubic-bezier(0.25, 1, 0.5, 1)" },
      );
    }
    return () => {
      thumbs.set(id, placeOf(el));
    };
  }, [id, entrance]);
  return <span ref={ref} className="absolute inset-0 rounded-full bg-surface shadow-[var(--shadow-thumb)] ring-1 ring-line dark:bg-raised" />;
}

export interface TabItem {
  key: string;
  label: ReactNode;
  /** Link target; tabs without one call onSelect. */
  to?: string;
  prefetch?: "intent";
  replace?: boolean;
  /** A changed filter starts at its first result; ordinary panel switches retain position. */
  resetScroll?: boolean;
  count?: number | null;
}

const SIZES = {
  md: "h-9 px-4 text-[14px]",
  sm: "h-8 px-3.5 text-[13px]",
  xs: "h-7 px-3 text-[12.5px]",
} as const;

/**
 * The site's one switch control: a grey pill track with a white thumb that glides to the chosen
 * option. Boards, categories, sources, report kinds, page sections and language all use it, so every
 * switch looks and moves the same. Scrolls sideways when it runs out of room; `fill` spreads the
 * options evenly across the available width.
 */
export function PillTabs({
  items,
  active,
  onSelect,
  layoutId,
  size = "md",
  label,
  fill = false,
  className = "",
}: {
  items: TabItem[];
  active: string;
  onSelect?: (key: string) => void;
  /** Unique per control on a page, for the gliding thumb. */
  layoutId: string;
  size?: keyof typeof SIZES;
  label?: string;
  fill?: boolean;
  className?: string;
}) {
  const links = items.some((t) => t.to);
  const wrapper = useRef<HTMLDivElement>(null),
    viewport = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ overflow: false, left: false, right: false });
  useLayoutEffect(() => {
    const el = viewport.current,
      outer = wrapper.current;
    if (!el || !outer) return;
    if (!items.length) {
      setScroll({ overflow: false, left: false, right: false });
      return;
    }
    const measure = () =>
      setScroll({ overflow: el.scrollWidth > outer.clientWidth + 2, left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    observer.observe(outer);
    const track = el.querySelector(links ? "nav" : "[role=tablist]");
    if (track) observer.observe(track);
    el.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", measure);
    };
  }, [items.length, links]);
  const move = (direction: number) => {
    const el = viewport.current;
    if (!el) return;
    el.scrollBy({
      left: direction * Math.max(160, el.clientWidth * 0.7),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
  };
  const Track = links ? "nav" : "div";
  return (
    <div ref={wrapper} className={`flex max-w-full items-center gap-1 ${fill ? "w-full" : ""} ${className}`}>
      {scroll.overflow && (
        <button
          type="button"
          aria-label={`${label ?? "选项"}向左滚动`}
          disabled={!scroll.left}
          onClick={() => move(-1)}
          className="hidden size-9 shrink-0 place-items-center rounded-full border border-line text-ink-3 disabled:opacity-30 lg:grid"
        >
          <IconChevronLeft size={18} />
        </button>
      )}
      <div ref={viewport} className={`scrollbar-none min-w-0 max-w-full overflow-x-auto ${fill ? "flex-1" : ""}`}>
        <Track
          data-pill-track=""
          aria-label={label}
          role={links ? undefined : "tablist"}
          className={`${fill ? "grid w-full" : "inline-flex w-max"} gap-0.5 rounded-full bg-bg-sunk p-[3px] ring-1 ring-inset ring-line-soft dark:bg-bg-muted/60`}
          style={fill ? { gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` } : undefined}
        >
          {items.map((t) => {
            const on = t.key === active;
            const inner = (
              <>
                {on && <Thumb id={layoutId} />}
                <span className="relative inline-flex items-center gap-1">
                  {t.label}
                  {t.count !== undefined && t.count !== null && (
                    <span className={`num text-[0.86em] font-normal ${on ? "text-ink-3" : "text-ink-4"}`}>{t.count}</span>
                  )}
                </span>
              </>
            );
            const cls = `relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-full font-medium outline-offset-1 transition-colors duration-150 active:scale-[0.98] ${SIZES[size]} ${on ? "text-ink" : "text-ink-3 hover:text-ink"}`;
            const TabLink = t.prefetch === "intent" ? IntentLink : Link;
            return t.to ? (
              <TabLink key={t.key} to={t.to} replace={t.replace} preventScrollReset={!t.resetScroll} aria-current={on ? "page" : undefined} className={cls}>
                {inner}
              </TabLink>
            ) : (
              <button key={t.key} type="button" role="tab" aria-selected={on} onClick={() => onSelect?.(t.key)} className={cls}>
                {inner}
              </button>
            );
          })}
        </Track>
      </div>
      {scroll.overflow && (
        <button
          type="button"
          aria-label={`${label ?? "选项"}向右滚动`}
          disabled={!scroll.right}
          onClick={() => move(1)}
          className="hidden size-9 shrink-0 place-items-center rounded-full border border-line text-ink-3 disabled:opacity-30 lg:grid"
        >
          <IconChevronRight size={18} />
        </button>
      )}
    </div>
  );
}
