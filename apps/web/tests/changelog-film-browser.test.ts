// The changelog film (TASK-0367, Owner 2026-11-21: “点开能看”): the player and Three.js load only when a reader presses
// play; Space plays and pauses, Esc closes and gives focus back; closing frees the canvas, five times over; with reduced
// motion the button leads to the storyboard and nothing is loaded; the storyboard's country switch does not move the
// page; the price line answers the arrow keys with real published points. Run after `npm run build -w @amp/web`.
// Production web, synthetic read-only API; the browser draws WebGL in software (SwiftShader).
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { chromium, type Browser, type BrowserContextOptions } from "@playwright/test";
import { browserExecutable, isolateBrowser } from "./browser.ts";
import { webEnvironment } from "../runtime-env.ts";

let browser: Browser,
  web: ChildProcess,
  origin = "";
const now = new Date().toISOString();
const release = {
  date: "2026-11-15",
  time: "02:24",
  kind: "更新",
  title: "合成的最新更新",
  body: ["合成导语。", "合成：本国最新的 5 条动态。", "合成：一条走势线。", "合成：最近 72 小时。", "合成：左边解读、右边原文。"],
};
const item = (id: string, title: string) => ({
  id,
  title,
  summary: null,
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
const pool = (code: string, items: unknown[]) => ({
  filters: { channel: "all", category: null, tag: null, topic: null, jurisdiction: code, q: null, tab: "time" },
  items,
  page: 1,
  pageCount: 1,
  total: items.length,
  todayCount: items.length,
  freshness: now,
  generatedAt: now,
});
const period = (day: string) => ({ start: day, end: day, label: `合成${day}` });
const answers: Record<string, unknown> = {
  "/api/site/changelog": { latestVersion: "2026-11-15T02:24", releases: [release] },
  "/api/site/meta": { changelogVersion: "2026-11-15T02:24", filings: { icp: null, publicSecurity: null, newsLicense: null } },
  "/api/site/content-version": { version: "1", withdrawalVersion: "1" },
  "/api/site/hot": { computedAt: now, ruleVersion: "合成", windowHours: 72, entries: [{}, {}, {}] },
  "/api/site/metal-prices": {
    generatedAt: now,
    intro: "合成",
    latest: [{ tag: "日", label: "合成", stale: false, extras: [] }],
    sources: [
      {
        key: "s",
        name: "合成官方来源",
        tag: "日",
        status: "fresh",
        latest: { label: "合成", release: { label: "合成", url: "https://example.org/", date: null } },
      },
    ],
    metals: [
      {
        key: "copper",
        name: "铜",
        quotes: [
          {
            key: "s.copper",
            source: "s",
            title: "合成现货价",
            spec: null,
            footnote: null,
            value: "103.00",
            unit: "美元/吨",
            currency: "USD",
            decimals: 2,
            period: period("2026-11-03"),
            change: null,
            history: [
              { period: period("2026-11-01"), value: "101.00" },
              { period: period("2026-11-02"), value: "99.50" },
              { period: period("2026-11-03"), value: "103.00" },
            ],
          },
        ],
      },
    ],
    notes: [],
    officialLinks: [],
  },
};
const api = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fixture");
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/api/site/pool") {
    const code = url.searchParams.get("jurisdiction");
    const items =
      code === "CN"
        ? [item("cn-1", "合成中国一号很长很长的标题，用来占两行的位置，看切换时页面会不会跳动"), item("cn-2", "合成中国二")]
        : [item("ar-1", "合成阿根廷一")];
    return res.end(JSON.stringify(pool(code ?? "", items)));
  }
  const answer = answers[url.pathname];
  if (answer) return res.end(JSON.stringify(answer));
  res.statusCode = 404;
  res.end(JSON.stringify({ code: "not_found" }));
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
    web.once("exit", () => reject(new Error(log)));
  });
  browser = await chromium.launch({
    headless: true,
    executablePath: browserExecutable(),
    // WebGL without a GPU: Chromium's software renderer.
    args: ["--disable-background-networking", "--disable-component-update", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
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

async function open(options: BrowserContextOptions = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block", locale: "zh-CN", ...options });
  await isolateBrowser(context, [origin]);
  const page = await context.newPage();
  const scripts: string[] = [];
  const problems: string[] = [];
  page.on("request", (request) => scripts.push(new URL(request.url()).pathname));
  page.on("pageerror", (error) => problems.push(String(error)));
  page.on("console", (message) => /WebGL|context|three/i.test(message.text()) && message.type() !== "warning" && problems.push(message.text()));
  await page.goto(`${origin}/changelog`, { waitUntil: "networkidle" });
  const player = () => scripts.filter((path) => /\/assets\/runtime-[\w-]+\.js$/.test(path)).length;
  return { context, page, player, problems };
}

const POSTER = "button[aria-label^='播放演示']";

test("the player loads on press only; Space pauses, Esc closes and returns focus; five openings leave no canvas", { timeout: 60_000 }, async () => {
  const { context, page, player, problems } = await open();
  try {
    assert.equal(player(), 0, "nothing of the player is loaded with the page");
    assert.equal(await page.locator("canvas").count(), 0);
    for (let round = 1; round <= 5; round++) {
      await page.locator(POSTER).click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      assert.equal(await dialog.locator("canvas").count(), 1);
      if (round === 1) {
        // Playing: the main control offers to pause; Space pauses; Space again plays.
        const control = dialog.locator(".pl-button").first();
        assert.equal(await control.getAttribute("aria-label"), "暂停");
        assert.ok(await page.evaluate(() => !!document.querySelector<HTMLCanvasElement>(".pl-canvas")?.getContext("webgl2")), "a WebGL context");
        await page.locator(".pl-stage").click({ position: { x: 4, y: 4 } });
        await page.keyboard.press("Space");
        assert.equal(await control.getAttribute("aria-label"), "播放");
        await page.keyboard.press("Space");
        assert.equal(await control.getAttribute("aria-label"), "暂停");
        assert.equal(await page.evaluate(() => document.documentElement.style.overflow), "hidden", "the page behind stays put");
      }
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")?.startsWith("播放演示")), true, "focus returns to the poster");
    }
    assert.equal(await page.locator("canvas").count(), 0, "every canvas is gone");
    assert.equal(await page.evaluate(() => document.documentElement.style.overflow), "");
    assert.equal(player(), 1, "the player was fetched once");
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("with reduced motion the button leads to the storyboard and loads nothing", async () => {
  const { context, page, player } = await open({ reducedMotion: "reduce" });
  try {
    const button = page.locator("button[aria-label^='查看分镜']");
    await button.waitFor();
    await button.click();
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "分镜");
    assert.equal(player(), 0);
  } finally {
    await context.close();
  }
});

test("switching country does not move the page; the price line steps through real published points", async () => {
  const { context, page } = await open({ viewport: { width: 390, height: 844 } });
  try {
    const board = page.getByRole("list", { name: "分镜" });
    const height = async () => (await board.boundingBox())!.height;
    const before = await height();
    await board.getByRole("button", { name: "阿根廷" }).click();
    assert.equal(await board.getByRole("button", { name: "阿根廷" }).getAttribute("aria-pressed"), "true");
    assert.ok(await board.getByRole("link", { name: /合成阿根廷一/ }).isVisible());
    assert.equal(await height(), before, "the storyboard keeps its height");
    const line = board.getByRole("slider");
    assert.equal(await line.getAttribute("aria-valuetext"), "合成2026-11-03 103.00 美元/吨");
    await line.focus();
    await page.keyboard.press("ArrowLeft");
    assert.equal(await line.getAttribute("aria-valuetext"), "合成2026-11-02 99.50 美元/吨");
    await page.keyboard.press("Home");
    assert.equal(await line.getAttribute("aria-valuetext"), "合成2026-11-01 101.00 美元/吨");
  } finally {
    await context.close();
  }
});
