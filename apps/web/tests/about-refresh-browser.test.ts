// Production router/browser with a changing local statistics API; no external requests or accounts.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { chromium, expect, type Browser } from "@playwright/test";
import { browserExecutable, isolateBrowser } from "./browser.ts";
import { webEnvironment } from "../runtime-env.ts";

let browser: Browser,
  web: ChildProcess,
  origin = "",
  count = 1,
  unavailable = false,
  statsCalls = 0;
const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://fixture");
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  const send = (value: unknown) => res.end(JSON.stringify(value));
  if (url.pathname === "/api/site/meta") return send({ changelogVersion: null });
  if (url.pathname === "/api/site/information")
    return send({ revision: 0, updatedAt: null, about: "合成网站介绍", contactEmail: null, contactPage: null, metalLinks: [] });
  if (url.pathname === "/api/site/stats") {
    statsCalls++;
    if (unavailable) {
      res.statusCode = 503;
      return send({ code: "temporarily_unavailable" });
    }
    return send({
      sources: count,
      sourceKinds: count ? { rss: count } : {},
      heatOnlySources: 0,
      items: count * 10,
      selected: count,
      dailies: count,
      day: { collected: count, selected: count },
      sampleSources: Array.from({ length: count }, (_, n) => ({ name: `合成来源${n}`, kind: "rss", heatOnly: false })),
      latest: count ? [{ id: `item-${count}`, title: `合成精选${count}`, source: "合成来源" }] : [],
    });
  }
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

test("about refreshes while visible, resumes on focus and recovers from honest failure/empty states", { timeout: 30000 }, async (t) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 1000 }, reducedMotion: "reduce" });
  t.after(() => context.close());
  const blocked = await isolateBrowser(context, [origin]),
    page = await context.newPage(),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install();
  await page.goto(`${origin}/about`);
  const figures = page.locator('section[aria-labelledby="how"]'),
    source = figures.getByRole("listitem").first();
  await expect(source).toContainText(/1\s*个来源/);
  count = 2;
  await page.clock.fastForward(30_001);
  await expect(source).toContainText(/2\s*个来源/);
  await expect(figures.getByRole("link", { name: /最近精选.*合成精选2/ }).filter({ visible: true })).toBeVisible();
  await page.evaluate(() => Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }));
  const hiddenCalls = statsCalls;
  count = 3;
  await page.clock.fastForward(90_001);
  assert.equal(statsCalls, hiddenCalls, "hidden tabs do not keep polling");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(source).toContainText(/3\s*个来源/);
  count = 4;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(source).toContainText(/4\s*个来源/);
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  unavailable = true;
  await page.clock.fastForward(30_001);
  await expect(figures.getByRole("status")).toBeVisible();
  await expect(source).not.toContainText(/4\s*个来源/);
  await expect(figures.locator("canvas")).toHaveCount(0);
  unavailable = false;
  count = 0;
  await figures.getByRole("button", { name: "重试", exact: true }).click();
  await expect(figures.getByRole("status")).toHaveCount(0);
  await expect(source).toContainText(/0\s*个来源/);
  await expect(figures.locator("canvas"), "no synthetic source lines are drawn for an empty sample").toHaveCount(0);
  count = 1;
  await page.clock.fastForward(30_001);
  await expect(source).toContainText(/1\s*个来源/);
  await expect(figures.locator("canvas")).toBeVisible();
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
});
