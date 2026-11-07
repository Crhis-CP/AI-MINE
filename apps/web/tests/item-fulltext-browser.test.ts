// Run after `npm run build --workspace @amp/web`. The article page keeps the AI 导读 and adds the full original and its
// full Chinese translation below it (TASK-0569; Owner 2026-11-07, DEC-78补充·新闻原文全文与中文译文), on the production
// web server with a synthetic read-only API: 中文译文 by default, 原文 on its own address, the original while the
// translation is being made, a Chinese original on its own, and the copyright/translation note under every body.
// Chinese and English interface, desktop and a 390px phone. No external network or accounts.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { chromium, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { browserExecutable, isolateBrowser } from "./browser.ts";
import { webEnvironment } from "../runtime-env.ts";

let browser: Browser,
  web: ChildProcess,
  origin = "";
const now = Date.now();
const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
const GUIDE = "合成导读：智利一座铜矿扩建获批，产能提高三成。";
const NOTE = "中文为 AI 翻译，仅供参考，以原文为准；版权归原作者或来源所有。";
const LONG_WORD = "Supercalifragilisticexpialidociouscopperconcentrate".repeat(3);

const base = (id: string) => ({
  id,
  title: `合成铜矿扩建 ${id}`,
  summary: GUIDE,
  reason: null,
  publishedAt: ago(2),
  timelineAt: ago(2),
  category: "project_development",
  tags: [],
  score: null,
  selected: false,
  channel: "news",
  revision: 1,
  originalTitle: "Copper mine expansion approved",
  source: { id: "fixture-media", name: "合成矿业媒体", kind: "rss", firstParty: false },
  links: { original: `https://example.invalid/${id}` },
  discoveredAt: ago(1),
  story: null,
  readingMode: "full",
  author: "Jane Example",
  language: "en",
  outline: [],
  relatedStories: [],
  indexable: true,
  group: null,
});
/** The site API sends one language per page: /items/:id the Chinese, /items/:id/original the original. */
function detail(id: string, original: boolean) {
  if (id === "translated")
    return {
      ...base(id),
      readingState: "available",
      hasTranslation: true,
      bodyLanguage: original ? "original" : "zh",
      body: original
        ? { zh: null, original: `<p>ORIGINAL TEXT: the expansion was approved. ${LONG_WORD}</p>`, zhKind: "translation", complete: true }
        : { zh: "<p>中文译文：扩建已获批准。</p>", original: null, zhKind: "translation", complete: true },
    };
  if (id === "pending")
    return {
      ...base(id),
      readingState: original ? "available" : "pending",
      hasTranslation: false,
      bodyLanguage: "original",
      body: { zh: null, original: "<p>PENDING ORIGINAL: the expansion was approved.</p>", zhKind: null, complete: false },
    };
  if (id === "native")
    return {
      ...base(id),
      author: null,
      originalTitle: null,
      language: "zh-CN",
      readingState: "available",
      hasTranslation: false,
      bodyLanguage: "zh",
      body: { zh: "<p>中文原文：扩建已获批准。</p>", original: null, zhKind: "original", complete: true },
    };
  return null;
}

const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://fixture");
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  const send = (value: unknown) => res.end(JSON.stringify(value));
  const path = url.pathname;
  if (path === "/api/site/meta") return send({ changelogVersion: null });
  if (path === "/api/site/content-version") return send({ version: "1", withdrawalVersion: "1" });
  if (path === "/api/site/jurisdictions") return send([]);
  if (path === "/api/site/items/availability")
    return send(
      Object.fromEntries(
        (url.searchParams.get("ids") ?? "")
          .split(",")
          .filter(Boolean)
          .map((id) => [id, "public"]),
      ),
    );
  const match = /^\/api\/site\/items\/([a-z]+)(\/original)?$/.exec(path);
  const found = match ? detail(match[1]!, !!match[2]) : null;
  if (found) return send(found);
  res.statusCode = 404;
  send({ code: "not_found" });
});

before(async () => {
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  web = spawn(process.execPath, ["apps/web/server.ts"], {
    env: webEnvironment({
      PATH: process.env.PATH,
      NODE_ENV: "production",
      WEB_PORT: "0",
      WEB_HOST: "127.0.0.1",
      PRIVATE_HOST: "private.localhost",
      TRUST_PROXY: "false",
      API_BASE_URL: apiBase,
      PRIVATE_API_BASE_URL: apiBase,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    let log = "";
    const timer = setTimeout(() => reject(new Error(log)), 15000);
    const read = (chunk: Buffer) => {
      log += chunk;
      const found = log.match(/"msg":"web started","port":(\d+)/);
      if (found) {
        origin = `http://127.0.0.1:${found[1]}`;
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

async function open(width: number): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  await isolateBrowser(context, [origin]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { context, page, errors };
}
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

test("the AI guide stays and the body below it offers 中文译文 and 原文 with the copyright note", { timeout: 60000 }, async () => {
  for (const width of [1280, 390]) {
    const { context, page, errors } = await open(width);
    try {
      await page.goto(`${origin}/items/translated`);
      const main = page.locator("main");
      await expect(main.getByText("AI 导读", { exact: true })).toBeVisible();
      await expect(main.getByText(GUIDE)).toBeVisible();
      const body = page.locator("#article-body");
      const tabs = body.getByRole("tablist", { name: "正文语言" }).or(body.getByRole("navigation", { name: "正文语言" }));
      await expect(tabs.getByText("中文译文")).toBeVisible();
      await expect(tabs.getByText("原文", { exact: true })).toBeVisible();
      await expect(body.getByText("中文译文：扩建已获批准。")).toBeVisible();
      // The guide comes first, the body below it.
      const guideBox = (await main.getByText(GUIDE).boundingBox())!;
      const bodyBox = (await body.boundingBox())!;
      assert.ok(guideBox.y < bodyBox.y, "the AI guide is above the body");
      const note = body.locator("[data-body-notice]");
      await expect(note).toContainText("合成矿业媒体");
      await expect(note).toContainText("作者：Jane Example");
      await expect(note).toContainText(NOTE);
      await expect(note.getByRole("link", { name: "查看原文" })).toHaveAttribute("href", "https://example.invalid/translated");
      assert.ok((await overflow(page)) <= 1, `no sideways scroll at ${width}px`);

      await tabs.getByText("原文", { exact: true }).click();
      await expect(page).toHaveURL(`${origin}/items/translated/original`);
      await expect(body.getByText(/ORIGINAL TEXT/)).toBeVisible();
      await expect(note).toContainText(NOTE);
      assert.ok((await overflow(page)) <= 1, `no sideways scroll on the original at ${width}px`);
      await page.screenshot({ path: `.verify/item-fulltext-${width}.png`, fullPage: true });
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
});

test("a pending translation shows the original with a note; a Chinese original shows only itself", { timeout: 60000 }, async () => {
  const { context, page, errors } = await open(390);
  try {
    await page.goto(`${origin}/items/pending`);
    await expect(page.getByText(GUIDE)).toBeVisible();
    const body = page.locator("#article-body");
    await expect(body.locator("[data-translation-pending]")).toHaveText("中文译文生成中，先为你显示原文。");
    await expect(body.getByText(/PENDING ORIGINAL/)).toBeVisible();
    await expect(body.locator("[data-body-notice]")).toContainText(NOTE);
    await expect(page.getByText("按来源许可，本站提供中文导读和原文链接。")).toHaveCount(0);
    await expect(page.getByText("正文正在补齐")).toHaveCount(0);
    assert.ok((await overflow(page)) <= 1);

    await page.goto(`${origin}/items/native`);
    const native = page.locator("#article-body");
    await expect(native.getByText("中文原文：扩建已获批准。")).toBeVisible();
    await expect(native.getByText("正文 · 原文")).toBeVisible();
    await expect(native.getByText("中文译文")).toHaveCount(0);
    await expect(native.locator("[data-translation-pending]")).toHaveCount(0);
    await expect(native.locator("[data-body-notice]")).toContainText("版权归原作者或来源所有。");
    await expect(native.locator("[data-body-notice]")).not.toContainText("AI 翻译");
    await expect(native.locator("[data-body-notice]")).not.toContainText("作者：");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("the English interface names the tabs, the pending note and the copyright note in English", { timeout: 60000 }, async () => {
  const { context, page, errors } = await open(390);
  try {
    await page.goto(`${origin}/en/items/translated`);
    const body = page.locator("#article-body");
    await expect(body.getByText("Chinese translation")).toBeVisible();
    await expect(body.locator("[data-body-notice]")).toContainText(
      "The Chinese is an AI translation for reference only; the original prevails. Copyright belongs to the original author or source.",
    );
    await expect(body.locator("[data-body-notice]")).toContainText("Author: Jane Example");
    await expect(body.locator("[data-body-notice]").getByRole("link", { name: "View the original" })).toBeVisible();
    await page.goto(`${origin}/en/items/pending`);
    await expect(page.locator("[data-translation-pending]")).toHaveText("The Chinese translation is being made; the original is shown for now.");
    assert.ok((await overflow(page)) <= 1);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
