// The about page's moving picture of the six steps (TASK-0654), drawn on one canvas beside the stage list that the
// server already rendered. Reports leave the source dots coloured by language, pass the AI screen (off-topic ones
// fall away), gather into events, get a five-axis shape against the 精选线, turn into articles and
// fan out to the outputs (精选, 日报, 热点榜, 全部; regulation documents run in their own lane to 法规). Left to
// right when the stage heads stand in a row, top to bottom beside the stage cards otherwise.
// The only figures it draws are the real source counts it is given and the two ends of the score scale (0 and 100);
// the stream itself is an illustration and carries no numbers. Reduced
// motion draws one still frame. The loop stops off screen and in hidden tabs; `destroy` removes everything.
import { watchAppearance } from "../../lib/local-state";
import { reducedMotion } from "../../lib/motion";

export interface PipelineLabels {
  /** "442 个资讯来源", drawn over the source dots (desktop). */
  sources: string;
  regulationSources: string;
  regulationLane: string;
  line: string;
}

export interface PipelineOptions {
  flow: HTMLElement;
  wrap: HTMLElement;
  canvas: HTMLCanvasElement;
  stagesList: HTMLElement;
  stages: HTMLElement[];
  docks: HTMLElement[];
  /** Sources in use (SiteStats.sources): one dot each, as many as the space holds. */
  sources: number;
  labels: PipelineLabels;
  onHover: (stage: number | null) => void;
  onTap: (stage: number) => void;
  /** A selected article reached 精选. */
  onArrive?: () => void;
}

export interface PipelineHandle {
  setActive(stage: number | null): void;
  setSources(count: number, labels: PipelineLabels): void;
  destroy(): void;
}

/** True when the stage heads stand in a row (the wide layout); the stylesheet decides, this reads it. */
export const flowsAcross = (stagesList: HTMLElement): boolean => getComputedStyle(stagesList).display === "grid";

type RGBA = [number, number, number, number];
type Pt = [number, number];
type Box = [number, number, number, number];

const TAU = Math.PI * 2;
const clamp = (x: number, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => {
  const u = clamp(t);
  return u * u * (3 - 2 * u);
};
const ease = (t: number) => {
  const u = clamp(t);
  return u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
};
const easeOut = (t: number) => 1 - (1 - clamp(t)) ** 3;
function prng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Language mix of the dots (中文, English, Español, Português, other): an illustration, never shown as numbers. */
const MIX = [0.34, 0.53, 0.09, 0.01, 0.03];
/** How often each language appears in the stream: flatter than the mix, so small languages show. */
const EMIT = [0.31, 0.42, 0.15, 0.05, 0.07];
/** Weights of 份量, 新信息, 证据, 影响面, 可用性 per content type (rows add up to 10, industry/selection.ts). */
const WEIGHTS = [
  [3, 1, 1, 3, 2],
  [3, 2, 1, 3, 1],
  [4, 3, 1, 2, 0],
  [3, 1, 1, 4, 1],
  [3, 2, 1, 2, 2],
  [4, 1, 1, 4, 0],
  [1, 3, 1, 4, 1],
];
/** Where the 精选线 sits on the drawn score axis (the real line depends on the source). */
const LINE = 65;
const cnOfScore = (s: number) => 0.9 - (1.8 * s) / 100;
const CN_LINE = cnOfScore(LINE);
// Positions along the flow are in stage units: stage k spans [k, k + 1).
const GATE_U = 1.5;
const MERGE0 = 2;
const MERGE1 = 2.72;
const DELAY = 0.42;
const DROP_LIFE = 1.7;
/** Docks across the flow: 精选, 日报, 热点榜, 全部 (法规 has its own lane). */
const DOCK_CN = [-0.74, -0.44, 0.02, 0.42];
const GUIDE_CN = [-0.6, -0.52, 0.08, 0.3];
/** Speed by stage: reports settle a little while they are merged, scored and written. */
const PACE = [1, 1, 0.88, 0.78, 0.78, 0.9];
const FONT_MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace';

interface Params {
  speed: number;
  ev: Pt;
  nz: Pt;
  rg: Pt;
  art: number;
  node: number;
  nodeK: number;
  card: Pt;
  penta: number;
  font: number;
  pitch: number;
  fall: number;
  spread: number;
  trail: number;
  gold: Pt;
}
const ACROSS: Params = {
  speed: 60,
  ev: [0.6, 0.86],
  nz: [0.42, 0.62],
  rg: [2.8, 4.2],
  art: 2,
  node: 3.3,
  nodeK: 1.25,
  card: [15, 19],
  penta: 15,
  font: 11,
  pitch: 6,
  fall: 30,
  spread: 0.36,
  trail: 26,
  gold: [3.4, 5],
};
const DOWN: Params = {
  speed: 34,
  ev: [0.7, 0.95],
  nz: [0.4, 0.6],
  rg: [3.6, 5.2],
  art: 1.7,
  node: 2.6,
  nodeK: 0.95,
  card: [11.5, 14.5],
  penta: 10,
  font: 10,
  pitch: 3.2,
  fall: 20,
  spread: 0.3,
  trail: 15,
  gold: [4.2, 6],
};

interface Colors {
  dark: boolean;
  bg: RGBA;
  surface: RGBA;
  ink: RGBA;
  ink3: RGBA;
  ink4: RGBA;
  line: RGBA;
  lineStrong: RGBA;
  accent: RGBA;
  lang: RGBA[];
}

interface Layout {
  h: boolean;
  W: number;
  H: number;
  /** Stage starts along the flow, then where the outputs begin. */
  B: number[];
  anchors: Pt[];
  cTop: number;
  cBot: number;
  cSep: number;
  cReg: number;
  cMid: number;
  cHalf: number;
  riverW: number;
  fanPx: number;
  fanU: number;
  /** The source dots: along the flow (f), across it (c), and as flow units. */
  dots: { U: number; cn: number; f: number; c: number; lang: number }[];
  byLang: number[][];
  dotsEnd: number;
  dotsTop: number;
  regF: number;
  regU: number;
  boxes: Box[];
}

interface Wobble {
  wa: number;
  wf: number;
  wp: number;
}
interface Article extends Wobble {
  lang: number;
  dot: number;
  off: number;
  delay: number;
  U: number;
  Ma: number;
  emitted: boolean;
  gated: boolean;
  flashT: number;
  absorbed: boolean;
}
interface FlowEvent {
  arts: Article[];
  gold: boolean;
  hot: boolean;
  axes: number[];
  score: number;
  U: number;
  lane: number;
  count: number;
  popT: number;
  fanned: boolean;
  cnScore: number;
  goldAt: number | null;
}
interface Noise extends Wobble {
  lang: number;
  dot: number;
  U: number;
  emitted: boolean;
  dropped: boolean;
  dropT: number;
}
interface Reg {
  lang: number;
  U: number;
  fanned: boolean;
}
interface Copy {
  U0: number;
  cn0: number;
  reg: boolean;
  dock: number;
  t0: number;
  dur: number;
  gold: boolean;
  lang: number;
  done: boolean;
}
interface Sim {
  r: () => number;
  t: number;
  live: boolean;
  events: FlowEvent[];
  noise: Noise[];
  regs: Reg[];
  copies: Copy[];
  ripples: { dock: number; t0: number; gold: boolean }[];
  glow: Float32Array;
  nextEv: number;
  nextNz: number;
  nextRg: number;
  nextGold: number;
  lanes: number[];
}

function parseColor(css: string, fallback: RGBA): RGBA {
  const s = css.trim();
  if (s.startsWith("#")) {
    let h = s.slice(1);
    if (h.length === 3)
      h = h
        .split("")
        .map((c) => c + c)
        .join("");
    return [Number.parseInt(h.slice(0, 2), 16), Number.parseInt(h.slice(2, 4), 16), Number.parseInt(h.slice(4, 6), 16), 1];
  }
  const m = s.match(/[\d.]+/g);
  if (!m || m.length < 3) return fallback;
  return [Number(m[0]), Number(m[1]), Number(m[2]), m[3] === undefined ? 1 : Number(m[3])];
}
const rgba = (c: RGBA, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${clamp(a * c[3]).toFixed(3)})`;
const mix = (a: RGBA, b: RGBA, k: number): RGBA => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k), lerp(a[3], b[3], k)];

function readColors(): Colors {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const dark = root.getAttribute("data-theme") === "dark";
  const g = (name: string, fallback: RGBA) => parseColor(cs.getPropertyValue(name), fallback);
  return {
    dark,
    bg: g("--bg", [249, 246, 240, 1]),
    surface: g(dark ? "--raised" : "--surface", [255, 255, 255, 1]),
    ink: g("--ink", [34, 30, 25, 1]),
    ink3: g("--ink-3", [95, 88, 78, 1]),
    ink4: g("--ink-4", [107, 100, 89, 1]),
    line: g("--line", [227, 221, 209, 1]),
    lineStrong: g("--line-strong", [214, 207, 193, 1]),
    accent: g("--accent", [138, 90, 23, 1]),
    lang: ["--lang-zh", "--lang-en", "--lang-es", "--lang-pt", "--lang-other"].map((name) => g(name, [135, 127, 114, 1])),
  };
}

function pick<T>(list: readonly T[], r: () => number): T {
  return list[Math.floor(r() * list.length)] as T;
}
function pickLang(r: () => number): number {
  let x = r();
  for (let i = 0; i < 4; i++) {
    x -= EMIT[i] as number;
    if (x < 0) return i;
  }
  return 4;
}
function pickN(r: () => number): number {
  const x = r();
  return x < 0.16 ? 1 : x < 0.38 ? 2 : x < 0.58 ? 3 : x < 0.73 ? 4 : x < 0.84 ? 5 : x < 0.91 ? 6 : x < 0.96 ? 7 : 8;
}
function makeScore(r: () => number, gold: boolean): { axes: number[]; score: number } {
  const w = pick(WEIGHTS, r);
  for (let k = 0; k < 40; k++) {
    const target = gold ? 72 + r() * 18 : r() < 0.2 ? 50 + r() * 9 : 20 + r() * 32;
    const axes = w.map(() => clamp(target / 10 + (r() * 2 - 1) * 2, 0.6, 9.8));
    const s = axes.reduce((a, v, i) => a + v * (w[i] as number), 0);
    if (gold ? s >= 70 && s <= 93 : s >= 16 && s <= 60) return { axes, score: Math.round(s) };
  }
  return gold ? { axes: [7.6, 7.6, 7.6, 7.6, 7.6], score: 76 } : { axes: [4.2, 4.2, 4.2, 4.2, 4.2], score: 42 };
}
const wobble = (r: () => number): Wobble => ({ wa: 0.012 + r() * 0.03, wf: 0.6 + r() * 1.4, wp: r() * TAU });

function line(c: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  c.beginPath();
  c.moveTo(x0, y0);
  c.lineTo(x1, y1);
  c.stroke();
}
function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
}
function bez(q: Pt[], e: number): Pt {
  const u = 1 - e;
  const k = [u * u * u, 3 * u * u * e, 3 * u * e * e, e * e * e];
  let x = 0;
  let y = 0;
  q.forEach((p, i) => {
    x += (k[i] as number) * p[0];
    y += (k[i] as number) * p[1];
  });
  return [x, y];
}

export function mountPipeline(o: PipelineOptions): PipelineHandle {
  const { flow, wrap, canvas, stagesList, stages, docks } = o;
  const ctx = canvas.getContext("2d");
  const layer = document.createElement("canvas");
  const lctx = layer.getContext("2d");
  if (!ctx || !lctx) return { setActive() {}, setSources() {}, destroy() {} };
  const font = () => getComputedStyle(document.body).fontFamily || "system-ui, sans-serif";

  let sources = Math.max(0, o.sources);
  let labels = o.labels;
  let L: Layout | null = null;
  let P = ACROSS;
  let C = readColors();
  let S: Sim | null = null;
  let dpr = 1;
  let still = reducedMotion();
  let active: number | null = null;
  const dim = [0, 0, 0, 0, 0, 0];
  const dimT = [0, 0, 0, 0, 0, 0];
  let revealAt: number | null = null;
  let raf = 0;
  let last = 0;
  let inView = true;
  let disposed = false;
  const timers = new Set<number>();

  /* ---------- layout ---------- */
  const lay = (): Layout => L as Layout;
  function flowPx(U: number): number {
    const B = lay().B;
    if (U < 0) return (B[0] as number) + U * ((B[1] as number) - (B[0] as number));
    if (U >= 6) return (B[6] as number) + (U - 6) * ((B[6] as number) - (B[5] as number));
    const k = Math.floor(U);
    return (B[k] as number) + (U - k) * ((B[k + 1] as number) - (B[k] as number));
  }
  const bandLen = (U: number) => {
    const k = U < 0 ? 0 : U >= 6 ? 5 : Math.floor(U);
    return Math.max(24, (lay().B[k + 1] as number) - (lay().B[k] as number));
  };
  const pace = (U: number) => {
    const x = clamp(U - 0.5, 0, 5);
    const k = Math.min(4, Math.floor(x));
    return lerp(PACE[k] as number, PACE[k + 1] as number, smooth(x - k));
  };
  const du = (U: number, v: number, dt: number) => (dt * v * pace(U)) / bandLen(U);
  const crossPx = (cn: number) => lay().cMid + cn * lay().cHalf;
  const at = (f: number, c: number): Pt => (lay().h ? [f, c] : [c, f]);
  const pt = (U: number, cn: number) => at(flowPx(U), crossPx(cn));
  const ptc = (U: number, c: number) => at(flowPx(U), c);

  function measure() {
    const h = flowsAcross(stagesList);
    P = h ? ACROSS : DOWN;
    const wr = wrap.getBoundingClientRect();
    const W = wr.width;
    const H = wr.height;
    const B: number[] = [];
    let riverW = W;
    let cTop: number;
    let cBot: number;
    let cSep: number;
    let cReg: number;
    let docksTop = H;
    if (h) {
      for (const li of stages) B.push(Math.round(li.getBoundingClientRect().left - wr.left));
      B.push(W - Math.max(...docks.map((d) => d.offsetWidth)) - 20);
      cTop = 38;
      cBot = H - 96;
      cSep = H - 66;
      cReg = H - 38;
    } else {
      for (const li of stages) B.push(Math.round(li.getBoundingClientRect().top - wr.top));
      riverW = Math.round(stagesList.getBoundingClientRect().left - wr.left - (Number.parseFloat(getComputedStyle(flow).columnGap) || 12));
      for (const d of docks) {
        d.style.left = "";
        d.style.top = "";
      }
      docksTop = Math.min(...docks.map((d) => d.getBoundingClientRect().top - wr.top));
      B.push(docksTop - 10);
      cTop = 6;
      cBot = riverW - 26;
      cSep = riverW - 17;
      cReg = riverW - 8;
    }
    const cMid = (cTop + cBot) / 2;
    const cHalf = (cBot - cTop) / 2;
    const B5 = B[5] as number;
    const B6 = B[6] as number;
    const fanPx = h ? B5 + 22 : Math.max(B5 + 0.3 * (B6 - B5), docksTop - 118);
    const next: Layout = {
      h,
      W,
      H,
      B,
      anchors: [],
      cTop,
      cBot,
      cSep,
      cReg,
      cMid,
      cHalf,
      riverW,
      fanPx,
      fanU: 5 + (fanPx - B5) / Math.max(1, B6 - B5),
      dots: [],
      byLang: [[], [], [], [], []],
      dotsEnd: 0,
      dotsTop: 0,
      regF: 0,
      regU: 0,
      boxes: [],
    };
    L = next;
    // Output docks: a column at the right on the wide layout, a row under the river on the narrow one.
    docks.forEach((el, k) => {
      if (h) {
        const y = k === 4 ? cReg : crossPx(DOCK_CN[k] as number);
        el.style.top = `${Math.round(y - el.offsetHeight / 2)}px`;
        el.style.left = `${Math.round(W - el.offsetWidth)}px`;
        next.anchors[k] = [W - el.offsetWidth - 6, y];
      } else {
        const r = el.getBoundingClientRect();
        next.anchors[k] = [r.left - wr.left + r.width / 2, r.top - wr.top - 6];
      }
    });
    // Source dots: one per source in use while they fit, languages stacked across the river.
    const p = P.pitch;
    const B0 = B[0] as number;
    const len0 = (B[1] as number) - B0;
    const acrossMax = Math.floor((cBot - cTop) / p) + 1;
    const alongMax = Math.max(1, Math.floor((len0 * (h ? 0.42 : 0.5)) / p));
    const n = Math.min(sources, acrossMax * alongMax);
    let nf: number;
    let nc: number;
    if (h) {
      nf = Math.min(alongMax, Math.max(1, Math.ceil(n / acrossMax)));
      nc = Math.ceil(n / nf);
    } else {
      nc = Math.min(acrossMax, Math.max(1, n));
      nf = Math.ceil(n / nc);
    }
    const f0 = B0 + 8;
    const c0 = cMid - ((nc - 1) * p) / 2;
    let edge = 0;
    for (let i = 0; i < n; i++) {
      const share = i / Math.max(1, n);
      let lang = 0;
      for (let acc = MIX[0] as number; lang < 4 && share >= acc; lang++) acc += MIX[lang + 1] as number;
      const f = f0 + (i % nf) * p;
      const c = c0 + Math.floor(i / nf) * p;
      next.dots.push({ U: (f - B0) / len0, cn: (c - cMid) / cHalf, f, c, lang });
      next.byLang[lang]?.push(i);
      edge = Math.max(edge, f);
    }
    next.dotsEnd = edge;
    next.dotsTop = c0;
    next.regF = f0;
    next.regU = (f0 - B0) / len0;
    // On phones the river grows while a card opens, so the backing store keeps headroom.
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const needW = Math.round(W * dpr);
    const needH = Math.ceil(H * dpr);
    if (canvas.width !== needW || canvas.height < needH || canvas.height > needH + 1000 * dpr) {
      const alloc = h ? needH : needH + Math.round(420 * dpr);
      for (const c of [canvas, layer]) {
        c.width = needW;
        c.height = alloc;
      }
      canvas.style.height = `${alloc / dpr}px`;
    }
  }

  /* ---------- simulation ---------- */
  const newSim = (): Sim => ({
    r: prng(20261113),
    t: 0,
    live: false,
    events: [],
    noise: [],
    regs: [],
    copies: [],
    ripples: [],
    glow: new Float32Array(Math.max(1, lay().dots.length)).fill(-99),
    nextEv: 0,
    nextNz: 0.35,
    nextRg: 0.8,
    nextGold: 1.5,
    lanes: [],
  });
  /** A dot of the language, or any dot (with its own language) when that language has none. */
  function dotOf(r: () => number): { dot: number; lang: number } {
    const lang = pickLang(r);
    const list = lay().byLang[lang] ?? [];
    if (list.length) return { dot: pick(list, r), lang };
    const dot = Math.floor(r() * lay().dots.length);
    return { dot, lang: lay().dots[dot]?.lang ?? 0 };
  }
  const dotU = (dot: number) => lay().dots[dot]?.U ?? 0;
  const dotCn = (dot: number) => lay().dots[dot]?.cn ?? 0;

  function spawnEvent(s: Sim) {
    const r = s.r;
    // A selected event comes along every few seconds; otherwise selection is rare.
    const gold = s.t >= s.nextGold || r() < 0.03;
    if (s.t >= s.nextGold) s.nextGold = s.t + lerp(P.gold[0], P.gold[1], r());
    const n = gold ? Math.max(2, pickN(r) + 1) : pickN(r);
    const { axes, score } = makeScore(r, gold);
    const arts: Article[] = [];
    let first = Number.POSITIVE_INFINITY;
    let mean = 0;
    for (let i = 0; i < n; i++) {
      const { dot, lang } = dotOf(r);
      const a: Article = {
        lang,
        dot,
        off: (r() * 2 - 1) * P.spread,
        delay: r() * DELAY,
        U: -9,
        Ma: 0,
        emitted: false,
        gated: false,
        flashT: -99,
        absorbed: false,
        ...wobble(r),
      };
      arts.push(a);
      first = Math.min(first, dotU(dot) - a.off);
      mean += dotCn(dot) / n;
    }
    let lane = lerp(mean, r() * 1.5 - 0.75, 0.55);
    for (const l of s.lanes) if (Math.abs(lane - l) < 0.26) lane += lane >= l ? 0.26 : -0.26;
    lane = clamp(lane, -0.8, 0.8);
    s.lanes.unshift(lane);
    s.lanes.length = Math.min(s.lanes.length, 3);
    s.events.push({
      arts,
      gold,
      hot: n >= 4,
      axes,
      score,
      U: Math.min(-0.42, first - 0.002),
      lane,
      count: 0,
      popT: -99,
      fanned: false,
      cnScore: cnOfScore(score),
      goldAt: null,
    });
  }
  function copyTo(s: Sim, from: { U: number; cn: number; reg: boolean }, dock: number, extra: { gold: boolean; lang: number; delay: number }) {
    const p0 = from.reg ? ptc(from.U, lay().cReg) : pt(from.U, from.cn);
    const p3 = lay().anchors[dock] ?? p0;
    const dist = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
    s.copies.push({
      U0: from.U,
      cn0: from.cn,
      reg: from.reg,
      dock,
      t0: s.t + extra.delay,
      dur: 1.15 + dist / 240,
      gold: extra.gold,
      lang: extra.lang,
      done: false,
    });
  }
  function flashDock(k: number) {
    if (k === 3) return; // 全部 takes every event; the ripple is enough
    const el = docks[k];
    if (!el) return;
    el.classList.add("is-hit");
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      el.classList.remove("is-hit");
    }, 520);
    timers.add(timer);
  }

  function step(s: Sim, dt: number) {
    s.t += dt;
    const t = s.t;
    const r = s.r;
    const v = P.speed;
    if (lay().dots.length) {
      if (t >= s.nextEv) {
        spawnEvent(s);
        s.nextEv = t + lerp(P.ev[0], P.ev[1], r());
      }
      if (t >= s.nextNz) {
        const { dot, lang } = dotOf(r);
        s.noise.push({ lang, dot, U: dotU(dot) - 0.002, emitted: false, dropped: false, dropT: 0, ...wobble(r) });
        s.nextNz = t + lerp(P.nz[0], P.nz[1], r());
      }
    }
    if (t >= s.nextRg) {
      s.regs.push({ lang: pickLang(r), U: lay().regU - 0.002, fanned: false });
      s.nextRg = t + lerp(P.rg[0], P.rg[1], r());
    }
    for (const ev of s.events) {
      ev.U += du(ev.U, v, dt);
      const M = clamp((ev.U - MERGE0) / (MERGE1 - MERGE0));
      for (const a of ev.arts) {
        if (a.absorbed) continue;
        a.Ma = ease((M - a.delay) / (1 - DELAY));
        a.U = ev.U + a.off * (1 - a.Ma);
        if (!a.emitted && a.U >= dotU(a.dot)) {
          a.emitted = true;
          s.glow[a.dot] = t;
        }
        if (!a.gated && a.U >= GATE_U) {
          a.gated = true;
          a.flashT = t;
        }
        if (a.Ma >= 1) {
          a.absorbed = true;
          ev.count++;
          ev.popT = t;
        }
      }
      if (ev.gold && ev.goldAt === null && ev.U >= 3.64) ev.goldAt = t; // it has just crossed the 精选线
      if (!ev.fanned && ev.U >= lay().fanU) {
        ev.fanned = true;
        const targets = ev.gold ? [0, 1, 3] : [3];
        if (ev.hot) targets.splice(targets.length - 1, 0, 2);
        for (const [i, k] of targets.entries()) copyTo(s, { U: ev.U, cn: ev.cnScore, reg: false }, k, { gold: ev.gold, lang: 0, delay: i * 0.07 });
      }
    }
    s.events = s.events.filter((e) => !e.fanned);
    for (const z of s.noise) {
      if (!z.dropped) {
        z.U += du(z.U, v, dt);
        if (!z.emitted && z.U >= dotU(z.dot)) {
          z.emitted = true;
          s.glow[z.dot] = t;
        }
        if (z.U >= GATE_U) {
          z.dropped = true;
          z.dropT = t;
        }
      } else z.U += (dt * v * Math.exp(-2.6 * (t - z.dropT))) / bandLen(z.U);
    }
    s.noise = s.noise.filter((z) => !z.dropped || t - z.dropT < DROP_LIFE);
    for (const g of s.regs) {
      g.U += du(g.U, v * 0.92, dt);
      if (!g.fanned && g.U >= lay().fanU) {
        g.fanned = true;
        copyTo(s, { U: g.U, cn: 0, reg: true }, 4, { gold: false, lang: g.lang, delay: 0 });
      }
    }
    s.regs = s.regs.filter((g) => !g.fanned);
    for (const c of s.copies) {
      if (t < c.t0 + c.dur) continue;
      c.done = true;
      s.ripples.push({ dock: c.dock, t0: t, gold: c.gold });
      if (s.live) {
        flashDock(c.dock);
        if (c.dock === 0) o.onArrive?.();
      }
    }
    s.copies = s.copies.filter((c) => !c.done);
    s.ripples = s.ripples.filter((p) => t - p.t0 < 0.9);
  }

  /* ---------- drawing ---------- */
  function curve(p0: Pt, p3: Pt): Pt[] {
    const dir: Pt = lay().h ? [1, 0] : [0, 1];
    const along = Math.abs((p3[0] - p0[0]) * dir[0] + (p3[1] - p0[1]) * dir[1]);
    const k = Math.max(18, along * 0.6);
    return [p0, [p0[0] + dir[0] * k, p0[1] + dir[1] * k], [p3[0] - dir[0] * k * 0.75, p3[1] - dir[1] * k * 0.75], p3];
  }
  function textLabel(
    c: CanvasRenderingContext2D,
    s: string,
    x: number,
    y: number,
    color: string,
    size: number,
    mono: boolean,
    align: CanvasTextAlign,
    boxes?: Box[],
  ) {
    c.font = `600 ${size}px ${mono ? FONT_MONO : font()}`;
    c.textAlign = align;
    c.textBaseline = "alphabetic";
    if (boxes) {
      const w = c.measureText(s).width;
      const x0 = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
      boxes.push([x0 - 3, y - size - 1, x0 + w + 3, y + 4]);
    }
    // A soft halo in the page colour keeps labels readable over the stream.
    c.lineWidth = 3;
    c.strokeStyle = rgba(C.bg, 0.85);
    c.lineJoin = "round";
    c.strokeText(s, x, y);
    c.fillStyle = color;
    c.fillText(s, x, y);
  }

  /** The fixed parts: stage rules, the screen, the 精选线, the source dots and the channels to the outputs. */
  function drawLayer() {
    const c = lctx as CanvasRenderingContext2D;
    const l = lay();
    const boxes: Box[] = [];
    l.boxes = boxes;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, layer.width / dpr, layer.height / dpr);
    c.lineWidth = 1;
    c.save();
    if (l.h) {
      c.setLineDash([1, 4]);
      c.strokeStyle = rgba(C.lineStrong);
      for (let k = 1; k <= 5; k++) line(c, (l.B[k] as number) + 0.5, 0, (l.B[k] as number) + 0.5, l.H);
    } else {
      c.strokeStyle = rgba(C.line);
      for (let k = 1; k <= 5; k++) line(c, 0, (l.B[k] as number) + 0.5, l.riverW + 14, (l.B[k] as number) + 0.5);
    }
    c.restore();
    // The regulation lane runs apart from the news.
    c.save();
    c.setLineDash([2, 4]);
    c.strokeStyle = rgba(C.lineStrong);
    const s0 = l.regF + 12;
    if (l.h) line(c, s0, l.cSep + 0.5, l.fanPx, l.cSep + 0.5);
    else line(c, l.cSep + 0.5, s0, l.cSep + 0.5, l.fanPx);
    c.restore();
    const [rx0, ry0] = at(l.regF, l.cReg);
    c.strokeStyle = rgba(C.ink3, 0.75);
    c.strokeRect(rx0 - 3.5, ry0 - 3.5, 7, 7);
    if (l.h) {
      textLabel(c, labels.regulationSources, l.regF - 4, l.cReg + 20, rgba(C.ink4), 10.5, false, "left", boxes);
      textLabel(c, labels.regulationLane, (l.B[2] as number) + 16, l.cSep + 16, rgba(C.ink4), 10.5, false, "left", boxes);
    }
    // The screen, with a small "AI" mark on the wide layout.
    const g = Math.round(flowPx(GATE_U));
    c.save();
    c.setLineDash([2, 3]);
    c.strokeStyle = rgba(C.ink4, 0.6);
    if (l.h) line(c, g + 0.5, l.cTop - 10, g + 0.5, l.cBot + 10);
    else line(c, l.cTop - 2, g + 0.5, l.cBot + 4, g + 0.5);
    c.restore();
    if (l.h) {
      const w = 24;
      const hh = 15;
      const x = g - w / 2;
      const y = l.cTop - 30;
      boxes.push([x - 2, y - 2, x + w + 2, y + hh + 2]);
      c.save();
      roundRect(c, x, y, w, hh, 7.5);
      c.fillStyle = rgba(C.bg);
      c.fill();
      c.strokeStyle = rgba(C.ink4, 0.7);
      c.stroke();
      c.font = `600 9.5px ${FONT_MONO}`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillStyle = rgba(C.ink3);
      c.fillText("AI", g, y + hh / 2 + 0.5);
      c.restore();
    }
    // The 精选线; on the wide layout a score ruler stands at the start of the scoring stage.
    const th = Math.round(crossPx(CN_LINE));
    const rx = (l.B[3] as number) + 30.5;
    c.fillStyle = rgba(C.accent, C.dark ? 0.045 : 0.04);
    if (l.h) c.fillRect(rx, l.cTop - 10, l.fanPx - rx, th - l.cTop + 10);
    else c.fillRect(l.cTop - 4, (l.B[3] as number) + 1, th - l.cTop + 4, l.fanPx - (l.B[3] as number) - 1);
    c.save();
    c.setLineDash([4, 4]);
    c.strokeStyle = rgba(C.accent, C.dark ? 0.62 : 0.6);
    if (l.h) line(c, rx, th + 0.5, l.fanPx - 4, th + 0.5);
    else line(c, th + 0.5, (l.B[3] as number) + 2, th + 0.5, l.fanPx - 4);
    c.restore();
    if (l.h) {
      const y100 = crossPx(cnOfScore(100));
      const y0 = crossPx(cnOfScore(0));
      c.strokeStyle = rgba(C.ink4, C.dark ? 0.5 : 0.45);
      line(c, rx, y100, rx, y0);
      for (let s = 0; s <= 100; s += 10) {
        const y = Math.round(crossPx(cnOfScore(s))) + 0.5;
        line(c, rx - (s % 50 ? 3 : 6), y, rx, y);
      }
      textLabel(c, "100", rx - 9, y100 + 3.5, rgba(C.ink4), 9.5, true, "right", boxes);
      textLabel(c, "0", rx - 9, y0 + 3.5, rgba(C.ink4), 9.5, true, "right", boxes);
      textLabel(c, labels.line, Math.min(l.fanPx, l.B[5] as number) - 8, th - 7, rgba(C.accent), 11, false, "right", boxes);
    } else {
      // Left of the line when it fits there ("精选线"), otherwise right of it (a longer English label).
      c.font = `600 10px ${font()}`;
      const fits = c.measureText(labels.line).width <= th - 8;
      textLabel(c, labels.line, fits ? th - 4 : th + 4, (l.B[3] as number) + 14, rgba(C.accent), 10, false, fits ? "right" : "left", boxes);
    }
    // Channels to the outputs.
    for (let k = 0; k < 5; k++) {
      const p0 = k === 4 ? ptc(l.fanU, l.cReg) : pt(l.fanU, GUIDE_CN[k] as number);
      const q = curve(p0, l.anchors[k] ?? p0);
      const [a, b, cc, d] = q as [Pt, Pt, Pt, Pt];
      c.beginPath();
      c.moveTo(a[0], a[1]);
      c.bezierCurveTo(b[0], b[1], cc[0], cc[1], d[0], d[1]);
      c.strokeStyle = k < 2 ? rgba(C.accent, C.dark ? 0.2 : 0.22) : rgba(C.ink, 0.1);
      c.lineWidth = 1;
      c.stroke();
    }
    // Source dots.
    for (const d of l.dots) {
      const [x, y] = at(d.f, d.c);
      c.beginPath();
      c.arc(x, y, P.pitch * (l.h ? 0.27 : 0.32), 0, TAU);
      c.fillStyle = rgba(C.lang[d.lang] as RGBA, C.dark ? 0.5 : 0.55);
      c.fill();
    }
    if (l.h && l.dots.length) textLabel(c, labels.sources, (l.B[0] as number) + 6, l.dotsTop - 12, rgba(C.ink4), 10.5, false, "left", boxes);
  }

  const nodeCn = (ev: FlowEvent) => lerp(ev.lane, ev.cnScore, ease((clamp(ev.U - 3) - 0.3) / 0.42));

  function drawShape(c: CanvasRenderingContext2D, x: number, y: number, r: number, morph: number, goldK: number, scale: number, alpha: number) {
    const w = lerp(2 * r, P.card[0] * scale, morph);
    const h = lerp(2 * r, P.card[1] * scale, morph);
    c.save();
    c.globalAlpha = alpha;
    if (goldK > 0) {
      c.shadowColor = `rgba(226,176,79,${(C.dark ? 0.65 : 0.4) * goldK})`;
      c.shadowBlur = (C.dark ? 14 : 9) * goldK;
    }
    roundRect(c, x - w / 2, y - h / 2, w, h, lerp(r, 2.4 * scale, morph));
    c.fillStyle = rgba(C.surface);
    c.fill();
    c.shadowBlur = 0;
    c.shadowColor = "transparent";
    const gk = goldK * (1 - morph);
    if (gk > 0.01) {
      // The selected node is a gold nugget (the brand gradient); the article it becomes keeps a gold edge.
      const grad = c.createLinearGradient(0, y - h / 2, 0, y + h / 2);
      grad.addColorStop(0, "#fff3d6");
      grad.addColorStop(0.6, "#e2b04f");
      grad.addColorStop(1, "#8a5a17");
      c.globalAlpha = alpha * gk;
      c.fillStyle = grad;
      c.fill();
      c.globalAlpha = alpha;
    }
    c.lineWidth = 1.2;
    c.strokeStyle = rgba(mix(C.ink, C.accent, goldK), goldK > 0 ? 0.95 : C.dark ? 0.62 : 0.58);
    c.stroke();
    const ca = smooth((morph - 0.5) / 0.5);
    if (ca > 0) {
      // An article: a headline bar, a guide line, then the original and the Chinese side by side.
      const pad = 2.6 * scale;
      const iw = w - 2 * pad;
      const top = y - h / 2;
      const thin = Math.max(0.8, 0.9 * scale);
      const body = rgba(C.ink, C.dark ? 0.32 : 0.26);
      c.globalAlpha = alpha * ca;
      c.fillStyle = goldK > 0.5 ? rgba(C.accent) : rgba(C.ink, C.dark ? 0.7 : 0.62);
      c.fillRect(x - iw / 2, top + h * 0.17, iw * 0.82, 2 * scale);
      c.fillStyle = body;
      c.fillRect(x - iw / 2, top + h * 0.38, iw * 0.92, thin);
      const half = iw * 0.44;
      for (const fy of [0.57, 0.72, 0.86]) {
        const len = half * (fy > 0.8 ? 0.7 : 1);
        c.fillStyle = body;
        c.fillRect(x - iw / 2, top + h * fy, len, thin);
        c.fillStyle = goldK > 0.5 ? rgba(C.accent, 0.55) : body;
        c.fillRect(x + iw / 2 - half, top + h * fy, len, thin);
      }
    }
    c.restore();
  }

  function drawPenta(c: CanvasRenderingContext2D, x: number, y: number, ev: FlowEvent, s3: number, gold: boolean): number {
    const A = smooth(s3 / 0.12) * (1 - smooth((s3 - 0.8) / 0.16));
    if (A <= 0.01) return 0;
    const g = easeOut((s3 - 0.04) / 0.36);
    const R = P.penta;
    const vtx = (i: number, rr: number): Pt => {
      const a = -Math.PI / 2 + (i * TAU) / 5;
      return [x + rr * Math.cos(a), y + rr * Math.sin(a)];
    };
    const polygon = (radius: (i: number) => number) => {
      c.beginPath();
      for (let i = 0; i < 5; i++) {
        const [px, py] = vtx(i, radius(i));
        if (i) c.lineTo(px, py);
        else c.moveTo(px, py);
      }
      c.closePath();
    };
    c.save();
    c.globalAlpha = A;
    c.lineWidth = 0.8;
    polygon(() => R);
    c.strokeStyle = rgba(C.ink, C.dark ? 0.22 : 0.18);
    c.stroke();
    c.strokeStyle = rgba(C.ink, C.dark ? 0.12 : 0.1);
    for (let i = 0; i < 5; i++) {
      const [px, py] = vtx(i, R);
      line(c, x, y, px, py);
    }
    polygon((i) => (R * (ev.axes[i] ?? 0) * g) / 10);
    c.fillStyle = gold ? rgba(C.accent, C.dark ? 0.22 : 0.16) : rgba(C.ink, C.dark ? 0.12 : 0.08);
    c.fill();
    c.lineWidth = 1;
    c.strokeStyle = gold ? rgba(C.accent, 0.9) : rgba(C.ink3, 0.75);
    c.stroke();
    c.restore();
    return A;
  }

  function draw(now: number) {
    const s = S;
    const l = L;
    if (!s || !l || !ctx) return;
    const c = ctx;
    const t = s.t;
    // A phone river is tall: while it runs, only the slice on screen is redrawn.
    let y0 = 0;
    let y1 = l.H;
    if (!l.h && !still) {
      const r = wrap.getBoundingClientRect();
      y0 = Math.floor(clamp(-r.top - 60, 0, l.H));
      y1 = Math.ceil(clamp(window.innerHeight - r.top + 60, 0, l.H));
      if (y1 <= y0) return;
    }
    const sy = Math.floor(y0 * dpr);
    const sh = Math.min(canvas.height, Math.ceil(y1 * dpr)) - sy;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, sy, canvas.width, sh);
    if (sh > 0) c.drawImage(layer, 0, sy, canvas.width, sh, 0, sy, canvas.width, sh);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.save();
    c.beginPath();
    c.rect(0, y0, l.W, y1 - y0);
    c.clip();
    c.lineCap = "round";
    c.lineJoin = "round";

    // A slow light runs along the screen: the AI reading.
    if (!still) {
      const g = flowPx(GATE_U);
      const m = lerp(l.cTop + 16, l.cBot - 16, Math.sin(t * 0.7) * 0.5 + 0.5);
      const [ax, ay] = at(g, m - 26);
      const [bx, by] = at(g, m + 26);
      const gr = c.createLinearGradient(ax, ay, bx, by);
      gr.addColorStop(0, rgba(C.accent, 0));
      gr.addColorStop(0.5, rgba(C.accent, C.dark ? 0.8 : 0.65));
      gr.addColorStop(1, rgba(C.accent, 0));
      c.strokeStyle = gr;
      c.lineWidth = 1.6;
      line(c, ax, ay, bx, by);
    }

    // Source dots light up as they send something.
    l.dots.forEach((d, i) => {
      const age = t - (s.glow[i] ?? -99);
      if (age < 0 || age > 0.9) return;
      const k = 1 - age / 0.9;
      const [x, y] = at(d.f, d.c);
      const col = C.lang[d.lang] as RGBA;
      c.beginPath();
      c.arc(x, y, P.pitch * 0.27 + 3.2 * k, 0, TAU);
      c.fillStyle = rgba(col, 0.18 * k);
      c.fill();
      c.beginPath();
      c.arc(x, y, P.pitch * 0.3 + 0.6 * k, 0, TAU);
      c.fillStyle = rgba(col, 0.6 + 0.4 * k);
      c.fill();
    });

    // Regulation documents: small squares in their own lane.
    for (const g of s.regs) {
      if (g.U < l.regU) continue;
      const [x, y] = ptc(g.U, l.cReg);
      const col = C.lang[g.lang] as RGBA;
      const size = P.art * 2.3;
      const fk = smooth((g.U - 4.15) / 0.35);
      c.lineWidth = 1.1;
      c.strokeStyle = rgba(col, 0.95);
      c.strokeRect(x - size / 2, y - size / 2, size, size);
      if (fk > 0) {
        c.fillStyle = rgba(col, 0.55 * fk);
        c.fillRect(x - size / 2, y - size / 2, size, size);
      }
    }

    // A report: a dot with a short light trail behind it.
    const halo = C.dark ? 0.16 : 0;
    const particle = (x: number, y: number, tail: Pt | null, col: RGBA, al: number, rad: number) => {
      if (tail && Math.abs(x - tail[0]) + Math.abs(y - tail[1]) > 1) {
        const g = c.createLinearGradient(tail[0], tail[1], x, y);
        g.addColorStop(0, rgba(col, 0));
        g.addColorStop(1, rgba(col, (C.dark ? 0.5 : 0.4) * al));
        c.strokeStyle = g;
        c.lineWidth = rad * 1.15;
        line(c, tail[0], tail[1], x, y);
      }
      if (halo) {
        c.beginPath();
        c.arc(x, y, rad * 2.6, 0, TAU);
        c.fillStyle = rgba(col, halo * al);
        c.fill();
      }
      c.beginPath();
      c.arc(x, y, rad, 0, TAU);
      c.fillStyle = rgba(col, al);
      c.fill();
    };
    const noiseAt = (z: Noise, U: number): [number, number] => {
      const d0 = dotU(z.dot);
      const u = Math.max(d0, U);
      return [u, dotCn(z.dot) + z.wa * Math.sin(TAU * z.wf * u + z.wp) * smooth((u - d0) / 0.25)];
    };

    // Off-topic reports: stopped at the screen, they dim and fall away.
    for (const z of s.noise) {
      if (!z.emitted) continue;
      const [u, cn] = noiseAt(z, z.U);
      let [x, y] = pt(u, cn);
      let col = C.lang[z.lang] as RGBA;
      let al = 0.95 * smooth((z.U - dotU(z.dot)) / 0.03);
      let rad = P.art;
      let tail: Pt | null = null;
      if (z.dropped) {
        const age = t - z.dropT;
        const k = smooth(age / 0.35);
        const fall = P.fall * age * age;
        if (l.h) y += fall;
        else x -= fall;
        col = mix(col, C.ink4, k);
        al = 0.9 * (1 - smooth(age / DROP_LIFE)) * (1 - 0.4 * k);
        rad = P.art * (1 - 0.4 * smooth(age / DROP_LIFE));
        if (age < 0.5) {
          // a short mark where it was stopped
          const g = flowPx(GATE_U);
          const cc = crossPx(cn);
          const [ax, ay] = at(g - 4, cc);
          const [bx, by] = at(g + 4, cc);
          c.strokeStyle = rgba(C.ink4, 0.5 * (1 - age / 0.5));
          c.lineWidth = 1;
          line(c, ax, ay, bx, by);
        }
      } else {
        const [bu, bcn] = noiseAt(z, z.U - P.trail / bandLen(z.U));
        tail = pt(bu, bcn);
      }
      if (al > 0.01) particle(x, y, tail, col, al, rad);
    }

    // Reports that belong to an event: they gather into one node.
    const artAt = (ev: FlowEvent, a: Article, evU: number): Pt => {
      const M = clamp((evU - MERGE0) / (MERGE1 - MERGE0));
      const Ma = ease((M - a.delay) / (1 - DELAY));
      const d0 = dotU(a.dot);
      const U = Math.max(d0, evU + a.off * (1 - Ma));
      const grow = smooth((U - d0) / 0.25);
      return pt(U, lerp(dotCn(a.dot) + a.wa * Math.sin(TAU * a.wf * U + a.wp) * grow * (1 - Ma), ev.lane, Ma));
    };
    for (const ev of s.events) {
      const M = clamp((ev.U - MERGE0) / (MERGE1 - MERGE0));
      const [nx, ny] = pt(ev.U, nodeCn(ev));
      const back = P.trail / bandLen(ev.U);
      for (const a of ev.arts) {
        if (a.absorbed || !a.emitted) continue;
        const [x, y] = artAt(ev, a, ev.U);
        const col = C.lang[a.lang] as RGBA;
        if (M > 0.05 && a.Ma < 1) {
          const ta = 0.32 * smooth(a.Ma / 0.2 + M * 0.6) * (1 - a.Ma);
          if (ta > 0.01) {
            c.strokeStyle = rgba(col, ta);
            c.lineWidth = 0.9;
            line(c, x, y, nx, ny);
          }
        }
        const fl = Math.exp(-(t - a.flashT) / 0.3);
        if (fl > 0.03) {
          c.beginPath();
          c.arc(x, y, P.art + 2 + 5 * (1 - fl), 0, TAU);
          c.strokeStyle = rgba(C.accent, 0.55 * fl);
          c.lineWidth = 1;
          c.stroke();
        }
        particle(x, y, artAt(ev, a, ev.U - back), col, 0.95 * smooth((a.U - dotU(a.dot)) / 0.03), P.art * (1 + 0.3 * fl));
      }
    }

    // Event nodes: merge, score (five axes), turn gold over the line, become an article.
    const labelsToPlace: { a: number; s: string; x: number; y: number; col: string; size: number; mono: boolean; align: CanvasTextAlign }[] = [];
    for (const ev of s.events) {
      const M = clamp((ev.U - MERGE0) / (MERGE1 - MERGE0));
      const s3 = clamp(ev.U - 3);
      const w4 = clamp(ev.U - 4);
      const [x, y] = pt(ev.U, nodeCn(ev));
      if (ev.count === 0) {
        const pre = smooth((M - 0.08) / 0.3);
        if (pre > 0.01) {
          c.save();
          c.setLineDash([2, 2.5]);
          c.beginPath();
          c.arc(x, y, P.node + 1.5, 0, TAU);
          c.strokeStyle = rgba(C.ink, (C.dark ? 0.5 : 0.45) * pre);
          c.lineWidth = 1;
          c.stroke();
          c.restore();
        }
        continue;
      }
      const goldK = ev.gold ? ease((s3 - 0.52) / 0.22) : 0;
      const pop = 1 + 0.3 * Math.exp(-(t - ev.popT) / 0.18);
      const r = (P.node + P.nodeK * Math.sqrt(ev.count - 1)) * pop * (1 + 0.14 * goldK);
      if (s3 > 0 && s3 < 1) drawPenta(c, x, y, ev, s3, goldK > 0.5);
      drawShape(c, x, y, r, ease((w4 - 0.06) / 0.4), goldK, 1, 1);
      if (ev.goldAt !== null && t - ev.goldAt < 1.1) {
        const e = (t - ev.goldAt) / 1.1;
        c.beginPath();
        c.arc(x, y, r + 2 + 16 * easeOut(e), 0, TAU);
        c.strokeStyle = rgba(C.accent, 0.6 * (1 - e));
        c.lineWidth = 1.2;
        c.stroke();
      }
      // No figure is drawn beside an event: its size and the five axes are a picture of the step, not a statistic.
    }
    // Labels never sit on each other: the more visible one wins.
    labelsToPlace.sort((p, q) => q.a - p.a);
    const placed = l.boxes.slice();
    for (const lb of labelsToPlace) {
      c.font = `600 ${lb.size}px ${lb.mono ? FONT_MONO : font()}`;
      const w = c.measureText(lb.s).width;
      const x0 = lb.align === "right" ? lb.x - w : lb.x;
      const box: Box = [x0 - 2, lb.y - P.font - 1, x0 + w + 2, lb.y + 3];
      if (placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
      placed.push(box);
      c.globalAlpha = lb.a;
      textLabel(c, lb.s, lb.x, lb.y, lb.col, lb.size, lb.mono, lb.align);
    }
    c.globalAlpha = 1;

    // Copies fan out to the outputs.
    for (const cp of s.copies) {
      const age = t - cp.t0;
      if (age < 0) continue;
      const e = ease(age / cp.dur);
      const p0 = cp.reg ? ptc(cp.U0, l.cReg) : pt(cp.U0, cp.cn0);
      const q = curve(p0, l.anchors[cp.dock] ?? p0);
      const col = cp.reg ? (C.lang[cp.lang] as RGBA) : cp.gold ? C.accent : C.ink3;
      const e0 = Math.max(0, e - 0.24);
      let prev = bez(q, e0);
      for (let i = 1; i <= 8; i++) {
        const cur = bez(q, lerp(e0, e, i / 8));
        c.strokeStyle = rgba(col, (cp.gold ? 0.55 : 0.4) * (i / 8));
        c.lineWidth = cp.gold ? 1.4 : 1.1;
        line(c, prev[0], prev[1], cur[0], cur[1]);
        prev = cur;
      }
      const [x, y] = bez(q, e);
      const fade = 1 - smooth((e - 0.9) / 0.1);
      if (cp.reg) {
        const size = P.art * 2.3 * lerp(1, 0.7, e);
        c.globalAlpha = fade;
        c.fillStyle = rgba(col, 0.55);
        c.fillRect(x - size / 2, y - size / 2, size, size);
        c.strokeStyle = rgba(col);
        c.lineWidth = 1.1;
        c.strokeRect(x - size / 2, y - size / 2, size, size);
        c.globalAlpha = 1;
      } else drawShape(c, x, y, 0, 1, cp.gold ? 1 : 0, lerp(0.92, 0.6, e), fade);
    }
    // A frozen ripple reads as a stray arc: the still picture leaves them out.
    for (const rp of still ? [] : s.ripples) {
      const e = (t - rp.t0) / 0.85;
      const [x, y] = l.anchors[rp.dock] ?? [0, 0];
      c.beginPath();
      c.arc(x, y, 3 + 12 * easeOut(e), 0, TAU);
      c.strokeStyle = rgba(rp.gold ? C.accent : C.ink3, 0.5 * (1 - e));
      c.lineWidth = 1.2;
      c.stroke();
    }

    // A chosen stage: everything else steps back.
    for (let k = 0; k < 6; k++) {
      const a = dim[k] as number;
      if (a < 0.005) continue;
      const lo = k === 0 ? 0 : (l.B[k] as number);
      const hi = k === 5 ? (l.h ? l.W : l.H) : (l.B[k + 1] as number);
      c.fillStyle = rgba(C.bg, a);
      if (l.h) c.fillRect(lo, 0, hi - lo, l.H);
      else c.fillRect(0, lo, l.W, hi - lo);
    }

    // First sight: the river is uncovered along the flow behind a soft edge.
    if (!still) {
      const span = l.h ? l.W : l.H;
      const p = revealAt === null ? 0 : ease((now - revealAt) / 1600);
      if (p < 1) {
        const edge = -140 + (span + 280) * p;
        const [gx0, gy0] = at(edge - 140, 0);
        const [gx1, gy1] = at(edge, 0);
        const gr = c.createLinearGradient(gx0, gy0, gx1, gy1);
        gr.addColorStop(0, rgba(C.bg, 0));
        gr.addColorStop(1, rgba(C.bg, 1));
        c.fillStyle = gr;
        if (l.h) {
          c.fillRect(edge - 140, 0, 140, l.H);
          c.fillStyle = rgba(C.bg);
          c.fillRect(edge, 0, l.W - edge + 1, l.H);
        } else {
          c.fillRect(0, edge - 140, l.W, 140);
          c.fillStyle = rgba(C.bg);
          c.fillRect(0, edge, l.W, l.H - edge + 1);
        }
      }
    }
    c.restore();
  }

  /* ---------- running ---------- */
  function frame(now: number) {
    raf = 0;
    if (still || disposed || !S) return;
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 1 / 60);
    last = now;
    step(S, dt);
    const k = 1 - Math.exp(-dt / 0.13);
    for (let i = 0; i < 6; i++) dim[i] = (dim[i] as number) + ((dimT[i] as number) - (dim[i] as number)) * k;
    draw(now);
    schedule();
  }
  function schedule() {
    if (!raf && !still && !disposed && inView && !document.hidden && S) raf = requestAnimationFrame(frame);
  }
  function redraw() {
    if (!disposed && (still || !raf)) draw(performance.now());
  }
  function fresh() {
    const s = newSim();
    S = s;
    // Start mid-stream: a still frame shows every step at work.
    const n = Math.round((still ? 34 : 17) * 30);
    for (let i = 0; i < n; i++) step(s, 1 / 30);
    s.live = true;
  }
  function relayout() {
    if (disposed) return;
    const was = L ? { h: L.h, n: L.dots.length } : null;
    measure();
    if (!was || was.h !== lay().h || was.n !== lay().dots.length) fresh();
    drawLayer();
    flow.dataset.ready = "";
    redraw();
  }
  function stillDim() {
    for (let i = 0; i < 6; i++) dim[i] = dimT[i] as number;
  }

  /* ---------- pointer ---------- */
  function stageAt(e: PointerEvent | MouseEvent): number | null {
    if (!L) return null;
    const r = wrap.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const pos = L.h ? x : y;
    if (L.h ? y < 0 || y > L.H || x < 0 || x > L.W : x > L.riverW + 6) return null;
    for (let k = 5; k >= 0; k--) if (pos >= (L.B[k] as number)) return k;
    return 0;
  }
  const onMove = (e: PointerEvent) => {
    if (e.pointerType === "mouse" && L?.h) o.onHover(stageAt(e));
  };
  const onLeave = () => o.onHover(null);
  const onClick = (e: MouseEvent) => {
    const k = stageAt(e);
    if (k !== null) o.onTap(k);
  };
  const onVisibility = () => {
    last = 0;
    schedule();
  };
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const onMotion = () => {
    still = reduce.matches;
    if (still) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      stillDim();
      redraw();
    } else {
      last = 0;
      revealAt ??= performance.now();
      schedule();
    }
  };

  relayout();
  if (still) redraw();
  else schedule();
  const resize = new ResizeObserver(() => relayout());
  resize.observe(flow);
  const seen = new IntersectionObserver(
    ([entry]) => {
      inView = !!entry?.isIntersecting;
      if (inView && revealAt === null) revealAt = performance.now();
      last = 0;
      schedule();
    },
    { rootMargin: "0px 0px -12% 0px" },
  );
  seen.observe(wrap);
  const unwatch = watchAppearance(() => {
    C = readColors();
    relayout();
  });
  document.addEventListener("visibilitychange", onVisibility);
  reduce.addEventListener("change", onMotion);
  wrap.addEventListener("pointermove", onMove);
  wrap.addEventListener("pointerleave", onLeave);
  wrap.addEventListener("click", onClick);
  void document.fonts?.ready.then(() => relayout());

  return {
    setActive(stage) {
      active = stage;
      for (let i = 0; i < 6; i++) dimT[i] = active === null || i === active ? 0 : C.dark ? 0.66 : 0.62;
      if (still) {
        stillDim();
        redraw();
      }
    },
    setSources(count, next) {
      labels = next;
      if (count === sources) {
        if (L) drawLayer();
        redraw();
        return;
      }
      sources = Math.max(0, count);
      L = null;
      relayout();
    },
    destroy() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      for (const timer of timers) window.clearTimeout(timer);
      for (const d of docks) d.classList.remove("is-hit");
      resize.disconnect();
      seen.disconnect();
      unwatch();
      document.removeEventListener("visibilitychange", onVisibility);
      reduce.removeEventListener("change", onMotion);
      wrap.removeEventListener("pointermove", onMove);
      wrap.removeEventListener("pointerleave", onLeave);
      wrap.removeEventListener("click", onClick);
      delete flow.dataset.ready;
    },
  };
}
