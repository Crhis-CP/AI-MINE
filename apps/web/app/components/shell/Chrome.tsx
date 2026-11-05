import { useEffect, useRef, useState } from "react";
import { IconArrowUp } from "../icons";

/** A thin accent line while a navigation is in flight (shown only if it takes a moment). */
export function NavigationProgress({ active }: { active: boolean }) {
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (active) timer.current = setTimeout(() => setVisible(true), 150);
    else {
      if (timer.current) clearTimeout(timer.current);
      setVisible(false);
    }
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [active]);
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-[2px] overflow-hidden" aria-hidden="true">
      <div
        className="h-full origin-left bg-accent"
        style={{
          transform: `scaleX(${visible ? 0.85 : active ? 0 : 1})`,
          opacity: visible ? 1 : 0,
          transition: visible ? "transform 2.4s cubic-bezier(0.1, 0.7, 0.2, 1), opacity 120ms" : "transform 200ms, opacity 300ms 120ms",
        }}
      />
    </div>
  );
}

/** Round "back to top" button once the reader has scrolled a screen or so. */
export function BackToTop() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const onScroll = () => setShown(window.scrollY > window.innerHeight * 1.2);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <button
      type="button"
      aria-label="回到顶部"
      onClick={() => window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })}
      className={`fixed bottom-[calc(70px+env(safe-area-inset-bottom))] right-4 z-30 flex size-11 items-center justify-center rounded-full border border-line bg-surface text-ink-2 shadow-[var(--shadow-soft)] transition-all duration-200 hover:text-ink lg:bottom-6 lg:right-6 ${
        shown ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0"
      }`}
    >
      <IconArrowUp size={18} />
    </button>
  );
}

/**
 * j / k move to the next or previous item on a list page (the item titles, `.feed-title`), as feed
 * readers do; ignored while typing, with modifier keys, or when the page has no list.
 */
export function ListKeys() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || (event.key !== "j" && event.key !== "k")) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], dialog[open]")) return;
      const titles = [...document.querySelectorAll<HTMLElement>("#main .feed-title")].filter((el) => el.getClientRects().length > 0);
      if (!titles.length) return;
      const current = titles.indexOf(document.activeElement as HTMLElement);
      let next: number;
      if (current >= 0) next = current + (event.key === "j" ? 1 : -1);
      else {
        // Nothing focused yet: start from the first title below the top of the screen.
        const below = titles.findIndex((el) => el.getBoundingClientRect().top > 64);
        next = event.key === "j" ? Math.max(0, below) : Math.max(0, (below < 0 ? titles.length : below) - 1);
      }
      const el = titles[Math.min(titles.length - 1, Math.max(0, next))];
      if (!el) return;
      event.preventDefault();
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
}
