// The opening animation (TASK-0628, Owner 2026-11-12: “打开以后是一个很动画的效果”): gold dust spirals in, the mark
// turns up and glows, the name lands letter by letter, and the screen lifts off the page. Shown once per browser on
// the home page, about four seconds, with a skip button; never to automated clients or when motion is reduced.
// The boot script decides before the first paint (so the page does not flash first) by setting html.intro; all the
// timing is CSS, so the screen also leaves by itself if this component's script never runs.
import { useEffect, useRef } from "react";
import { SITE } from "@amp/industry/site";
import { useTr } from "../../i18n";
import logoUrl from "@amp/industry/brand/logo.svg?url&no-inline";

import { INTRO_BOOT_SCRIPT, SEEN_KEY } from "./intro-boot.ts";

export { INTRO_BOOT_SCRIPT };
/** How long the screen stays before it lifts (CSS: .intro-screen). */
const INTRO_MS = 3900;
/** Fired to play the animation again (the about page's button). */
export const INTRO_REPLAY_EVENT = "amp-intro-replay";
const INTRO_SKIP_EVENT = "amp-intro-skip";

export function Intro() {
  const tr = useTr();
  const screen = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = document.documentElement;
    let frame = 0,
      timer: ReturnType<typeof setTimeout> | undefined,
      leaving: ReturnType<typeof setTimeout> | undefined;
    const leave = () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      root.classList.add("intro-out");
      leaving = setTimeout(() => {
        root.classList.remove("intro", "intro-out");
        screen.current?.querySelector("canvas")?.remove();
      }, 850);
    };
    const play = () => {
      try {
        localStorage.setItem(SEEN_KEY, "1");
      } catch {
        // Private mode: the animation simply shows again next time.
      }
      // The dust is drawn on a canvas made only while the animation plays, so other pages never carry an empty one.
      screen.current?.querySelector("canvas")?.remove();
      const cv = document.createElement("canvas");
      cv.className = "absolute inset-0 h-full w-full";
      screen.current?.prepend(cv);
      const ctx = cv.getContext("2d");
      if (ctx) {
        const ratio = Math.min(2, window.devicePixelRatio || 1),
          W = window.innerWidth,
          H = window.innerHeight,
          cx = W / 2,
          cy = H / 2 - 40;
        cv.width = W * ratio;
        cv.height = H * ratio;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        // Five arms, as in the mark. A fixed sequence, so every visit sees the same opening.
        let seed = 7;
        const next = () => {
          seed = (seed * 16807) % 2147483647;
          return seed / 2147483647;
        };
        const dust = Array.from({ length: W < 700 ? 260 : 520 }, (_, i) => ({
          arm: i % 5,
          t: next(),
          from: Math.max(W, H) * (0.5 + next() * 0.5),
          angle: next() * 6.28,
          size: 0.5 + next() * 1.6,
          light: 0.3 + next() * 0.7,
        }));
        const began = performance.now();
        const draw = (now: number) => {
          const t = (now - began) / 1000,
            k = Math.min(1, t / 1.7),
            e = 1 - (1 - k) ** 3,
            fade = t > 2.2 ? Math.max(0, 1 - (t - 2.2) / 1.2) : 1;
          ctx.clearRect(0, 0, W, H);
          ctx.globalCompositeOperation = "lighter";
          for (const p of dust) {
            const to = p.arm * 1.2566 + p.t * 3.4 + t * 0.5,
              a = p.angle + (to - p.angle) * e + (1 - e) * t * 1.5,
              r = p.from + (14 + p.t * 150 * (1 - e * 0.55) - p.from) * e;
            ctx.fillStyle = `rgba(246,212,138,${p.light * fade * (0.35 + 0.65 * e)})`;
            ctx.beginPath();
            ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.92, p.size, 0, 7);
            ctx.fill();
          }
          if (t < INTRO_MS / 1000) frame = requestAnimationFrame(draw);
        };
        frame = requestAnimationFrame(draw);
      }
      timer = setTimeout(leave, INTRO_MS);
    };
    // The boot script's decision, kept apart from the class: React may reset <html>'s attributes while it hydrates.
    const flagged = (window as { __ampIntro?: number }).__ampIntro === 1;
    (window as { __ampIntro?: number }).__ampIntro = 0;
    if (flagged || root.classList.contains("intro")) {
      root.classList.add("intro");
      play();
    }
    const replay = () => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      clearTimeout(leaving);
      root.classList.remove("intro", "intro-out");
      // Restart the CSS animations.
      void root.offsetWidth;
      root.classList.add("intro");
      play();
    };
    const key = (event: KeyboardEvent) => {
      if (root.classList.contains("intro") && (event.key === "Escape" || event.key === "Enter" || event.key === " ")) leave();
    };
    window.addEventListener(INTRO_REPLAY_EVENT, replay);
    window.addEventListener(INTRO_SKIP_EVENT, leave);
    window.addEventListener("keydown", key);
    return () => {
      clearTimeout(timer);
      clearTimeout(leaving);
      cancelAnimationFrame(frame);
      window.removeEventListener(INTRO_REPLAY_EVENT, replay);
      window.removeEventListener(INTRO_SKIP_EVENT, leave);
      window.removeEventListener("keydown", key);
    };
  }, []);
  return (
    // Hidden unless html.intro is set (app.css). Decorative: the page behind it is the content.
    <div ref={screen} className="intro-screen" aria-hidden="true" data-intro>
      <button type="button" tabIndex={-1} className="intro-skip" onClick={() => window.dispatchEvent(new Event(INTRO_SKIP_EVENT))}>
        {tr("跳过")}
      </button>
      <div className="relative text-center">
        <img src={logoUrl} alt="" width={132} height={132} className="intro-mark" />
        <p className="intro-name">
          {[...SITE.name].map((ch, i, all) => (
            <span key={`${all.slice(0, i).join("")}${ch}`} style={{ animationDelay: `${1.9 + i * 0.12}s` }}>
              {ch}
            </span>
          ))}{" "}
        </p>
        <p className="intro-line">{tr("全球金属矿业 · 一眼看清")}</p>
        <i className="intro-rule" />
      </div>
    </div>
  );
}
