// A slowly turning globe of the site's own land dots (the reader map's world-dots.svg) with a light column on each
// country, as tall as its number (访问概况, TASK-0623). Drawn on a canvas; it can be dragged, stands still when motion
// is reduced, and every number it shows is also in the list beside it, so nothing is readable only here.
import { useEffect, useRef } from "react";
import dotsUrl from "@amp/industry/brand/world-dots.svg?url&no-inline";
import frame from "@amp/industry/brand/world-dots.json";
import { WORLD_POINTS } from "../feed/world-points";

export interface GlobePoint {
  code: string;
  label: string;
  value: number;
}
type Vec = readonly [number, number, number];
const onSphere = (lon: number, lat: number): Vec => {
  const a = (lon * Math.PI) / 180,
    b = (lat * Math.PI) / 180;
  return [Math.cos(b) * Math.sin(a), Math.sin(b), Math.cos(b) * Math.cos(a)];
};
/** Countries the globe can place; the rest stay in the list only. */
export const globeCountries = (rows: readonly GlobePoint[]) => rows.filter((row) => WORLD_POINTS[row.code]);

let land: Promise<Vec[]> | null = null;
function readLand(): Promise<Vec[]> {
  land ??= fetch(dotsUrl)
    .then((response) => (response.ok ? response.text() : Promise.reject(new Error("dots unavailable"))))
    .then((svg) => [...svg.matchAll(/M(\d+) (\d+)h0/g)].map((m) => onSphere(Number(m[1]) + frame.west, frame.north - Number(m[2]))))
    .catch(() => {
      land = null;
      return [];
    });
  return land;
}

export function VisitGlobe({ points, label }: { points: readonly GlobePoint[]; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const data = useRef(points);
  data.current = points;
  useEffect(() => {
    const cv = canvas.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let dots: Vec[] = [],
      width = 0,
      height = 0,
      radius = 0,
      frameId = 0,
      stopped = false,
      drag: { x: number; turn: number } | null = null;
    // Start over the country with the highest number, so the first thing seen is the answer.
    const first = [...data.current].sort((a, b) => b.value - a.value).find((p) => WORLD_POINTS[p.code]);
    let turn = (first ? (-WORLD_POINTS[first.code]![0] * Math.PI) / 180 : 0) - (still ? 0 : 0.5);
    const tilt = 0.3;
    const size = () => {
      const box = cv.getBoundingClientRect(),
        ratio = Math.min(2, window.devicePixelRatio || 1);
      width = box.width;
      height = box.height;
      cv.width = Math.round(width * ratio);
      cv.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      radius = Math.min(width, height) * 0.42;
    };
    const project = (p: Vec) => {
      const c = Math.cos(turn),
        s = Math.sin(turn),
        x = p[0] * c + p[2] * s,
        z = -p[0] * s + p[2] * c,
        y = p[1] * Math.cos(tilt) - z * Math.sin(tilt),
        depth = p[1] * Math.sin(tilt) + z * Math.cos(tilt);
      return [width / 2 + x * radius, height / 2 - y * radius, depth] as const;
    };
    const draw = (time: number) => {
      if (stopped) return;
      ctx.clearRect(0, 0, width, height);
      const glow = ctx.createRadialGradient(width / 2 - radius * 0.3, height / 2 - radius * 0.4, radius * 0.1, width / 2, height / 2, radius * 1.25);
      glow.addColorStop(0, "rgba(226,176,79,.20)");
      glow.addColorStop(0.75, "rgba(226,176,79,.04)");
      glow.addColorStop(1, "rgba(226,176,79,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(width / 2, height / 2, radius * 1.25, 0, 7);
      ctx.fill();
      ctx.strokeStyle = "rgba(246,212,138,.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(width / 2, height / 2, radius, 0, 7);
      ctx.stroke();
      for (const dot of dots) {
        const [x, y, depth] = project(dot);
        if (depth < 0) continue;
        ctx.fillStyle = `rgba(226,190,120,${0.18 + depth * 0.62})`;
        ctx.fillRect(x - 0.9, y - 0.9, 1.8, 1.8);
      }
      const shown = data.current.filter((p) => WORLD_POINTS[p.code] && p.value > 0);
      const top = Math.max(1, ...shown.map((p) => p.value));
      ctx.font = '12px "Noto Sans SC", system-ui, sans-serif';
      const labels: Array<{ text: string; x: number; y: number; depth: number; value: number }> = [];
      for (const point of shown) {
        const [lon, lat] = WORLD_POINTS[point.code]!;
        const [x, y, depth] = project(onSphere(lon, lat));
        if (depth < 0.05) continue;
        const share = point.value / top,
          ring = 3 + 7 * share,
          phase = still ? 0.4 : (time / 1600 + share * 3) % 1;
        ctx.strokeStyle = `rgba(246,212,138,${(1 - phase) * 0.8 * depth})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, ring + phase * 16, 0, 7);
        ctx.stroke();
        const rise = (14 + 46 * share) * depth;
        ctx.strokeStyle = "rgba(246,212,138,.9)";
        ctx.lineWidth = 3;
        ctx.shadowColor = "#e2b04f";
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y - rise);
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.fillStyle = "#fff3d6";
        ctx.beginPath();
        ctx.arc(x, y, ring * 0.5, 0, 7);
        ctx.fill();
        if (depth > 0.35) labels.push({ text: `${point.label} ${point.value.toLocaleString("zh-CN")}`, x: x + 8, y: y - rise - 4, depth, value: point.value });
      }
      // Names for the biggest numbers first; one that would sit on another is left to the list beside the globe.
      const placed: Array<{ x: number; y: number; w: number }> = [];
      for (const item of labels.sort((p, q) => q.value - p.value)) {
        const w = ctx.measureText(item.text).width;
        if (placed.some((box) => Math.abs(box.y - item.y) < 22 && item.x < box.x + box.w + 6 && box.x < item.x + w + 6)) continue;
        placed.push({ x: item.x, y: item.y, w });
        ctx.fillStyle = `rgba(245,239,226,${Math.min(1, item.depth * 1.3)})`;
        ctx.fillText(item.text, item.x, item.y);
      }
      if (!still) {
        if (!drag) turn += 0.0028;
        frameId = requestAnimationFrame(draw);
      }
    };
    const redraw = () => {
      size();
      if (still) draw(0);
    };
    size();
    frameId = requestAnimationFrame(draw);
    void readLand().then((value) => {
      dots = value;
      if (still) draw(0);
    });
    const observer = new ResizeObserver(redraw);
    observer.observe(cv);
    const down = (event: PointerEvent) => {
      drag = { x: event.clientX, turn };
      cv.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!drag) return;
      turn = drag.turn + (event.clientX - drag.x) / Math.max(1, radius);
      if (still) draw(0);
    };
    const up = () => {
      drag = null;
    };
    cv.addEventListener("pointerdown", down);
    cv.addEventListener("pointermove", move);
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    return () => {
      stopped = true;
      cancelAnimationFrame(frameId);
      observer.disconnect();
      cv.removeEventListener("pointerdown", down);
      cv.removeEventListener("pointermove", move);
      cv.removeEventListener("pointerup", up);
      cv.removeEventListener("pointercancel", up);
    };
  }, []);
  return <canvas ref={canvas} role="img" aria-label={label} className="block h-full min-h-[300px] w-full cursor-grab touch-pan-y active:cursor-grabbing" />;
}
