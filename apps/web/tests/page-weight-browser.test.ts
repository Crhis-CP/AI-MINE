// What a reader's first visit downloads (TASK-0593): the logo cut the theme hides is never fetched, body pictures
// after the first wait until the reader scrolls near them, and Chinese pages carry no English phrase list while the
// English interface still gets it. Run after `npm run build -w @amp/web`. Production web, synthetic read-only API.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { chromium, expect, type Browser } from "@playwright/test";
import { lazyBodyImages } from "../app/lib/body-images.ts";
import { PHRASES } from "../app/i18n/phrases.ts";
import { browserExecutable, isolateBrowser } from "./browser.ts";
import { webEnvironment } from "../runtime-env.ts";

let browser: Browser,
  web: ChildProcess,
  origin = "";
const now = new Date().toISOString();
/** A phrase only the English phrase list holds (the Chinese key is shown on Chinese pages). */
const ENGLISH_ONLY = PHRASES.暂时无法确认最新内容;
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const card = (id: string) => ({
  id,
  title: `合成动态 ${id}`,
  summary: "合成导读",
  reason: null,
  publishedAt: now,
  timelineAt: now,
  category: null,
  tags: [],
  score: null,
  selected: false,
  channel: "news",
  source: { name: "合成来源" },
});
const picture = (n: number) => `<p><img src="/api/fixture-picture/${n}" alt="合成配图 ${n}" width="300" height="200"></p>`;
const item = {
  ...card("weight-item"),
  revision: 1,
  originalTitle: null,
  source: { id: "fixture-source", name: "合成来源", kind: "web_list", firstParty: true },
  links: { original: "https://example.invalid/source" },
  discoveredAt: now,
  story: null,
  readingMode: "full",
  author: null,
  language: "zh",
  body: { zh: `<p>合成正文</p>${[1, 2, 3].map(picture).join("<p>合成段落</p>")}`, original: null, zhKind: "original", complete: true },
  outline: [],
  relatedStories: [],
  indexable: false,
  group: null,
  hasTranslation: false,
  bodyLanguage: "zh",
};

const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://fixture");
  const send = (value: unknown) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(value));
  };
  if (url.pathname.startsWith("/api/fixture-picture/")) {
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(PIXEL);
  }
  if (url.pathname === "/api/site/meta") return send({ changelogVersion: null });
  if (url.pathname === "/api/site/content-version") return send({ version: "1", withdrawalVersion: "1" });
  if (url.pathname === "/api/site/jurisdictions") return send([]);
  if (url.pathname === "/api/site/items/availability") return send({});
  if (url.pathname === "/api/site/pool")
    return send({
      filters: { channel: "all", category: null, tag: null, topic: null, jurisdiction: null, q: null, tab: "time" },
      items: [card("weight-a")],
      hot: [],
      facets: { sources: [], minerals: [] },
      page: 1,
      pageCount: 1,
      total: 1,
      todayCount: 1,
      freshness: now,
      generatedAt: now,
    });
  if (url.pathname === "/api/site/items/weight-item") return send(item);
  res.statusCode = 404;
  send({ code: "not_found" });
});

before(async () => {
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  web = spawn(process.execPath, ["apps/web/server.ts"], {
    env: webEnvironment({
      PATH: process.env.PATH,
      NODE_ENV: "production",
      WEB_PORT: "0",
      WEB_HOST: "127.0.0.1",
      PRIVATE_HOST: "private.localhost",
      TRUST_PROXY: "false",
      API_BASE_URL: base,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    let log = "";
    const timer = setTimeout(() => reject(new Error(log)), 15000);
    const read = (chunk: Buffer) => {
      log += chunk;
      const match = log.match(/"msg":"web started","port":(\d+)/);
      if (match) {
        origin = `http://127.0.0.1:${match[1]}`;
        clearTimeout(timer);
        resolve();
      }
    };
    web.stdout!.on("data", read);
    web.stderr!.on("data", read);
    web.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(log));
    });
  });
  browser = await chromium.launch({
    headless: true,
    executablePath: browserExecutable(),
    args: ["--disable-background-networking", "--disable-component-update"],
  });
});

after(async () => {
  await browser?.close();
  if (web && web.exitCode === null) {
    web.kill("SIGTERM");
    await once(web, "exit");
  }
  api.closeAllConnections();
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

/** Opens a page in a fresh browser and returns what it fetched (address and, for scripts, the text). */
async function visit(path: string, colorScheme: "light" | "dark" = "light") {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme, reducedMotion: "reduce" });
  const blocked = await isolateBrowser(context, [origin]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // React reports a hydration that had to start over as a console error.
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(message.text());
  });
  const fetched: string[] = [];
  const scripts: string[] = [];
  page.on("response", async (response) => {
    const at = new URL(response.url());
    fetched.push(at.pathname);
    if (at.pathname.endsWith(".js")) scripts.push(await response.text().catch(() => ""));
  });
  await page.goto(origin + path, { waitUntil: "networkidle" });
  return { context, page, errors, blocked, fetched, scripts };
}

test("body pictures after the first are marked lazy; one the body already marks keeps its setting", () => {
  assert.equal(
    lazyBodyImages('<p><img src="a"></p><IMG src="b"><img loading="eager" src="c"><imgx><img/>'),
    '<p><img src="a"></p><IMG loading="lazy" decoding="async" src="b"><img loading="eager" src="c"><imgx><img loading="lazy" decoding="async"/>',
  );
  assert.equal(lazyBodyImages("<p>没有图片</p>"), "<p>没有图片</p>");
  assert.equal(
    lazyBodyImages('<img loading="eager" src="a"><img src="b">'),
    '<img loading="eager" src="a"><img loading="lazy" decoding="async" src="b">',
    "a first picture with its own setting still counts as the first",
  );
});

test("an article page renders its first body picture eagerly and the rest lazily", async () => {
  const html = await (await fetch(`${origin}/items/weight-item`)).text();
  const pictures = [...html.matchAll(/<img[^>]*fixture-picture[^>]*>/g)].map((match) => match[0]);
  assert.equal(pictures.length, 3);
  assert.doesNotMatch(pictures[0]!, /loading=/);
  for (const tag of pictures.slice(1)) assert.match(tag, /loading="lazy"/);
});

test("the logo cut the theme hides is never downloaded; the shown one loads", async () => {
  for (const [scheme, shown, hidden] of [
    ["light", /\/assets\/lockup-[\w-]+\.svg$/, /\/assets\/lockup-dark-/],
    ["dark", /\/assets\/lockup-dark-/, /\/assets\/lockup-(?!dark-|small-)[\w-]+\.svg$/],
  ] as const) {
    const { context, page, errors, blocked, fetched } = await visit("/all", scheme);
    try {
      const logo = page.locator("header [role=img] img:visible").first();
      await expect(logo).toBeVisible();
      await expect.poll(() => logo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
      assert.ok(
        fetched.some((path) => shown.test(path) && !/lockup-small-/.test(path)),
        `${scheme}: shown cut fetched`,
      );
      assert.ok(!fetched.some((path) => hidden.test(path)), `${scheme}: hidden cut not fetched: ${fetched.filter((p) => p.includes("lockup")).join(", ")}`);
      assert.deepEqual(errors, []);
      assert.deepEqual(blocked, []);
    } finally {
      await context.close();
    }
  }
});

test("Chinese pages carry no English phrase list; the English interface still shows its phrases", async () => {
  const zh = await visit("/all");
  try {
    assert.ok(zh.scripts.length > 3);
    assert.ok(!zh.scripts.some((text) => text.includes(ENGLISH_ONLY)), "a Chinese page downloaded the English phrases");
    await expect(zh.page.locator('button[aria-label="回到顶部"]')).toHaveCount(1);
    // Switching language in the page fetches the list first, then shows the English page (no reload).
    await zh.page.evaluate(() => Object.assign(window, { stayed: true }));
    await zh.page.locator('a[hreflang="en"]:visible').first().click();
    await expect(zh.page).toHaveURL(/\/en\/all$/);
    await expect(zh.page.locator('button[aria-label="Back to top"]')).toHaveCount(1);
    assert.equal(await zh.page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed), true);
    assert.ok(zh.scripts.some((text) => text.includes(ENGLISH_ONLY)));
    assert.deepEqual(zh.errors, []);
  } finally {
    await zh.context.close();
  }
  // Opened directly, an English page is rendered in English by the server and stays so once the browser takes over.
  const en = await visit("/en/all");
  try {
    assert.ok(
      en.scripts.some((text) => text.includes(ENGLISH_ONLY)),
      "the English page has its phrases",
    );
    await expect(en.page.locator("html")).toHaveAttribute("lang", "en");
    await expect(en.page.locator('button[aria-label="Back to top"]')).toHaveCount(1);
    await expect
      .poll(() =>
        en.page
          .locator("#main a[href]")
          .first()
          .evaluate((link) => Object.keys(link).some((key) => key.startsWith("__reactProps"))),
      )
      .toBe(true);
    await expect(en.page.locator('button[aria-label="Back to top"]')).toHaveCount(1);
    assert.deepEqual(en.errors, []);
    assert.deepEqual(en.blocked, []);
  } finally {
    await en.context.close();
  }
});
