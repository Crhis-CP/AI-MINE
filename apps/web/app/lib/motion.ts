import { useEffect, useRef, useState } from "react";

export const scrollBehavior = (): ScrollBehavior => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");
const landing = (element: Element) => Number.parseFloat(getComputedStyle(element).scrollMarginTop) || 0;

/** Jump within this reading entry without adding another step to Back. */
export function scrollToAnchor(id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  target.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  history.replaceState(history.state, "", `${location.pathname}${location.search}#${encodeURIComponent(id)}`);
}

/** At the page's end several short sections can fit together; keep the one the reader chose. */
export function useCurrentSection(ids: string[], watch = true, scope = ""): [string | null, (id: string) => void] {
  const [current, setCurrent] = useState<string | null>(null);
  const jumped = useRef<{ id: string; landed: boolean } | null>(null);
  const key = [scope, ...ids].join("\u0000");
  useEffect(() => {
    jumped.current = null;
    if (!watch) {
      setCurrent(null);
      return;
    }
    const sections = key.split("\u0000").slice(1).filter(Boolean);
    let frame = 0;
    const update = () => {
      frame = 0;
      let at: string | null = null;
      for (const id of sections) {
        const element = document.getElementById(id);
        if (element && element.getBoundingClientRect().top <= landing(element) + 1) at = id;
      }
      const bottom = window.scrollY > 0 && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      if (bottom) {
        at = jumped.current?.id ?? sections.at(-1) ?? null;
        if (jumped.current) jumped.current.landed = true;
      } else if (jumped.current?.landed) jumped.current = null;
      setCurrent(at);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const resized = new ResizeObserver(schedule);
    resized.observe(document.body);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      resized.disconnect();
    };
  }, [key, watch]);
  const go = (id: string) => {
    const element = document.getElementById(id);
    if (!element) return;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const destination = window.scrollY + element.getBoundingClientRect().top - landing(element);
    jumped.current = destination >= max - 1 ? { id, landed: false } : null;
    setCurrent(id);
    scrollToAnchor(id);
  };
  return [current, go];
}
