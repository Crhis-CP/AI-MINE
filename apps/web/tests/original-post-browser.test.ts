// Synthetic permitted projections, real router and CSP; no remote media, accounts or models.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { chromium, expect, type Browser } from "@playwright/test";
import { browserExecutable, isolateBrowser } from "./browser.ts";
import { webEnvironment } from "../runtime-env.ts";

let origin = "",
  web: ChildProcess,
  browser: Browser;
const now = "2026-10-26T12:00:00Z";
const legacy = {
  id: "legacy",
  title: "普通矿业文章",
  summary: "普通中文导读",
  reason: null,
  source: { name: "合成来源" },
  publishedAt: now,
  timelineAt: now,
  category: null,
  tags: [],
  score: null,
  selected: false,
  channel: "news",
};
const picture = (name: string) => ({
  kind: "image" as const,
  url: `/api/site/fixture-media/${name}.svg`,
  width: 320,
  height: 240,
  alt: `合成矿山${name}`,
  poster: null,
});
const quoted = { authorName: "被引作者", handle: "quoted", text: '<img src=x onerror="window.injected=true">原帖引用', translation: "已提供的引用译文" };
const post = {
  authorName: "合成原帖作者",
  handle: "mining",
  avatarUrl: "https://unavailable.invalid/avatar.png",
  media: [
    {
      ...picture("一"),
      fullUrl: "/api/site/fixture-media/full.svg",
      srcSet: "/api/site/fixture-media/一.svg 320w, https://unavailable.invalid/picture.png 640w",
    },
    { ...picture("二"), fullUrl: "/api/site/fixture-media/missing.svg" },
    { ...picture("视频"), kind: "video" as const, poster: "/api/site/fixture-media/poster.svg" },
    { ...picture("外部"), url: "https://unavailable.invalid/picture.png" },
    picture("missing"),
  ],
  quoted,
};
post.media.push({ ...post.media[0]! });
const detail = (id: string, original: boolean) => ({
  ...legacy,
  id,
  revision: 1,
  title: id === "legacy" ? legacy.title : "原帖阅读合成样例",
  originalTitle: null,
  source: { ...legacy.source, id: "fixture", kind: "rss", firstParty: true },
  links: { original: "https://example.invalid/original-post" },
  discoveredAt: now,
  story: null,
  readingMode: "full",
  readingState: "available",
  author: null,
  language: "en",
  body:
    id === "quote-only"
      ? null
      : { zh: original ? null : "<p>单份中文正文</p>", original: original ? "<p>Single original body</p>" : null, zhKind: "translation", complete: false },
  outline: [],
  relatedStories: [],
  indexable: false,
  group: null,
  hasTranslation: id !== "quote-only",
  bodyLanguage: original ? "original" : "zh",
  ...(id === "legacy"
    ? {}
    : { x: { ...post, quoted: { ...quoted, translation: id === "untranslated" ? null : quoted.translation, url: "https://example.invalid/quoted" } } }),
});
const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://fixture");
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  const send = (value: unknown) => res.end(JSON.stringify(value));
  if (url.pathname.startsWith("/api/site/fixture-media/")) {
    if (url.pathname.endsWith("/missing.svg")) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader("content-type", "image/svg+xml");
    return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="gray"/></svg>');
  }
  if (url.pathname === "/api/site/meta") return send({ changelogVersion: null });
  if (url.pathname === "/api/site/content-version") return send({ version: "1", withdrawalVersion: "1" });
  if (url.pathname === "/api/site/jurisdictions") return send([]);
  if (url.pathname === "/api/site/pool")
    return send({
      filters: { channel: "all", category: null, tag: null, q: null, tab: "time" },
      items: [legacy, { ...legacy, id: "post", title: "原帖卡片", x: post }],
      page: 1,
      pageCount: 1,
      total: 2,
      todayCount: 2,
      freshness: now,
      generatedAt: now,
    });
  if (url.pathname.startsWith("/api/site/items/")) return send(detail(url.pathname.split("/")[4]!, url.pathname.endsWith("/original")));
  res.statusCode = 404;
  send({ code: "not_found" });
});
before(async () => {
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  web = spawn(process.execPath, ["apps/web/server.ts"], {
    env: webEnvironment({
      PATH: process.env.PATH,
      NODE_ENV: "production",
      WEB_PORT: "0",
      WEB_HOST: "127.0.0.1",
      PRIVATE_HOST: "private.localhost",
      TRUST_PROXY: "false",
      API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(output)), 15000);
    const read = (chunk: Buffer) => {
      output += chunk;
      const match = output.match(/"msg":"web started","port":(\d+)/);
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
      reject(new Error(output));
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

for (const width of [390, 1440])
  test(`permitted post cards and single-language details at ${width}px`, { timeout: 40000 }, async () => {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
    const blocked = await isolateBrowser(context, [origin]);
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/all`);
      const card = page.locator('article[data-item-id="post"]');
      await expect(page.locator('article[data-item-id="legacy"] h3')).toHaveText(legacy.title);
      await expect(page.locator('article[data-item-id="legacy"] figure')).toHaveCount(0);
      await expect(card.getByText("合成原帖作者")).toBeVisible();
      await expect(card.getByText("@mining")).toBeVisible();
      await expect(card.locator("blockquote")).toHaveText(quoted.translation);
      await expect(card.getByRole("link", { name: "打开被引用的原帖" })).toHaveCount(0);
      await expect(card.getByText("查看全部 5 项媒体")).toBeVisible();
      await expect(card.getByRole("button", { name: "查看大图：合成矿山一" })).toHaveCount(1);
      await expect(card.getByRole("link", { name: "媒体暂不可用，查看原帖" })).toHaveAttribute("href", "/items/post");
      await card.getByRole("button", { name: "查看大图：合成矿山一" }).click();
      await expect(card.getByRole("dialog")).toBeVisible();
      await expect(card.getByRole("dialog").locator("img")).toHaveAttribute("src", "/api/site/fixture-media/full.svg");
      await page.keyboard.press("ArrowRight");
      await expect(card.getByRole("dialog").locator("img")).toHaveAttribute("alt", "合成矿山二");
      await expect(card.getByRole("dialog").locator("img")).toHaveJSProperty("src", new URL("/api/site/fixture-media/二.svg", origin).href);
      await expect(card.getByRole("dialog").locator("img")).toHaveJSProperty("naturalWidth", 320);
      await page.keyboard.press("Escape");
      await expect(card.getByRole("dialog")).not.toBeVisible();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

      await card.getByRole("link", { name: "原帖卡片", exact: true }).click();
      await expect(page.locator("#article-body .prose")).toHaveText("单份中文正文");
      await expect(page.locator("blockquote")).toHaveText(quoted.translation);
      await expect(page.getByText("译文尚不完整，完整内容请切换到原文。")).toBeVisible();
      await expect(page.getByRole("link", { name: "打开被引用的原帖" })).toHaveAttribute("href", "https://example.invalid/quoted");
      await expect(page.getByText("中文内容由 AI 辅助生成或翻译", { exact: false })).toBeVisible();
      await expect(page.getByRole("link", { name: "媒体暂不可用，打开原文查看", exact: true })).toHaveCount(2);
      await expect(page.getByRole("link", { name: "在原文播放视频" })).toHaveAttribute("href", "https://example.invalid/original-post");
      await page.getByRole("link", { name: "原文", exact: true }).click();
      await expect(page.locator("#article-body .prose")).toHaveText("Single original body");
      await expect(page.locator("blockquote")).toHaveText(quoted.text);
      await expect(page.locator('img[src="x"]')).toHaveCount(0);
      assert.equal(await page.evaluate(() => "injected" in window), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

      await page.goto(`${origin}/items/untranslated`);
      await expect(page.locator("figure figcaption")).toContainText("引用 · 原文");
      await expect(page.locator("blockquote")).toHaveText(quoted.text);
      await page.goto(`${origin}/items/quote-only`);
      await page.getByRole("link", { name: "原文", exact: true }).click();
      await expect(page.locator("blockquote")).toHaveText(quoted.text);
      await expect(page.locator("#article-body .prose")).toHaveCount(0);
      await page.goto(`${origin}/items/legacy`);
      await expect(page.locator("#article-body .prose")).toHaveText("单份中文正文");
      await expect(page.locator("figure")).toHaveCount(0);
      assert.deepEqual(blocked, []);
    } finally {
      await context.close();
    }
  });
