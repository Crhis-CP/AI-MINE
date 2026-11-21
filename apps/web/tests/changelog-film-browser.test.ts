// The changelog film (TASK-0367, Owner 2026-11-21: “点开能看”, a recording of one moment): the player and Three.js load
// only when a reader presses play; Space plays and pauses, Esc closes and gives focus back; closing frees the canvas,
// five times over; with reduced motion the button leads to the storyboard and nothing is loaded; the storyboard's
// country switch does not move the page; the price line answers the arrow keys with the recorded published points. Run after `npm run build -w @amp/web`.
// Production web, synthetic read-only API; the browser draws WebGL in software (SwiftShader).
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium, type Browser, type BrowserContextOptions } from "@playwright/test";
import { browserExecutable, isolateBrowser } from "./browser.ts";
import { webEnvironment } from "../runtime-env.ts";

let browser: Browser,
  web: ChildProcess,
  origin = "";
const release = {
  date: "2026-11-15",
  time: "02:24",
  kind: "更新",
  title: "合成的最新更新",
  body: ["合成导语。", "合成：没有画进演示的一条。"],
};
/** The film's recording, as committed beside its scenes. */
const recording: {
  countries: Array<{ code: string; items: Array<{ title: string }> }>;
  metals: Array<{ unit: string; decimals: number; points: Array<{ label: string; value: string }> }>;
} = JSON.parse(await readFile(new URL("../app/features/changelog/films/2026-11-15/snapshot.json", import.meta.url), "utf8"));
const answers: Record<string, unknown> = {
  "/api/site/changelog": { latestVersion: "2026-11-15T02:24", releases: [release] },
  "/api/site/meta": { changelogVersion: "2026-11-15T02:24", filings: { icp: null, publicSecurity: null, newsLicense: null } },
  "/api/site/content-version": { version: "1", withdrawalVersion: "1" },
};
const api = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fixture");
  res.setHeader("content-type", "application/json");
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

test("switching country does not move the page; the price line steps through the recorded published points", async () => {
  const { context, page } = await open({ viewport: { width: 390, height: 844 } });
  try {
    const board = page.getByRole("list", { name: "分镜" });
    const height = async () => (await board.boundingBox())!.height;
    const before = await height();
    await board.getByRole("button", { name: "阿根廷" }).click();
    assert.equal(await board.getByRole("button", { name: "阿根廷" }).getAttribute("aria-pressed"), "true");
    const argentina = recording.countries.find((country) => country.code === "AR")!.items[0]!.title;
    assert.ok(await board.getByText(argentina).isVisible());
    assert.equal(await height(), before, "the storyboard keeps its height");
    const copper = recording.metals[0]!;
    const read = (i: number) => {
      const point = copper.points.at(i)!;
      const price = Number(point.value).toLocaleString("en-US", { minimumFractionDigits: copper.decimals, maximumFractionDigits: copper.decimals });
      return `${point.label} ${price} ${copper.unit}`;
    };
    const line = board.getByRole("slider").first();
    assert.equal(await line.getAttribute("aria-valuetext"), read(-1));
    await line.focus();
    await page.keyboard.press("ArrowLeft");
    assert.equal(await line.getAttribute("aria-valuetext"), read(-2));
    await page.keyboard.press("Home");
    assert.equal(await line.getAttribute("aria-valuetext"), read(0));
    // Said once the key has stepped, not on every pointer move.
    assert.equal(await board.locator("p[aria-live=polite]").first().textContent(), read(0));
  } finally {
    await context.close();
  }
});
