// Site icons (DEC-78 logo; Owner 2026-11-06: search results and every icon show the S2 five-arm galaxy). The icon
// files in industry/brand/ are what scripts/brand-icons.ts renders from the galaxy masters, and every icon the page
// head, the web manifest, the RSS channel and the Organization logo name is one of them: routed to the api by the
// web server, served at the site root, square and of the size it is declared at. The home page's structured data
// is checked in apps/web/tests/home-status.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import Fastify from "fastify";
import sharp from "sharp";
import { FEED_IMAGE } from "@amp/backend/publication/feeds";
import { isApiOwned } from "@amp/contracts/http-policy";
import { registerStatic } from "../apps/api/src/routes/static.ts";
import { ICON_LINKS, LOGO_PATH } from "../apps/web/app/lib/icons.ts";
import { brandIcons } from "../scripts/brand-icons.ts";

const BRAND = path.join(import.meta.dirname, "../industry/brand");
const renders = await brandIcons();
const app = Fastify();
registerStatic(app);
after(() => app.close());

/**
 * What the api serves at `pathname`, after checking that the web server sends the path to the api and that the
 * answer is one of the files scripts/brand-icons.ts makes (the first test ties those to the masters).
 */
async function served(pathname: string): Promise<Buffer> {
  assert.ok(isApiOwned(pathname), `${pathname} is routed to the api`);
  const res = await app.inject(pathname);
  assert.equal(res.statusCode, 200, pathname);
  assert.match(String(res.headers["content-type"]), /^image\//, pathname);
  assert.ok(
    Object.keys(renders).some((file) => readFileSync(path.join(BRAND, file)).equals(res.rawPayload)),
    `${pathname} serves a file scripts/brand-icons.ts makes`,
  );
  return res.rawPayload;
}

/** The PNG pictures in an icon file: the file itself, or each entry behind an ICO directory. */
function pictures(body: Buffer): Buffer[] {
  if (body.readUInt16LE(0) !== 0 || body.readUInt16LE(2) !== 1) return [body];
  return Array.from({ length: body.readUInt16LE(4) }, (_, i) => {
    const entry = 6 + 16 * i;
    const picture = body.subarray(body.readUInt32LE(entry + 12), body.readUInt32LE(entry + 12) + body.readUInt32LE(entry + 8));
    assert.equal(picture.readUInt32BE(16), body.readUInt8(entry) || 256, "the ICO directory names each entry's size");
    return picture;
  });
}

/** The side of each picture in an icon file, checking that each is a square PNG. */
async function sides(body: Buffer): Promise<number[]> {
  return Promise.all(
    pictures(body).map(async (picture) => {
      const { format, width, height } = await sharp(picture).metadata();
      assert.equal(format, "png");
      assert.equal(width, height, "square");
      return width;
    }),
  );
}

/** A `sizes` attribute ("16x16 32x32") as the sides of its squares. */
const declared = (sizes: string) =>
  sizes.split(" ").map((size) => {
    const [width, height] = size.split("x").map(Number);
    assert.equal(width, height, `${size} is square`);
    return width!;
  });

test("every icon file is what scripts/brand-icons.ts renders from the galaxy masters", async () => {
  for (const [file, render] of Object.entries(renders)) {
    const committed = readFileSync(path.join(BRAND, file));
    if (file.endsWith(".svg")) {
      assert.equal(committed.toString(), render.toString(), file);
      continue;
    }
    assert.deepEqual(await sides(committed), await sides(render), file);
    const [ours, theirs] = [pictures(committed), pictures(render)];
    for (const [i, picture] of ours.entries()) {
      // Pixels, not bytes: another build of the renderer may round a few edge pixels slightly differently.
      const a = await sharp(picture).ensureAlpha().raw().toBuffer();
      const b = await sharp(theirs[i]!).ensureAlpha().raw().toBuffer();
      assert.equal(a.length, b.length, file);
      let off = 0;
      for (let j = 0; j < a.length; j += 4) if ([0, 1, 2, 3].some((k) => Math.abs(a[j + k]! - b[j + k]!) > 8)) off++;
      assert.ok(off <= a.length / 4 / 100, `${file}: ${off} of ${a.length / 4} pixels differ from the render of the masters`);
    }
  }
});

test("the page head declares the favicon, PNG icons at multiples of 48 px and the touch icon, each at its served size", async () => {
  for (const link of ICON_LINKS) assert.deepEqual(await sides(await served(link.href)), declared(link.sizes), link.href);
  // Tabs: the small mark at 16, 32 and 48 px.
  assert.deepEqual(await sides(await served("/favicon.ico")), [16, 32, 48]);
  assert.equal(ICON_LINKS[0].href, "/favicon.ico");
  // Search results: Google recommends square favicons larger than 48 px (its older rule: a multiple of 48 px).
  const png = ICON_LINKS.filter((link) => link.rel === "icon" && "type" in link && link.type === "image/png");
  assert.ok(png.length > 0 && png.every((link) => declared(link.sizes).every((side) => side > 48 && side % 48 === 0)));
  // Apple: 180 px and opaque; Safari and link previews also try the default addresses without reading the page.
  const touch = ICON_LINKS.filter((link) => link.rel === "apple-touch-icon");
  assert.equal(touch.length, 1);
  const touchIcon = await served(touch[0]!.href);
  assert.deepEqual(await sides(touchIcon), [180]);
  assert.equal((await sharp(touchIcon).metadata()).hasAlpha, false, "the touch icon is opaque");
  for (const alias of ["/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"]) assert.deepEqual(await served(alias), touchIcon, alias);
});

test("the web manifest lists the 192 and 512 px app icons and a maskable square that keeps the mark in its safe zone", async () => {
  const res = await app.inject("/manifest.webmanifest");
  assert.equal(res.statusCode, 200);
  const { icons } = res.json() as { icons: Array<{ src: string; sizes: string; type: string; purpose?: string }> };
  for (const icon of icons) {
    assert.equal(icon.type, "image/png", icon.src);
    assert.deepEqual(await sides(await served(icon.src)), declared(icon.sizes), icon.src);
  }
  const purposes = (icon: { purpose?: string }) => (icon.purpose ?? "any").split(" ");
  const any = icons.filter((icon) => purposes(icon).includes("any")).map((icon) => icon.sizes);
  assert.ok(any.includes("192x192") && any.includes("512x512"), "Chrome's install sizes");
  const maskable = icons.filter((icon) => purposes(icon).includes("maskable"));
  assert.equal(maskable.length, 1);
  // A launcher may cut away everything outside the centre circle of 80%: only the ivory ground lies there, and no
  // pixel is transparent.
  const { data, info } = await sharp(await served(maskable[0]!.src))
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 3, "opaque");
  let darkest = 255;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      if (Math.hypot(x + 0.5 - info.width / 2, y + 0.5 - info.height / 2) <= 0.4 * info.width) continue;
      const at = (y * info.width + x) * 3;
      darkest = Math.min(darkest, data[at]!, data[at + 1]!, data[at + 2]!);
    }
  assert.ok(darkest >= 200, `only the ivory ground outside the safe zone (darkest channel ${darkest})`);
});

test("the RSS channel image and the Organization logo are served icons of the sizes their readers want", async () => {
  assert.ok(FEED_IMAGE.size <= 144, "RSS 2.0 allows a channel image at most 144 px wide");
  assert.deepEqual(await sides(await served(FEED_IMAGE.path)), [FEED_IMAGE.size]);
  const [logo] = await sides(await served(LOGO_PATH));
  assert.ok(logo! >= 112, "Google wants an Organization logo of at least 112 px");
});
