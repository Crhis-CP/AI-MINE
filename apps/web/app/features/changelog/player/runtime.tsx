// The film player (TASK-0367), loaded with Three.js only when a reader presses play on a changelog poster. A dialog over
// the page: the canvas, the scene's words, and the controls (play and pause, progress, replay, close). Space plays and
// pauses, Esc closes, Tab stays inside. Closing, leaving the page or unmounting frees the engine and its WebGL context.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTr } from "../../../i18n";
import { usePeriodLabel, useSnapshotCaption } from "../blocks/format";
import { Engine } from "./engine";
import type { PlayerProps } from "./Film";
import { Overlay } from "./Overlay";
import { BUILDERS, ambient } from "./scenes";
import "./player.css";

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function PlayerDialog({ script, data, onClose }: PlayerProps) {
  const tr = useTr();
  const dialog = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const toggleButton = useRef<HTMLButtonElement>(null);
  const engine = useRef<Engine | null>(null);
  // Read through a ref: the engine is made once per film, and the language does not change while it plays.
  const period = useRef(usePeriodLabel());
  const caption = useSnapshotCaption();
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const box = stage.current!;
    const measure = () => {
      const rect = box.getBoundingClientRect();
      setSize({ w: Math.round(rect.width), h: Math.round(rect.height) });
    };
    measure();
    const sizer = new ResizeObserver(measure);
    sizer.observe(box);
    const run = new Engine({
      canvas: canvas.current!,
      overlay: overlay.current!,
      script,
      data,
      builders: BUILDERS,
      ambient,
      period: (point) => period.current(point),
      hooks: {
        scene: setIndex,
        progress: (share) => {
          if (bar.current) bar.current.style.transform = `scaleX(${share.toFixed(4)})`;
        },
        playing: setPlaying,
        end: () => setEnded(true),
      },
    });
    engine.current = run;
    run.play();
    toggleButton.current?.focus();
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      sizer.disconnect();
      run.dispose();
      engine.current = null;
      root.style.overflow = overflow;
    };
  }, [script, data]);

  // Keys are read on the document, so they still work after a press on the film itself moved focus off a control.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
      } else if (event.key === " " && !(event.target as HTMLElement | null)?.closest?.("button, a")) {
        event.preventDefault();
        engine.current?.toggle();
        setEnded(false);
      } else if (event.key === "Tab") {
        const items = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
        const first = items[0],
          last = items.at(-1);
        const inside = dialog.current?.contains(document.activeElement);
        if (!inside || (event.shiftKey && document.activeElement === first)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const scene = script.scenes[index]!;
  const seconds = Math.round(script.scenes.reduce((sum, one) => sum + one.ms, 0) / 1000);

  return createPortal(
    <div className="pl-backdrop">
      {/* A press on the dimmed page closes, as Esc does; not a stop for Tab (the close button is). */}
      <button type="button" tabIndex={-1} aria-hidden="true" className="pl-dismiss" onClick={onClose} />
      <div ref={dialog} role="dialog" aria-modal="true" tabIndex={-1} aria-label={tr("{title} · 演示", { title: tr(script.title) })} className="pl-panel">
        <p className="sr-only">{tr("动画演示，内容与页面上的分镜相同。空格键播放或暂停，Esc 关闭。")}</p>
        <div ref={stage} className="flow-screen pl-stage">
          <canvas ref={canvas} className="pl-canvas" />
          <div ref={overlay} className="pl-overlay" aria-hidden={scene.kind !== "outro"}>
            {size.w > 0 && <Overlay key={index} script={script} scene={scene} data={data} w={size.w} h={size.h} onLeave={onClose} />}
          </div>
        </div>
        <div className="pl-controls">
          <button
            ref={toggleButton}
            type="button"
            className="pl-button"
            aria-label={ended ? tr("重播") : playing ? tr("暂停") : tr("播放")}
            onClick={() => {
              if (ended) engine.current?.replay();
              else engine.current?.toggle();
              setEnded(false);
            }}
          >
            {ended ? "↻" : playing ? "❚❚" : "▶"}
          </button>
          <div
            className="pl-track"
            role="progressbar"
            aria-label={tr("播放进度")}
            aria-valuemin={0}
            aria-valuemax={script.scenes.length}
            aria-valuenow={index + 1}
            aria-valuetext={tr("第 {n} 段，共 {total} 段", { n: index + 1, total: script.scenes.length })}
          >
            <div ref={bar} className="pl-bar" />
          </div>
          <span className="pl-time">
            {caption(data.takenAt)} · {tr("约 {s} 秒", { s: seconds })}
          </span>
          <button type="button" className="pl-button pl-close" aria-label={tr("关闭")} onClick={onClose}>
            ✕
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
