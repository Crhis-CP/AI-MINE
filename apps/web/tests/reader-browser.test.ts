// Real production browser/router, synthetic read-only API; no external network or accounts.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { chromium, expect, type Browser } from "@playwright/test";
import { browserExecutable, isolateBrowser } from "../../../e2e/browser.ts";
import { webEnvironment } from "../runtime-env.ts";

let origin = "",
  web: ChildProcess,
  browser: Browser;
let withdrawn = false,
  added = false;
const now = new Date().toISOString();
const card = (id = "fixture-a") => ({
  id,
  title: id === "fixture-a" ? "可核对的矿业动态" : "新到的矿业动态",
  summary: "合成导读",
  reason: null,
  source: { name: "合成来源" },
  publishedAt: now,
  timelineAt: now,
  category: null,
  tags: [],
  score: null,
  selected: false,
  channel: "news",
});
const detail = {
  ...card(),
  revision: 1,
  originalTitle: null,
  source: { id: "fixture-source", name: "合成来源", kind: "web_list", firstParty: true },
  links: { original: "https://example.invalid/source" },
  discoveredAt: now,
  story: null,
  readingMode: "full",
  author: null,
  language: "zh",
  body: { zh: '<h2 id="section-one">正文第一节</h2><p>合成正文</p><h2 id="section-two">正文第二节</h2>', original: null, zhKind: "original", complete: true },
  outline: [
    { id: "section-one", text: "正文第一节", level: 2 },
    { id: "section-two", text: "正文第二节", level: 2 },
  ],
  relatedStories: [],
  indexable: false,
  group: null,
  hasTranslation: false,
  bodyLanguage: "zh",
  companyContext: [
    {
      name: "合成矿企",
      originalName: "Fixture Mining",
      description: "用于验证资料出处入口的合成公司资料。",
      sources: [{ name: "公司资料原始依据", url: "https://example.invalid/company" }],
    },
  ],
  attribution: {
    publishers: [{ name: "合成发布方署名", url: "https://example.invalid/publisher" }],
    license: { name: "合成许可说明", url: "https://example.invalid/license" },
    notice: "合成取得声明",
    legalUrl: "https://example.invalid/legal",
  },
  relatedPolicies: [{ id: "policy-fixture", title: "合成相关法规", jurisdiction: "AR", documentNumber: "法令 123" }],
};
const calls: string[] = [];
const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://fixture");
  calls.push(req.url!);
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  const answer = (value: unknown) => res.end(JSON.stringify(value));
  if (url.pathname === "/api/site/meta") return answer({ changelogVersion: null });
  if (url.pathname === "/api/site/content-version") return answer({ version: added ? "2" : "1", withdrawalVersion: withdrawn ? "2" : "1" });
  if (url.pathname === "/api/site/jurisdictions") return answer([]);
  if (url.pathname === "/api/site/items/saved") return answer({ items: withdrawn ? [] : [card()], unavailableIds: withdrawn ? ["fixture-a"] : [] });
  if (url.pathname === "/api/site/items/fixture-a") {
    if (withdrawn) {
      res.statusCode = 404;
      return answer({ code: "not_found" });
    }
    return answer(detail);
  }
  if (url.pathname === "/api/site/pool")
    return answer({
      filters: { channel: "all", category: null, tag: null, q: null, tab: "time" },
      items: withdrawn ? (added ? [card("fixture-new")] : []) : added ? [card("fixture-new"), card()] : [card()],
      page: Number(url.searchParams.get("page") || 1),
      pageCount: 51,
      total: 1005,
      todayCount: 1,
      freshness: now,
      generatedAt: now,
      facets: { sources: [{ id: "fixture-source", name: "合成来源", count: 1 }], minerals: ["铜"] },
    });
  res.statusCode = 404;
  answer({ code: "not_found" });
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

test("mobile controls, content refresh, saved withdrawal and system theme work in the production build", { timeout: 60000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
  const blocked = await isolateBrowser(context, [origin]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const opened = await page.goto(`${origin}/all`);
  assert.match(opened!.headers()["cache-control"]!, /(?:^|, )no-store(?:,|$)/);
  await expect(page.getByText("正在确认最新内容", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "底部导航" }).getByRole("link")).toHaveCount(5);
  await expect(page.getByRole("navigation", { name: "底部导航" }).getByRole("link", { name: "热点榜" })).toBeVisible();
  await page.getByRole("button", { name: "收藏", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("amp-starred-items")!)[0]).sort()), ["id", "savedAt", "type"]);
  await page.getByRole("button", { name: /^收起/ }).filter({ visible: true }).click();
  await expect(page.getByRole("heading", { name: "可核对的矿业动态" })).toBeHidden();
  await page.getByRole("button", { name: /^展开/ }).filter({ visible: true }).click();
  await page.getByRole("spinbutton", { name: "跳到第几页" }).fill("51");
  await page.getByRole("button", { name: "跳转", exact: true }).click();
  await expect(page).toHaveURL(/page=51/);
  assert(calls.some((path) => path.includes("/api/site/pool?") && path.includes("page=51")));
  await page.getByRole("heading", { name: "可核对的矿业动态" }).getByRole("link").click();
  await expect(page.getByRole("navigation", { name: "底部导航" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "合成矿企（Fixture Mining）" })).toBeVisible();
  await expect(page.getByRole("link", { name: "公司资料原始依据" })).toHaveAttribute("href", "https://example.invalid/company");
  await expect(page.getByRole("link", { name: "合成许可说明" })).toHaveAttribute("href", "https://example.invalid/license");
  await expect(page.getByRole("link", { name: "合成相关法规" })).toHaveAttribute("href", "/policies/policy-fixture");
  await page.getByText("文章目录", { exact: true }).click();
  await expect(page.getByRole("navigation", { name: "手机文章目录" }).getByRole("link", { name: "正文第一节" })).toBeVisible();
  await page.goto(`${origin}/all`);
  await expect(page.getByText("正在确认最新内容", { exact: true })).toHaveCount(0);
  added = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("button", { name: "加载最新" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "新到的矿业动态" })).toHaveCount(0);
  await page.getByRole("button", { name: "加载最新" }).click();
  await expect(page.getByRole("heading", { name: "新到的矿业动态" })).toBeVisible();
  await page.goto(`${origin}/starred`);
  await expect(page.getByRole("heading", { name: "可核对的矿业动态" })).toBeVisible();
  await expect(page.getByText("正在确认最新内容", { exact: true })).toHaveCount(0);
  await page.route("**/api/site/items/saved?**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("收藏暂时无法读取", { exact: false })).toBeVisible();
  await page.unroute("**/api/site/items/saved?**");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByRole("heading", { name: "可核对的矿业动态" })).toBeVisible();
  withdrawn = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("1 条收藏当前不可查看，已停止展示。", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "可核对的矿业动态" })).toHaveCount(0);
  await page.goto(`${origin}/more`);
  await page.getByRole("radio", { name: "跟随系统" }).filter({ visible: true }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const other = await context.newPage();
  await other.goto(`${origin}/more`);
  await other.evaluate(() => localStorage.setItem("amp-theme", "dark"));
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await other.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  await context.close();
});

test("a combined withdrawal and arrival removes the old card while the new card waits for explicit loading", { timeout: 30000 }, async () => {
  withdrawn = false;
  added = false;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
  await isolateBrowser(context, [origin]);
  const page = await context.newPage();
  const initialCheck = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(".data"));
  await page.goto(`${origin}/all`);
  await (await initialCheck).finished();
  await expect(page.getByText("正在确认最新内容", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "可核对的矿业动态" })).toBeVisible();
  withdrawn = true;
  added = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("已核对撤回和修订内容", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "可核对的矿业动态" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "新到的矿业动态" })).toHaveCount(0);
  await page.getByRole("button", { name: "加载最新" }).click();
  await expect(page.getByRole("heading", { name: "新到的矿业动态" })).toBeVisible();
  await context.close();
});
