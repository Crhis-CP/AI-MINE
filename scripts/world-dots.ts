// Generates the reader's world dot map (industry/brand/world-dots.svg and world-dots.json): land only, no
// borders and no names (DEC-78, Owner 2026-11-05), from Natural Earth 1:10m land (public domain), as
// packaged by world-atlas (`npm pack world-atlas@2.0.2`, ISC; land-10m.json). Not a dependency.
//
// Every land cell of a 2° equirectangular grid whose centre lies on land is a dot, and every island
// polygon too small to hold a cell centre still gets the dot of the cell it falls in, so small islands are
// never dropped. The islands listed in REQUIRED (the South China Sea islands, Diaoyu Dao and its
// affiliated islands) are checked against the data and always drawn.
//
// Usage: node scripts/world-dots.ts <world-atlas package directory>
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node scripts/world-dots.ts <world-atlas package directory>");
const OUT = path.join(import.meta.dirname, "../industry/brand");

/** Map frame: longitude −180…180, latitude 84°N…58°S (Antarctica left out), 1 unit per degree. */
export const FRAME = { west: -180, east: 180, north: 84, south: -58, step: 2 } as const;
const COLS = (FRAME.east - FRAME.west) / FRAME.step,
  ROWS = (FRAME.north - FRAME.south) / FRAME.step;

/** Islands that must appear on any map published for Chinese readers, whatever the source data holds. */
const REQUIRED: Array<{ name: string; lon: number; lat: number }> = [
  { name: "东沙群岛", lon: 116.72, lat: 20.7 },
  { name: "西沙群岛", lon: 112.0, lat: 16.5 },
  { name: "中沙群岛黄岩岛", lon: 117.76, lat: 15.15 },
  { name: "南沙群岛（北部）", lon: 114.36, lat: 10.38 },
  { name: "南沙群岛（中部）", lon: 112.9, lat: 8.85 },
  { name: "钓鱼岛", lon: 123.47, lat: 25.74 },
  { name: "赤尾屿", lon: 124.56, lat: 25.92 },
];

type Ring = Array<[number, number]>;
type Topology = {
  transform?: { scale: [number, number]; translate: [number, number] };
  arcs: Array<Array<[number, number]>>;
  objects: Record<string, { type: string; geometries?: Array<{ type: string; arcs: number[][] | number[][][] }>; arcs?: number[][] | number[][][] }>;
};

/** Decodes a TopoJSON land object into polygons (outer ring first, then holes). */
function polygons(topo: Topology, object: string): Ring[][] {
  const { scale, translate } = topo.transform ?? { scale: [1, 1], translate: [0, 0] };
  const arcs = topo.arcs.map((arc) => {
    let x = 0,
      y = 0;
    return arc.map(([dx, dy]) => {
      if (topo.transform) {
        x += dx;
        y += dy;
        return [x * scale[0] + translate[0], y * scale[1] + translate[1]] as [number, number];
      }
      return [dx, dy] as [number, number];
    });
  });
  const ring = (indices: number[]): Ring =>
    indices.flatMap((i, n) => {
      const points = i < 0 ? [...arcs[~i]!].reverse() : arcs[i]!;
      return n ? points.slice(1) : points;
    });
  const geometries = topo.objects[object]!.geometries ?? [topo.objects[object] as { type: string; arcs: number[][] | number[][][] }];
  return geometries.flatMap((g) =>
    g.type === "Polygon" ? [(g.arcs as number[][]).map(ring)] : g.type === "MultiPolygon" ? (g.arcs as number[][][]).map((p) => p.map(ring)) : [],
  );
}

function inRing([x, y]: [number, number], ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!,
      [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const cellOf = (lon: number, lat: number) => {
  const c = Math.min(COLS - 1, Math.max(0, Math.floor((lon - FRAME.west) / FRAME.step)));
  const r = Math.min(ROWS - 1, Math.max(0, Math.floor((FRAME.north - lat) / FRAME.step)));
  return r * COLS + c;
};

/** Rings that cross the 180° meridian are unwrapped into one continuous run of longitudes (beyond ±180). */
function unwrap(ring: Ring): Ring {
  let shift = 0;
  return ring.map(([x, y], i) => {
    if (i) {
      const prev = ring[i - 1]![0];
      if (x - prev > 180) shift -= 360;
      else if (prev - x > 180) shift += 360;
    }
    return [x + shift, y];
  });
}

const topo = JSON.parse(readFileSync(path.join(dir, "land-10m.json"), "utf8")) as Topology;
const land = polygons(topo, "land").map((raw) => {
  const rings = raw.map(unwrap);
  const xs = rings[0]!.map((p) => p[0]),
    ys = rings[0]!.map((p) => p[1]);
  return { rings, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as const };
});
const onLand = ([x, y]: [number, number]) =>
  [x, x - 360, x + 360].some((lon) => {
    const p: [number, number] = [lon, y];
    return land.some(
      ({ rings, box }) =>
        lon >= box[0] && lon <= box[2] && y >= box[1] && y <= box[3] && inRing(p, rings[0]!) && !rings.slice(1).some((hole) => inRing(p, hole)),
    );
  });

const cells = new Set<number>();
for (let r = 0; r < ROWS; r++)
  for (let c = 0; c < COLS; c++) {
    const centre: [number, number] = [FRAME.west + (c + 0.5) * FRAME.step, FRAME.north - (r + 0.5) * FRAME.step];
    if (onLand(centre)) cells.add(r * COLS + c);
  }
const centred = cells.size;
for (const { rings, box } of land) {
  if (box[1] < FRAME.south || box[3] > FRAME.north + 2) continue;
  const outer = rings[0]!;
  const [lon, lat] = outer.reduce(([a, b], [x, y]) => [a + x / outer.length, b + y / outer.length], [0, 0]);
  cells.add(cellOf(((((lon + 180) % 360) + 360) % 360) - 180, lat));
}
const report = REQUIRED.map((island) => {
  const near = land.some(({ box }) => island.lon >= box[0] - 0.3 && island.lon <= box[2] + 0.3 && island.lat >= box[1] - 0.3 && island.lat <= box[3] + 0.3);
  cells.add(cellOf(island.lon, island.lat));
  return `${island.name}: ${near ? "in source data" : "added"}`;
});

const width = COLS * FRAME.step,
  height = ROWS * FRAME.step;
const d = [...cells]
  .sort((a, b) => a - b)
  .map((cell) => `M${((cell % COLS) + 0.5) * FRAME.step} ${(Math.floor(cell / COLS) + 0.5) * FRAME.step}h0`)
  .join("");
writeFileSync(
  path.join(OUT, "world-dots.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><title>世界陆地点阵</title><path id="dots" d="${d}" fill="none" stroke-width="1.25" stroke-linecap="round"/></svg>\n`,
);
writeFileSync(
  path.join(OUT, "world-dots.json"),
  `{ "west": ${FRAME.west}, "north": ${FRAME.north}, "width": ${width}, "height": ${height}, "step": ${FRAME.step}, "dots": ${cells.size} }\n`,
);
console.log(`${cells.size} dots (${centred} by cell centre, ${cells.size - centred} from small islands)\n${report.join("\n")}`);
