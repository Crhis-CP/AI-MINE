// The film player's engine (TASK-0367), loaded only when a reader presses play. One WebGL canvas drawn with Three.js in
// CSS pixels (an orthographic camera, y down as on the page), so the HTML words laid over it line up with what is drawn.
// It plays the script's scenes in turn from one clock: pausing stops the clock and the drawing, a hidden tab or a canvas
// scrolled away pauses it too, and closing frees every geometry, material and the WebGL context itself.
import { Color, type Material, type Mesh, type Object3D, OrthographicCamera, Group, SRGBColorSpace, Scene as ThreeScene, WebGLRenderer } from "three";
import type { LiveData } from "../live/types";
import type { Scene, Script } from "./types";

export interface Palette {
  gold: Color;
  cyan: Color;
  violet: Color;
  rose: Color;
  ink: Color;
  card: Color;
  up: Color;
  down: Color;
}

export interface SceneContext {
  group: Group;
  w: number;
  h: number;
  palette: Palette;
  data: LiveData;
  /** The scene's HTML words; a scene moves its own elements (found by data-k) in step with the drawing. */
  overlay: HTMLElement;
}

/** A scene drawn at `ms` into itself (0 to its length). */
export type Drawn = (ms: number) => void;
export type Builder = (ctx: SceneContext, scene: Scene) => Drawn;

export const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
export const easeOut = (t: number) => 1 - (1 - clamp01(t)) ** 3;
/** 0 → 1 between `from` and `from + length` ms, eased. */
export const span = (ms: number, from: number, length: number) => easeOut((ms - from) / length);

/** Any CSS colour (hex, rgb, oklch, a variable's value) as the RGB the browser paints. */
function cssColor(value: string, fallback: string): Color {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new Color(fallback);
  ctx.fillStyle = fallback;
  ctx.fillStyle = value || fallback;
  ctx.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
  // The page paints in sRGB; Three.js works in linear light and converts back on output.
  return new Color().setRGB(r / 255, g / 255, b / 255, SRGBColorSpace);
}

export function readPalette(el: Element): Palette {
  const style = getComputedStyle(el);
  const v = (name: string, fallback: string) => cssColor(style.getPropertyValue(name).trim(), fallback);
  return {
    gold: v("--fs-gold", "#c2870f"),
    cyan: v("--fs-cyan", "#0891b2"),
    violet: v("--fs-violet", "#7c3aed"),
    rose: v("--fs-rose", "#e11d48"),
    ink: v("--fs-ink-soft", "#64748b"),
    card: v("--fs-card", "#ffffff"),
    up: v("--hot", "#b3402a"),
    down: v("--ok", "#2f7d4f"),
  };
}

/** Frees what a group holds: every geometry and material of its meshes, lines and points. */
export function release(root: Object3D) {
  root.traverse((node) => {
    const mesh = node as Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material as Material | Material[] | undefined;
    for (const one of Array.isArray(material) ? material : material ? [material] : []) one.dispose();
  });
  root.clear();
}

export interface EngineHooks {
  /** A new scene starts: the page shows its words. */
  scene: (index: number) => void;
  /** Elapsed share of the whole film, 0 to 1. */
  progress: (share: number) => void;
  playing: (playing: boolean) => void;
  end: () => void;
}

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  /** The element holding the current scene's words. */
  overlay: HTMLElement;
  script: Script;
  data: LiveData;
  builders: Record<Scene["kind"], Builder>;
  /** What stays behind every scene (drawn with the whole film's elapsed time). */
  ambient: (ctx: SceneContext) => Drawn;
  hooks: EngineHooks;
}

export class Engine {
  private readonly renderer: WebGLRenderer;
  private readonly camera = new OrthographicCamera(0, 1, 0, -1, -10, 10);
  private readonly world = new ThreeScene();
  private readonly ambient = new Group();
  private readonly stage = new Group();
  private readonly total: number;
  private draw: Drawn | null = null;
  private index = -1;
  private elapsed = 0;
  private last = 0;
  private frame = 0;
  private wanted = false;
  private hidden = false;
  private away = false;
  private w = 1;
  private h = 1;
  private readonly palette: Palette;
  private readonly observer: IntersectionObserver;
  private readonly sizer: ResizeObserver;
  private readonly onVisibility = () => {
    this.hidden = document.visibilityState === "hidden";
    this.sync();
  };

  private readonly canvas: HTMLCanvasElement;
  private readonly overlay: HTMLElement;
  private readonly script: Script;
  private readonly data: LiveData;
  private readonly builders: EngineOptions["builders"];
  private readonly ambientBuilder: EngineOptions["ambient"];
  private readonly hooks: EngineHooks;

  constructor(options: EngineOptions) {
    const { canvas, script } = options;
    this.canvas = canvas;
    this.overlay = options.overlay;
    this.script = script;
    this.data = options.data;
    this.builders = options.builders;
    this.ambientBuilder = options.ambient;
    this.hooks = options.hooks;
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.palette = readPalette(canvas);
    this.world.add(this.ambient, this.stage);
    this.total = script.scenes.reduce((sum, scene) => sum + scene.ms, 0);
    this.observer = new IntersectionObserver(([entry]) => {
      this.away = !entry?.isIntersecting;
      this.sync();
    });
    this.observer.observe(canvas);
    this.sizer = new ResizeObserver(() => this.resize());
    this.sizer.observe(canvas.parentElement ?? canvas);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.resize();
  }

  private ambientDraw: Drawn | null = null;

  private context(group: Group): SceneContext {
    return { group, w: this.w, h: this.h, palette: this.palette, data: this.data, overlay: this.overlay };
  }

  /** Builds the scene at `index` again (a new scene, or the same one at a new size). */
  private build(index: number) {
    release(this.stage);
    const scene = this.script.scenes[index]!;
    this.draw = this.builders[scene.kind](this.context(this.stage), scene);
    if (index !== this.index) {
      this.index = index;
      this.hooks.scene(index);
    }
  }

  private resize() {
    const box = (this.canvas.parentElement ?? this.canvas).getBoundingClientRect();
    this.w = Math.max(1, Math.round(box.width));
    this.h = Math.max(1, Math.round(box.height));
    this.renderer.setSize(this.w, this.h, false);
    Object.assign(this.camera, { left: 0, right: this.w, top: 0, bottom: -this.h });
    this.camera.updateProjectionMatrix();
    release(this.ambient);
    this.ambientDraw = this.ambientBuilder(this.context(this.ambient));
    if (this.index >= 0) this.build(this.index);
    this.render();
  }

  /** Which scene the clock is in, and how far into it. */
  private locate(): [number, number] {
    let start = 0;
    for (const [i, scene] of this.script.scenes.entries()) {
      if (this.elapsed < start + scene.ms || i === this.script.scenes.length - 1) return [i, Math.min(scene.ms, this.elapsed - start)];
      start += scene.ms;
    }
    return [0, 0];
  }

  private render() {
    const [index, ms] = this.locate();
    if (index !== this.index) this.build(index);
    this.ambientDraw?.(this.elapsed);
    this.draw?.(ms);
    this.renderer.render(this.world, this.camera);
    this.hooks.progress(this.total ? this.elapsed / this.total : 1);
  }

  private readonly tick = (now: number) => {
    this.frame = 0;
    // A long gap (a stalled frame) moves the film on by one frame's worth, not by the gap.
    this.elapsed = Math.min(this.total, this.elapsed + Math.min(now - this.last, 64));
    this.last = now;
    this.render();
    if (this.elapsed >= this.total) {
      this.wanted = false;
      this.hooks.playing(false);
      this.hooks.end();
      return;
    }
    this.frame = requestAnimationFrame(this.tick);
  };

  /** Runs the clock only while the reader wants it, the tab is shown and the canvas is on screen. */
  private sync() {
    const run = this.wanted && !this.hidden && !this.away;
    if (run && !this.frame) {
      this.last = performance.now();
      this.frame = requestAnimationFrame(this.tick);
    } else if (!run && this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
  }

  play() {
    if (this.elapsed >= this.total) this.elapsed = 0;
    this.wanted = true;
    this.hooks.playing(true);
    this.sync();
  }

  pause() {
    this.wanted = false;
    this.hooks.playing(false);
    this.sync();
  }

  toggle() {
    if (this.wanted) this.pause();
    else this.play();
  }

  replay() {
    this.elapsed = 0;
    this.play();
  }

  dispose() {
    this.wanted = false;
    this.sync();
    this.observer.disconnect();
    this.sizer.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibility);
    release(this.world);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
