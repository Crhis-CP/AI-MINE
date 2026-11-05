// Generates the site lockup (industry/brand/lockup{,-dark,-small}.svg and lockup.json): the five-arm galaxy
// mark followed by the site name set as SVG paths in a warm-gold gradient, so the wordmark is one static
// logotype on every system (DEC-78 logo, Owner 2026-11-05: the name in gradient gold, the mark no smaller
// than the name). Chinese in Noto Sans SC Bold, Latin in Instrument Sans Bold (both SIL OFL 1.1).
//
// Usage: node scripts/wordmark.ts <NotoSansSC-Bold.ttf> <InstrumentSans-Bold.ttf>
//   (any copy of the two OFL fonts; they are not dependencies)
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import opentype from "opentype.js";
import { SITE } from "@amp/industry/site";

const [hanFile, latinFile] = process.argv.slice(2);
if (!hanFile || !latinFile) throw new Error("usage: node scripts/wordmark.ts <NotoSansSC-Bold.ttf> <InstrumentSans-Bold.ttf>");
const han = opentype.parse(readFileSync(hanFile).buffer);
const latin = opentype.parse(readFileSync(latinFile).buffer);
const BRAND = path.join(import.meta.dirname, "../industry/brand");

/** Ink height of the Chinese glyphs; the mark box is 1.55× that (its ink about 1.3×), so it never reads smaller than the name. */
const H = 100;
const MARK = H * 1.55;
const MARK_GAP = H * 0.2;
/** Latin capitals a touch shorter than the ideographs, which read larger. */
const CAPS = H * 0.92;
const isLatin = (ch: string) => /[A-Za-z0-9]/.test(ch);
const gap = (a: string, b: string) => (isLatin(a) && isLatin(b) ? H * 0.06 : isLatin(a) !== isLatin(b) ? H * 0.14 : H * 0.07);

/** One glyph's outline, scaled so its ink is `height` tall, with its ink box. */
function glyph(ch: string, height: number) {
  const font = isLatin(ch) ? latin : han;
  const probe = font.getPath(ch, 0, 0, 1000).getBoundingBox();
  const size = (1000 * height) / (probe.y2 - probe.y1);
  const p = font.getPath(ch, 0, 0, size);
  return { path: p, box: p.getBoundingBox() };
}

// Set the name: each glyph's ink bottom sits on the baseline at y = 0, spacing measured ink to ink.
let x = MARK + MARK_GAP;
const parts: string[] = [];
const chars = [...SITE.name];
chars.forEach((ch, i) => {
  const g = glyph(ch, isLatin(ch) ? CAPS : H);
  const dx = x - g.box.x1,
    dy = -g.box.y2;
  for (const c of g.path.commands) {
    if ("x" in c) {
      c.x += dx;
      c.y += dy;
    }
    if ("x1" in c) {
      c.x1 += dx;
      c.y1 += dy;
    }
    if ("x2" in c) {
      c.x2 += dx;
      c.y2 += dy;
    }
  }
  parts.push(g.path.toPathData(2));
  x += g.box.x2 - g.box.x1 + (i < chars.length - 1 ? gap(ch, chars[i + 1]!) : 0);
});
const width = Math.ceil(x + 2);
const top = -MARK / 2 - H / 2; // mark centred on the name's ink
const vb = `0 ${top.toFixed(1)} ${width} ${MARK}`;

/** The mark's inner markup from its master, placed at the left, centred on the name. */
function markMarkup(file: string) {
  const svg = readFileSync(path.join(BRAND, "source", file), "utf8");
  const inner = svg.replace(/^<svg[^>]*>(<title>[^<]*<\/title>)?/, "").replace(/<\/svg>\s*$/, "");
  return `<g transform="translate(0 ${top.toFixed(1)}) scale(${(MARK / 48).toFixed(4)})">${inner}</g>`;
}

/** Vertical gold for the name: light theme keeps to the deep half of the ramp, dark theme to the light half. */
const TEXT = {
  light: ["#C08A2C", "#A06A1E", "#7A4E12"],
  dark: ["#FCE8AE", "#F0CA6E", "#D09439"],
};
function lockup(markFile: string, stops: string[]) {
  const grad = `<linearGradient id="fw" gradientUnits="userSpaceOnUse" x1="0" y1="${-H}" x2="0" y2="0">${stops
    .map((c, i) => `<stop offset="${i / (stops.length - 1)}" stop-color="${c}"/>`)
    .join("")}</linearGradient>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"><title>${SITE.name}</title><defs>${grad}</defs>${markMarkup(markFile)}<path fill="url(#fw)" d="${parts.join("")}"/></svg>\n`;
}

writeFileSync(path.join(BRAND, "lockup.svg"), lockup("mark.svg", TEXT.light));
writeFileSync(path.join(BRAND, "lockup-dark.svg"), lockup("mark-dark.svg", TEXT.dark));
writeFileSync(path.join(BRAND, "lockup-small.svg"), lockup("mark-small.svg", TEXT.light));
writeFileSync(path.join(BRAND, "lockup.json"), `{ "viewBox": "${vb}", "aspect": ${+(width / MARK).toFixed(4)}, "nameHeight": ${+(H / MARK).toFixed(4)} }\n`);
console.log(`lockup ${vb}`);
