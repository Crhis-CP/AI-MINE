// What the first visit to the busiest reader pages downloads (TASK-0715, architecture audit R7/R8): the scripts and
// style sheets a page links before it can run, compressed, stay under a ceiling; page-specific styles and the phone
// search layer stay out of that first download. Reads the build output: run after `npm run build -w @amp/web`.
// Sizes are gzip -9 of each file, which tracks but does not equal what the edge sends.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "node:test";

type Route = { id: string; parentId?: string; path?: string; module: string; imports?: string[]; css?: string[] };
type Manifest = { entry: { module: string; imports: string[] }; routes: Record<string, Route> };
type Weight = { jsRaw: number; jsGzip: number; cssRaw: number; cssGzip: number; files: string[] };

const BUILD = path.join(import.meta.dirname, "../build");

/**
 * Ceilings: the size measured on 2026-11-14 after the style split and the lazy search layer, plus about 10%. The style
 * sheet has its own ceiling, so the page styles moved out cannot drift back inside the scripts' headroom.
 * Measured (gzip bytes, scripts + styles): / 213361 + 19013; /items/:id 214868 + 19013; /hot 210938 + 19013.
 */
const CEILINGS = {
  "routes/home": { label: "/", total: 256_000 },
  "routes/item": { label: "/items/:id", total: 258_000 },
  "routes/hot": { label: "/hot", total: 253_000 },
} as const;
const CSS_CEILING = 21_000;

const client = (group: "public" | "private") => path.join(BUILD, group, "client");
function manifest(group: "public" | "private"): Manifest {
  const assets = path.join(client(group), "assets");
  assert.ok(existsSync(assets), `no ${group} build: run npm run build --workspace @amp/web first`);
  const files = readdirSync(assets).filter((file) => /^manifest-[\w-]+\.js$/.test(file));
  assert.equal(files.length, 1, `${group}: one route manifest`);
  const text = readFileSync(path.join(assets, files[0]!), "utf8");
  const prefix = "window.__reactRouterManifest=";
  assert.ok(text.startsWith(prefix) && text.endsWith(";"), `${group}: manifest wrapper`);
  return JSON.parse(text.slice(prefix.length, -1)) as Manifest;
}

/** The entry, then every route from the root down to `id`, with the modules and sheets each one links. */
function firstLoad(built: Manifest, id: string, read: (file: string) => Buffer): Weight {
  const chain: Route[] = [];
  for (let route: Route | undefined = built.routes[id]; route; route = route.parentId ? built.routes[route.parentId] : undefined) chain.unshift(route);
  assert.ok(chain.length, `route ${id} is in the manifest`);
  const js = new Set([built.entry.module, ...built.entry.imports]);
  const css = new Set<string>();
  for (const route of chain) {
    js.add(route.module);
    for (const file of route.imports ?? []) js.add(file);
    for (const file of route.css ?? []) css.add(file);
  }
  const weigh = (files: Set<string>) =>
    [...files].reduce(
      ([raw, gzip], file) => {
        const bytes = read(file);
        return [raw + bytes.length, gzip + gzipSync(bytes, { level: 9 }).length];
      },
      [0, 0],
    );
  const [jsRaw, jsGzip] = weigh(js);
  const [cssRaw, cssGzip] = weigh(css);
  return { jsRaw, jsGzip, cssRaw, cssGzip, files: [...js, ...css] };
}

const readPublic = (file: string) => readFileSync(path.join(client("public"), file));

test("the home, article and hot pages stay under their first-load ceilings", (t) => {
  const built = manifest("public");
  for (const [id, { label, total }] of Object.entries(CEILINGS)) {
    const weight = firstLoad(built, id, readPublic);
    t.diagnostic(
      `${label}: scripts ${weight.jsRaw} B (gzip ${weight.jsGzip}), styles ${weight.cssRaw} B (gzip ${weight.cssGzip}), ` +
        `total gzip ${weight.jsGzip + weight.cssGzip} of ${total}, ${weight.files.length} files`,
    );
    assert.ok(weight.jsGzip + weight.cssGzip <= total, `${label}: ${weight.jsGzip + weight.cssGzip} gzip bytes exceed ${total}`);
    assert.ok(weight.cssGzip <= CSS_CEILING, `${label}: styles ${weight.cssGzip} gzip bytes exceed ${CSS_CEILING}`);
    assert.ok(!weight.files.some((file) => /\/SearchPanel-[\w-]+\.js$/.test(file)), `${label}: the search layer is in the first download`);
  }
});

test("the phone search layer is its own chunk, loaded on first open", () => {
  const assets = readdirSync(path.join(client("public"), "assets"));
  assert.equal(assets.filter((file) => /^SearchPanel-[\w-]+\.js$/.test(file)).length, 1);
});

test("regulation and changelog styles travel with their pages; admin styles stay in the admin build", () => {
  const built = manifest("public");
  const sheets = (id: string) => firstLoad(built, id, readPublic).files.filter((file) => file.endsWith(".css"));
  // The admin build is served under /admin/, so its manifest names files with that prefix.
  const text = (group: "public" | "private", file: string) => readFileSync(path.join(client(group), file.replace(/^\/admin\//, "/")), "utf8");
  const [root] = built.routes.root!.css ?? [];
  assert.ok(root, "the public root links its sheet");
  const site = text("public", root);
  for (const marker of [".pr-page", ".flow-screen", ".notice-sheen", ".admin-night"]) assert.ok(!site.includes(marker), `site sheet carries ${marker}`);
  const policy = sheets("routes/policy").filter((file) => file !== root);
  const about = sheets("routes/about").filter((file) => file !== root);
  const changelog = sheets("routes/changelog").filter((file) => file !== root);
  assert.equal(policy.length, 1);
  assert.equal(changelog.length, 1);
  assert.match(text("public", changelog[0]!), /\[data-theme=dark\] \.flow-screen\{/);
  assert.match(text("public", changelog[0]!), /@media \(prefers-reduced-motion:reduce\)\{[^}]*\.flow-comet/);
  // The About page went back to its earlier version (Owner 2026-11-14), which needs nothing beyond the site sheet.
  assert.deepEqual(about, []);
  assert.match(text("public", policy[0]!), /\[data-theme=dark\] \.pr-page\{/);
  assert.match(text("public", policy[0]!), /@container pr \(width>=840px\)/);
  for (const id of Object.keys(CEILINGS)) assert.deepEqual(sheets(id), [root], `${id} links only the site sheet`);

  const admin = manifest("private");
  const [adminRoot] = admin.routes.root!.css ?? [];
  assert.ok(adminRoot, "the admin root links its sheet");
  const adminSheet = text("private", adminRoot);
  assert.ok(adminSheet.includes(".admin-night{"), "admin sheet keeps the night-and-gold look");
  for (const marker of [".pr-page", ".flow-screen"]) assert.ok(!adminSheet.includes(marker), `admin sheet carries ${marker}`);
});
