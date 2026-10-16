// Production web with synthetic report API; no database or external requests.
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
let pending = false;
const key = "2026-10-13",
  title = "今日无大事发生";
const report = {
  kind: "daily",
  key,
  title: `矿业日报 · ${key}`,
  windowStart: "2026-10-12T00:00:00Z",
  windowEnd: "2026-10-13T00:00:00Z",
  generatedAt: "2026-10-13T00:00:00Z",
  revision: 1,
  generationStatus: "summary",
  lead: { title, leadParagraph: "本期已完成评分的矿业资讯中，没有新增内容入选日报。" },
  overview: null,
  highlights: [],
  sections: [],
  stories: [],
  flashes: [],
  metrics: { totalEvents: 0, sourcesCount: 0, firstPartyEvents: 0 },
  readingMinutes: 1,
  prev: null,
  next: null,
};
const index = [{ key, title, generatedAt: report.generatedAt, count: 0 }];
const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://fixture");
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  const send = (value: unknown) => res.end(JSON.stringify(value));
  if (url.pathname === "/api/site/meta") return send({ changelogVersion: null });
  if (url.pathname === "/api/site/content-version") return send({ version: "1", withdrawalVersion: "1" });
  if (url.pathname === "/api/site/reports/daily/latest-page") return send({ index: pending ? [] : index, report: pending ? null : report });
  if (url.pathname === "/api/site/reports/daily" || url.pathname.includes("/navigation/")) return send({ items: index });
  if (url.pathname === `/api/site/reports/daily/${key}`) return send(report);
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
      PRIVATE_API_BASE_URL: base,
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

for (const width of [390, 1440])
  test(`quiet daily latest, archive and dated page at ${width}px`, { timeout: 30000 }, async (t) => {
    pending = false;
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    t.after(() => context.close());
    const blocked = await isolateBrowser(context, [origin]);
    const page = await context.newPage();
    for (const path of ["/daily", `/daily/${key}`]) {
      const response = await page.goto(origin + path);
      assert.equal(response!.status(), 200);
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
      await expect(page.getByText("本期无新增精选", { exact: false })).toBeVisible();
      await expect(page.getByText("覆盖时间：", { exact: false })).toBeVisible();
      await expect(page.getByText(report.lead.leadParagraph, { exact: true })).toBeVisible();
      await expect(page.getByText("本期收录截至 2026-10-13 08:00 的精选。之后入选的内容，请看后续日报。", { exact: false })).toBeVisible();
      await expect(page.getByRole("link", { name: "查看最新精选", exact: true })).toHaveAttribute("href", "/");
      await expect(page.getByText(/约 \d+ 分钟读完/)).toHaveCount(0);
      await expect(page.getByText("第一期发布后会出现在这里。", { exact: true })).toHaveCount(0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    if (process.env.QUIET_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.QUIET_SCREENSHOT_DIR}/daily-quiet-${width}.png`, fullPage: true });
    await page.goto(origin + "/daily/archive");
    const issue = page.getByRole("link").filter({ hasText: title }).last();
    await expect(issue).toHaveAttribute("href", `/daily/${key}`);
    await issue.click();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    pending = true;
    await page.goto(origin + "/daily");
    await expect(page.getByText("第一期发布后会出现在这里。", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: title, exact: true })).toHaveCount(0);
    assert.deepEqual(blocked, []);
  });
