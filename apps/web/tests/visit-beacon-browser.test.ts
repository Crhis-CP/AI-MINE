// First-party visit statistics in the browser (TASK-0571): every reader page shown — the first one and each in-site
// navigation — posts one beacon with its path to the site's own api, the first with its referrer; nothing is stored
// in the browser; the privacy page explains it in Chinese and summarises it on the English page. Production web,
// local synthetic API; no external requests or accounts.
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
  origin = "";
const beacons: Array<{ body: { path: string; referrer: string | null }; type: string; cookie: string | undefined }> = [];
const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://fixture");
  if (req.method === "POST" && url.pathname === "/api/site/visit") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      beacons.push({ body: JSON.parse(raw), type: String(req.headers["content-type"]), cookie: req.headers.cookie });
      res.statusCode = 204;
      res.end();
    });
    return;
  }
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  if (url.pathname === "/api/site/meta") return res.end(JSON.stringify({ changelogVersion: null }));
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

test("each reader page shown sends one beacon; nothing is stored in the browser; the privacy page says so", { timeout: 60000 }, async (t) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  t.after(() => context.close());
  const blocked = await isolateBrowser(context, [origin]),
    page = await context.newPage(),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(`${origin}/privacy`, { waitUntil: "networkidle", referer: "https://www.example.org/search?q=mining" });
  const section = page.getByRole("heading", { name: "4. 访问统计" });
  await expect(section).toBeVisible();
  await expect(page.locator("article")).toContainText("不用 Cookie，不接第三方统计");
  await expect(page.locator("article")).toContainText("当天（日活）和当月（月活）的匿名哈希");
  await expect(page.locator("article")).toContainText("原始网络地址和浏览器信息不保存");
  await expect.poll(() => beacons.length).toBe(1);
  assert.equal(beacons[0]!.body.path, "/privacy");
  assert.equal(beacons[0]!.body.referrer, "https://www.example.org/search?q=mining");
  assert.match(beacons[0]!.type, /^text\/plain/);

  // An in-site navigation is a new page view, without the entry referrer.
  await page.getByRole("link", { name: "使用规则" }).last().click();
  await expect(page).toHaveURL(/\/terms$/);
  await expect.poll(() => beacons.length).toBe(2);
  assert.deepEqual(beacons[1]!.body, { path: "/terms", referrer: null });

  // English: the Chinese original plus an English summary of the visit statistics.
  await page.goto(`${origin}/en/privacy`, { waitUntil: "networkidle" });
  await expect(page.getByText(/^Visit statistics: this site counts its own visits, with no cookies and no third-party analytics\./)).toBeVisible();
  await expect(page.getByRole("heading", { name: "4. 访问统计" })).toBeVisible();
  await expect.poll(() => beacons.length).toBe(3);
  assert.equal(beacons[2]!.body.path, "/en/privacy");
  // The Chinese page does not carry the English summary.
  await page.goto(`${origin}/privacy`, { waitUntil: "networkidle" });
  await expect(page.getByText(/^Visit statistics:/)).toHaveCount(0);
  await expect.poll(() => beacons.length).toBe(4);

  assert.deepEqual(await context.cookies(), [], "no cookie");
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  assert.ok(!/visit|visitor/i.test(stored), stored);
  assert.ok(beacons.every((b) => !b.cookie));
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
});
