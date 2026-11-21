// The film's scene kinds drawn with Three.js (TASK-0367). Each kind is a builder: it adds its shapes to the scene's
// group and returns how to draw them at a moment of the scene; the words over it are the overlay's HTML (Overlay.tsx),
// placed by the same layout functions and moved here in step (found by data-k). Figures come from the real data read for
// the page; a kind without its data draws its sketch and the overlay says so. Later films reuse these kinds as data.
import {
  AdditiveBlending,
  BufferGeometry,
  CircleGeometry,
  type Color,
  CubicBezierCurve3,
  DoubleSide,
  Float32BufferAttribute,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Points,
  PointsMaterial,
  RingGeometry,
  Vector3,
} from "three";
import { plot, priceLabel } from "../live/format";
import type { LiveMetal } from "../live/types";
import { type Builder, type Drawn, type SceneContext, clamp01, easeOut, span } from "./engine";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The margin and the band at the top kept for the scene's heading. */
export function frame(w: number, h: number) {
  const m = Math.round(Math.max(16, Math.min(w, h) * 0.06));
  const top = m + Math.round(Math.min(72, h * 0.16));
  return { m, top, body: { x: m, y: top, w: w - 2 * m, h: h - top - m } satisfies Box };
}

// Both faces: with y pointing down the hand-built ribbons and areas wind either way.
const flat = (color: Color, opacity = 1) => new MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: false, side: DoubleSide });
/** A rectangle with its top-left corner at (x, y) in page pixels. */
function rect(ctx: SceneContext, box: Box, color: Color, opacity = 1): Mesh {
  const mesh = new Mesh(new PlaneGeometry(1, 1), flat(color, opacity));
  place(mesh, box);
  ctx.group.add(mesh);
  return mesh;
}
function place(mesh: Mesh, box: Box) {
  mesh.scale.set(Math.max(0.01, box.w), Math.max(0.01, box.h), 1);
  mesh.position.set(box.x + box.w / 2, -(box.y + box.h / 2), 0);
}
function disc(ctx: SceneContext, r: number, color: Color, opacity = 1, glow = false): Mesh {
  const material = flat(color, opacity);
  if (glow) material.blending = AdditiveBlending;
  const mesh = new Mesh(new CircleGeometry(r, 40), material);
  ctx.group.add(mesh);
  return mesh;
}
const opacity = (mesh: Mesh, value: number) => {
  (mesh.material as MeshBasicMaterial).opacity = value;
  mesh.visible = value > 0.01;
};
/** An overlay element of this scene by its key, styled only when the value changes. */
function words(ctx: SceneContext) {
  const cache = new Map<string, HTMLElement | null>();
  /** `data-k` marks words that fade and move with the drawing (hidden until shown); `data-t` words whose text or state changes. */
  const find = (key: string, attr = "data-k") => {
    let el = cache.get(attr + key);
    if (!el?.isConnected) {
      el = ctx.overlay.querySelector<HTMLElement>(`[${attr}="${key}"]`);
      if (el) cache.set(attr + key, el);
    }
    return el ?? null;
  };
  return {
    show(key: string, shown: number, dx = 0, dy = 0) {
      const el = find(key);
      const style = `${shown.toFixed(2)}|${dx.toFixed(1)}|${dy.toFixed(1)}`;
      if (!el || el.dataset.s === style) return;
      el.dataset.s = style;
      el.style.opacity = String(clamp01(shown));
      el.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
    },
    text(key: string, value: string) {
      const el = find(key, "data-t");
      if (el && el.textContent !== value) el.textContent = value;
    },
    /** How wide a word is drawn, to keep it inside the film. */
    width(key: string) {
      return find(key)?.offsetWidth ?? 0;
    },
    attr(key: string, name: string, value: string) {
      const el = find(key, "data-t");
      if (el && el.getAttribute(name) !== value) el.setAttribute(name, value);
    },
  };
}

/** Gold specks drifting slowly behind every scene. */
export function ambient(ctx: SceneContext): Drawn {
  const count = Math.round(Math.min(160, (ctx.w * ctx.h) / 5000));
  const base = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const a = Math.sin(i * 12.9898) * 43758.5453,
      b = Math.sin(i * 78.233) * 12345.6789;
    base[i * 3] = (a - Math.floor(a)) * ctx.w;
    base[i * 3 + 1] = -(b - Math.floor(b)) * ctx.h;
  }
  const geometry = new BufferGeometry();
  const positions = new Float32Array(base);
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  const points = new Points(geometry, new PointsMaterial({ color: ctx.palette.gold, size: 2.2, transparent: true, opacity: 0.35, depthWrite: false }));
  ctx.group.add(points);
  return (ms) => {
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (base[i * 3]! + ms * 0.006 * (1 + (i % 5) * 0.3)) % ctx.w;
      positions[i * 3 + 1] = base[i * 3 + 1]! + Math.sin(ms / 1400 + i) * 3;
    }
    geometry.attributes.position!.needsUpdate = true;
  };
}

/** Rings opening from the middle; the overlay brings in the film's title. */
const title: Builder = (ctx) => {
  const cx = ctx.w / 2,
    cy = ctx.h / 2;
  const r = Math.min(ctx.w, ctx.h) * 0.42;
  const rings = [0, 1, 2].map((i) => {
    const mesh = new Mesh(new RingGeometry(r - 1.5, r, 96), flat(i === 1 ? ctx.palette.cyan : ctx.palette.gold, 0.6));
    mesh.position.set(cx, -cy, 0);
    ctx.group.add(mesh);
    return mesh;
  });
  const glow = disc(ctx, r * 0.5, ctx.palette.gold, 0.18, true);
  glow.position.set(cx, -cy, 0);
  const say = words(ctx);
  return (ms) => {
    rings.forEach((ring, i) => {
      const t = ((ms + i * 700) % 2100) / 2100;
      ring.scale.setScalar(0.2 + t * 0.9);
      opacity(ring, (1 - t) * 0.7);
    });
    glow.scale.setScalar(0.8 + Math.sin(ms / 500) * 0.08);
    say.show("kicker", span(ms, 200, 500), 0, (1 - span(ms, 200, 500)) * 12);
    say.show("title", span(ms, 500, 600), 0, (1 - span(ms, 500, 600)) * 16);
  };
};

/** The rows of the country list: up to five cards stacked under the heading. */
export function feedRows(w: number, h: number): Box[] {
  const { body } = frame(w, h);
  const tabs = 44;
  const gap = Math.max(6, Math.round(body.h * 0.025));
  const rowH = Math.min(64, (body.h - tabs - gap * 4) / 5);
  return Array.from({ length: 5 }, (_, i) => ({ x: body.x, y: body.y + tabs + i * (rowH + gap), w: body.w, h: rowH }));
}

/** Five cards slide in for each country in turn, as the home page lists its newest; the titles ride on them. */
const feed: Builder = (ctx, scene) => {
  const lists = (ctx.data.countries ?? []).filter((c) => c.items.length);
  const turns = Math.max(1, lists.length);
  const turn = scene.ms / turns;
  const rows = feedRows(ctx.w, ctx.h);
  const cards = rows.map((row) => ({ card: rect(ctx, row, ctx.palette.card, 0.9), bar: rect(ctx, { ...row, w: 4 }, ctx.palette.gold) }));
  const say = words(ctx);
  return (ms) => {
    const k = Math.min(turns - 1, Math.floor(ms / turn));
    const t = ms - k * turn;
    for (let c = 0; c < turns; c++) say.attr(`tab-${c}`, "data-on", String(c === k));
    const rowsNow = lists[k]?.items.length ?? rows.length;
    cards.forEach(({ card, bar }, i) => {
      const enter = i < rowsNow ? span(t, 150 + i * 140, 420) : 0;
      const leave = k < turns - 1 ? span(t, turn - 450 + i * 40, 320) : 0;
      const dx = (1 - enter) * 60 - leave * 60;
      const shown = enter * (1 - leave);
      const row = rows[i]!;
      place(card, { ...row, x: row.x + dx });
      place(bar, { ...row, x: row.x + dx, w: 4 });
      opacity(card, shown * 0.9);
      opacity(bar, shown);
      for (let c = 0; c < turns; c++) say.show(`row-${c}-${i}`, c === k ? shown : 0, dx);
    });
    say.show("sketch", lists.length ? 0 : span(ms, 300, 500));
  };
};

/** The plotting area of the trend scene, under the heading and above the reading of the point. */
export function trendBox(w: number, h: number): Box {
  const { body } = frame(w, h);
  return { x: body.x, y: body.y + 26, w: body.w, h: body.h - 60 };
}

/** The line draws itself from the real published periods; a light runs at its head and the overlay reads that point. */
const trend: Builder = (ctx, scene) => {
  const metals = ctx.data.metals ?? [];
  const box = trendBox(ctx.w, ctx.h);
  const turns = Math.max(1, metals.length);
  const turn = scene.ms / turns;
  const say = words(ctx);
  // Without prices: a fixed sketch line, the overlay marks it as one.
  const shapes: LiveMetal[] = metals.length
    ? metals
    : [
        {
          key: "sketch",
          metal: "",
          quote: "",
          source: "",
          unit: "",
          decimals: null,
          points: [5, 7, 6, 9, 8, 11, 10, 13].map((v, i) => ({ label: String(i), end: String(i), value: String(v) })),
        },
      ];
  const drawn = shapes.map((metal) => {
    const pts = plot(metal, box.w, box.h, 0).map(([x, y]) => [box.x + x, -(box.y + y)] as const);
    const up = Number(metal.points.at(-1)!.value) >= Number(metal.points[0]!.value);
    const color = metals.length ? (up ? ctx.palette.up : ctx.palette.down) : ctx.palette.gold;
    // WebGL draws lines one pixel wide: the line is a ribbon of quads, 3 px across, one quad per published step.
    const ribbon: number[] = [];
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1]!,
        [x1, y1] = pts[i]!;
      const len = Math.hypot(x1 - x0, y1 - y0) || 1;
      const nx = (-(y1 - y0) / len) * 1.5,
        ny = ((x1 - x0) / len) * 1.5;
      ribbon.push(x0 + nx, y0 + ny, 1, x1 + nx, y1 + ny, 1, x0 - nx, y0 - ny, 1, x1 + nx, y1 + ny, 1, x1 - nx, y1 - ny, 1, x0 - nx, y0 - ny, 1);
    }
    const lineGeometry = new BufferGeometry();
    lineGeometry.setAttribute("position", new Float32BufferAttribute(ribbon, 3));
    const line = new Mesh(lineGeometry, flat(color, 0.999));
    // The area under the line, two triangles per step, drawn as far as the line has gone.
    const area: number[] = [];
    const floor = -(box.y + box.h);
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1]!,
        [x1, y1] = pts[i]!;
      area.push(x0, y0, 0, x1, y1, 0, x0, floor, 0, x1, y1, 0, x1, floor, 0, x0, floor, 0);
    }
    const areaGeometry = new BufferGeometry();
    areaGeometry.setAttribute("position", new Float32BufferAttribute(area, 3));
    const fill = new Mesh(areaGeometry, flat(color, 0.16));
    const head = disc(ctx, 4.5, color);
    const halo = disc(ctx, 16, color, 0.25, true);
    ctx.group.add(fill, line);
    return { pts, line, lineGeometry, fill, areaGeometry, head, halo, metal };
  });
  return (ms) => {
    const k = Math.min(drawn.length - 1, Math.floor(ms / turn));
    const t = ms - k * turn;
    drawn.forEach((d, i) => {
      const on = i === k;
      d.line.visible = d.fill.visible = on;
      d.head.visible = d.halo.visible = on;
      if (!on) return;
      const n = d.pts.length;
      const reach = span(t, 300, turn * 0.6);
      const at = Math.max(0, Math.min(n - 1, Math.round(reach * (n - 1))));
      d.lineGeometry.setDrawRange(0, at * 6);
      d.areaGeometry.setDrawRange(0, at * 6);
      const [x, y] = d.pts[at]!;
      d.head.position.set(x, y, 1);
      d.halo.position.set(x, y, 0.5);
      d.halo.scale.setScalar(1 + Math.sin(ms / 220) * 0.18);
      const fade = k < drawn.length - 1 ? 1 - span(t, turn - 350, 300) : 1;
      opacity(d.line, fade);
      opacity(d.fill, 0.16 * fade);
      opacity(d.head, fade);
      opacity(d.halo, 0.25 * fade);
      if (metals.length) {
        const point = d.metal.points[at]!;
        say.text(`point-${i}`, point.label);
        say.text(`value-${i}`, priceLabel(point.value, d.metal.decimals));
        say.show(`read-${i}`, span(t, 300, 300) * fade, Math.max(0, Math.min(x - box.x, box.w - say.width(`read-${i}`))), 0);
      }
    });
    for (let i = 0; i < drawn.length; i++) say.show(`metal-${i}`, i === k ? span(ms - i * turn, 0, 400) : 0);
    say.show("sketch", metals.length ? 0 : span(ms, 300, 500));
  };
};

/** Where the discs of the count scene sit: a grid filling the body beside the number. */
export function countArea(w: number, h: number): { number: Box; grid: Box } {
  const { body } = frame(w, h);
  const wide = w > h;
  const numberBox = wide ? { ...body, w: body.w * 0.38 } : { ...body, h: body.h * 0.34 };
  const grid = wide
    ? { x: body.x + body.w * 0.42, y: body.y, w: body.w * 0.58, h: body.h }
    : { x: body.x, y: body.y + body.h * 0.38, w: body.w, h: body.h * 0.62 };
  return { number: numberBox, grid };
}

/** One disc per event on the hot list pops in while the number counts up to the real count. */
const count: Builder = (ctx, scene) => {
  const real = ctx.data.hot?.count ?? null;
  const n = Math.max(1, Math.min(real ?? 24, 400));
  const { grid } = countArea(ctx.w, ctx.h);
  const cols = Math.max(1, Math.ceil(Math.sqrt((n * grid.w) / grid.h)));
  const rows = Math.ceil(n / cols);
  const cell = Math.min(grid.w / cols, grid.h / rows, 44);
  const r = cell * 0.34;
  // A short list sits in the middle of its area rather than stretching over it.
  const x0 = grid.x + (grid.w - cols * cell) / 2,
    y0 = grid.y + (grid.h - rows * cell) / 2;
  const dots = new InstancedMesh(new CircleGeometry(r, 24), flat(ctx.palette.rose, 0.85), n);
  ctx.group.add(dots);
  const top = [0, 1, 2].filter((i) => i < n).map(() => disc(ctx, r * 1.7, ctx.palette.gold, 0.35, true));
  const matrix = new Matrix4();
  const at = (i: number) => [x0 + (i % cols) * cell + cell / 2, -(y0 + Math.floor(i / cols) * cell + cell / 2)] as const;
  const say = words(ctx);
  const rise = Math.min(2400, scene.ms * 0.55);
  return (ms) => {
    for (let i = 0; i < n; i++) {
      const t = clamp01((ms - 200 - (i / n) * rise) / 260);
      const s = t <= 0 ? 0.0001 : 1 + Math.sin(t * Math.PI) * 0.35 * (1 - t);
      const [x, y] = at(i);
      matrix.makeScale(s * t || 0.0001, s * t || 0.0001, 1).setPosition(x, y, 0);
      dots.setMatrixAt(i, matrix);
    }
    dots.instanceMatrix.needsUpdate = true;
    top.forEach((glow, i) => {
      const [x, y] = at(i);
      glow.position.set(x, y, -0.5);
      opacity(glow, span(ms, rise, 400) * (0.25 + Math.sin(ms / 300 + i) * 0.1));
    });
    if (real !== null) say.text("count", String(Math.round(real * easeOut((ms - 200) / rise))));
    say.show("number", span(ms, 100, 400), 0, (1 - span(ms, 100, 400)) * 10);
    say.show("rule", span(ms, rise, 500));
  };
};

/** The two columns of the regulation page: side by side on a wide film, one above the other on a tall one. */
export function columns(w: number, h: number): [Box, Box] {
  const { body } = frame(w, h);
  if (w >= h * 0.9) {
    const gap = body.w * 0.06,
      cw = (body.w - gap) / 2;
    return [
      { ...body, w: cw },
      { ...body, x: body.x + cw + gap, w: cw },
    ];
  }
  const gap = body.h * 0.06,
    ch = (body.h - gap) / 2;
  return [
    { ...body, y: body.y + 22, h: ch - 22 },
    { ...body, y: body.y + ch + gap + 22, h: ch - 22 },
  ];
}

/** Reading on one side, official text on the other: a clause number lights, a line runs to its clause, the revision shows. */
const sideBySide: Builder = (ctx) => {
  const [left, right] = columns(ctx.w, ctx.h);
  const lines = (box: Box, indent: number) =>
    Array.from({ length: 6 }, (_, i) => {
      const lh = Math.max(5, box.h * 0.045);
      const row = { x: box.x + indent, y: box.y + box.h * 0.14 + i * (box.h * 0.13), w: (box.w - indent - 16) * (i % 2 ? 0.72 : 0.92), h: lh };
      return { row, mesh: rect(ctx, row, ctx.palette.ink, 0.22) };
    });
  rect(ctx, left, ctx.palette.card, 0.85);
  rect(ctx, right, ctx.palette.card, 0.85);
  const a = lines(left, 40);
  const b = lines(right, 16);
  const pick = a[2]!.row;
  const chip = rect(ctx, { x: left.x + 12, y: pick.y - 3, w: 20, h: pick.h + 6 }, ctx.palette.rose);
  const target = b[3]!;
  const glow = rect(ctx, { x: target.row.x - 4, y: target.row.y - 5, w: target.row.w + 8, h: target.row.h + 10 }, ctx.palette.gold, 0);
  const from = new Vector3(left.x + 32, -(pick.y + pick.h / 2), 1);
  const to = new Vector3(target.row.x - 4, -(target.row.y + target.row.h / 2), 1);
  const wide = right.x > left.x;
  const bend = wide ? new Vector3((from.x + to.x) / 2, from.y, 1) : new Vector3(from.x - 20, (from.y + to.y) / 2, 1);
  const bend2 = wide ? new Vector3((from.x + to.x) / 2, to.y, 1) : new Vector3(to.x - 20, (from.y + to.y) / 2, 1);
  const curveGeometry = new BufferGeometry().setFromPoints(new CubicBezierCurve3(from, bend, bend2, to).getPoints(64));
  const curve = new Line(curveGeometry, new LineBasicMaterial({ color: ctx.palette.rose }));
  ctx.group.add(curve);
  const strike = b[1]!.row;
  const cut = rect(ctx, { x: strike.x, y: strike.y + strike.h / 2 - 1, w: strike.w, h: 2 }, ctx.palette.rose);
  const added = b[5]!.row;
  const under = rect(ctx, { x: added.x, y: added.y + added.h + 3, w: added.w, h: 2 }, ctx.palette.gold);
  const say = words(ctx);
  return (ms) => {
    for (const [i, { mesh }] of [...a, ...b].entries()) opacity(mesh, 0.22 * span(ms, 100 + i * 40, 300));
    const pop = span(ms, 900, 300);
    chip.scale.set(20 * (pop || 0.01), (pick.h + 6) * (pop || 0.01), 1);
    curveGeometry.setDrawRange(0, Math.round(65 * span(ms, 1300, 800)));
    opacity(glow, 0.55 * span(ms, 2000, 400));
    const s = span(ms, 3200, 600);
    place(cut, { x: strike.x, y: strike.y + strike.h / 2 - 1, w: strike.w * s, h: 2 });
    place(under, { x: added.x, y: added.y + added.h + 3, w: added.w * span(ms, 3600, 600), h: 2 });
    say.show("labels", span(ms, 100, 400));
    say.show("revise", span(ms, 3400, 400));
  };
};

/** Rings closing in to the middle; the overlay offers the pages to open. */
const outro: Builder = (ctx) => {
  const cx = ctx.w / 2,
    cy = ctx.h / 2;
  const r = Math.min(ctx.w, ctx.h) * 0.45;
  const rings = [0, 1].map((i) => {
    const mesh = new Mesh(new RingGeometry(r - 1.5, r, 96), flat(i ? ctx.palette.violet : ctx.palette.gold, 0.5));
    mesh.position.set(cx, -cy, 0);
    ctx.group.add(mesh);
    return mesh;
  });
  const say = words(ctx);
  return (ms) => {
    rings.forEach((ring, i) => {
      const t = ((ms + i * 900) % 1800) / 1800;
      ring.scale.setScalar(1.1 - t * 0.8);
      opacity(ring, t * 0.6);
    });
    say.show("links", span(ms, 200, 500), 0, (1 - span(ms, 200, 500)) * 12);
  };
};

export const BUILDERS: Record<"title" | "feed" | "trend" | "count" | "sideBySide" | "outro", Builder> = { title, feed, trend, count, sideBySide, outro };
