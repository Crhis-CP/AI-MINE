// Real production browser/router, synthetic read-only API; no external network or accounts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { chromium, expect, type Browser, type Page, type Route } from "@playwright/test";
import { browserExecutable, isolateBrowser } from "./browser.ts";
import { webEnvironment } from "../runtime-env.ts";

let origin = "",
  web: ChildProcess,
  browser: Browser;
let phase = "setup";
let changelogVersion: string | null = null;
let searchNavigationMode: "ready" | "error" | "empty" = "ready";
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
  body: {
    zh: '<h2 id="section-one">正文第一节</h2><p>合成正文</p><h2 id="section-two">正文第二节</h2><h2 id="section-three">正文第三节</h2>',
    original: null,
    zhKind: "original",
    complete: true,
  },
  outline: [
    { id: "section-one", text: "正文第一节", level: 2 },
    { id: "section-two", text: "正文第二节", level: 2 },
    { id: "section-three", text: "正文第三节", level: 2 },
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
const searchTimes = { newsStart: 0, newsEnd: 0, policyStart: 0, policyEnd: 0 };
const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://fixture");
  calls.push(req.url!);
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  const answer = (value: unknown) => {
    if (url.searchParams.get("q") === "并行测试" && ["/api/site/pool", "/api/site/policies"].includes(url.pathname)) {
      const news = url.pathname === "/api/site/pool";
      searchTimes[news ? "newsStart" : "policyStart"] = Date.now();
      setTimeout(() => {
        searchTimes[news ? "newsEnd" : "policyEnd"] = Date.now();
        res.end(JSON.stringify(value));
      }, 400);
      return;
    }
    return res.end(JSON.stringify(value));
  };
  if (url.pathname === "/api/site/policies") {
    if (url.searchParams.get("q") === "超时测试") return;
    res.statusCode = 503;
    return answer({ code: "temporarily_unavailable" });
  }
  if (url.pathname === "/api/site/search/suggestions") {
    if (searchNavigationMode === "error") {
      res.statusCode = 503;
      return answer({ code: "temporarily_unavailable" });
    }
    return answer(
      searchNavigationMode === "empty"
        ? { topics: [], hot: [] }
        : {
            topics: [{ slug: "synthetic-mine", name: "合成矿企主题", group: "company" }],
            hot: [{ rank: 1, title: "已确认的矿业热点", to: "/story/synthetic-story" }],
          },
    );
  }
  if (url.pathname === "/api/site/meta") return answer({ changelogVersion });
  if (url.pathname === "/api/site/changelog")
    return answer({
      releases: changelogVersion ? [{ date: changelogVersion.slice(0, 10), time: "12:30", kind: "优化", title: "合成阅读更新", body: ["改进阅读体验。"] }] : [],
    });
  if (url.pathname === "/api/site/content-version") return answer({ version: added ? "2" : "1", withdrawalVersion: withdrawn ? "2" : "1" });
  if (url.pathname === "/api/site/jurisdictions") return answer([]);
  if (url.pathname === "/api/site/timeline")
    return answer({
      filters: { channel: "all", category: null, tag: null, topic: null, jurisdiction: null },
      cards: [{ key: "fixture-a", anchorAt: now, item: card(), group: null }],
      nextCursor: null,
      refreshAt: null,
      hot: null,
      dayCounts: {},
      generatedAt: now,
    });
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
      filters: { channel: "all", category: null, tag: null, q: url.searchParams.get("q"), tab: "time" },
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

/** SSR starts without a status banner. Its absence alone cannot prove hydration/baseline readiness. */
async function openQualifiedReader(page: Page, path: "/" | "/all" | "/starred" = "/all", expectedVersion = "1") {
  phase = `baseline ${path}: setup`;
  const versionUrl = `${origin}/api/site/content-version`;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holdFirstVersion = async (route: Route) => {
    await gate;
    await route.continue();
  };
  await page.bringToFront();
  await page.route(versionUrl, holdFirstVersion, { times: 1 });
  const version = page.waitForResponse((response) => response.url() === versionUrl);
  const revalidation = path === "/all" ? page.waitForResponse((response) => new URL(response.url()).pathname === "/all.data") : null;
  // If an earlier readiness assertion fails, context cleanup will reject these waiters too.
  // Keep those rejections observed; the awaited responses below still fail the actual test.
  void version.catch(() => {});
  void revalidation?.catch(() => {});
  try {
    phase = `baseline ${path}: navigate`;
    const opened = await page.goto(`${origin}${path}`);
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("visible");
    phase = `baseline ${path}: checking`;
    await expect(page.getByRole("region", { name: "阅读内容", exact: true })).toHaveAttribute("aria-busy", "true");
    release();
    phase = `baseline ${path}: version`;
    const baseline = await version;
    assert.equal(baseline.status(), 200);
    assert.deepEqual(await baseline.json(), { version: expectedVersion, withdrawalVersion: "1" });
    if (revalidation) {
      phase = `baseline ${path}: data response`;
      const loaded = await revalidation;
      assert.equal(loaded.status(), 200);
      // React Router consumes a streamed navigation response. Its network stream closing is not
      // the readiness condition: the guard sets idle only after revalidate() and baseline assignment.
    }
    phase = `baseline ${path}: DOM qualified`;
    await expect(page.getByRole("region", { name: "阅读内容", exact: true })).toHaveAttribute("aria-busy", "false");
    await expect(page.getByRole("status").filter({ hasText: "暂时无法确认最新内容" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "加载最新", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "可核对的矿业动态" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "新到的矿业动态" })).toHaveCount(0);
    phase = `baseline ${path}: ready`;
    return opened;
  } finally {
    release();
    phase += ": unroute";
    await page.unroute(versionUrl, holdFirstVersion);
  }
}

async function checkVersionOnFocus(page: Page, withdrawalVersion: string) {
  const checked = page.waitForResponse((response) => response.url() === `${origin}/api/site/content-version`);
  phase = "focus version response";
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("visible");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  assert.deepEqual(await (await checked).json(), { version: "2", withdrawalVersion });
}

test("mobile controls, content refresh, saved withdrawal and system theme work in the production build", { timeout: 60000 }, async (t) => {
  withdrawn = false;
  added = false;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
  t.after(async () => {
    t.diagnostic(`last reader phase: ${phase}`);
    await context.close();
  });
  const blocked = await isolateBrowser(context, [origin]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const opened = await openQualifiedReader(page);
  assert.match(opened!.headers()["cache-control"]!, /(?:^|, )no-store(?:,|$)/);
  await expect(page.getByRole("region", { name: "阅读内容", exact: true })).toHaveAttribute("aria-busy", "false");
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
  const readingTools = page.getByRole("navigation", { name: "阅读工具" });
  await expect(readingTools.getByRole("link", { name: "打开原文" })).toHaveAttribute("href", "https://example.invalid/source");
  const historyPosition = await page.evaluate(() => history.state.idx);
  await readingTools.getByRole("button", { name: "目录", exact: true }).click();
  const outlineDialog = page.getByRole("dialog", { name: "文章目录" });
  await expect(outlineDialog.getByRole("button", { name: "关闭", exact: true })).toBeFocused();
  const grip = await outlineDialog.getByRole("heading", { name: "文章目录" }).boundingBox();
  assert.ok(grip);
  await page.mouse.move(grip.x + 12, grip.y + 8);
  await page.mouse.down();
  await page.mouse.move(grip.x + 12, grip.y + 140, { steps: 5 });
  await page.mouse.up();
  await expect(outlineDialog).toHaveCount(0);
  await readingTools.getByRole("button", { name: "目录", exact: true }).click();
  await page.getByRole("navigation", { name: "手机文章目录" }).getByRole("link", { name: "正文第一节" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/#section-one$/);
  assert.equal(await page.evaluate(() => history.state.idx), historyPosition, "outline navigation does not insert a back-history entry");
  await openQualifiedReader(page);
  added = true;
  await checkVersionOnFocus(page, "1");
  await expect(page.getByRole("button", { name: "加载最新" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "新到的矿业动态" })).toHaveCount(0);
  await page.getByRole("button", { name: "加载最新" }).click();
  await expect(page.getByRole("heading", { name: "新到的矿业动态" })).toBeVisible();
  await openQualifiedReader(page, "/starred", "2");
  await expect(page.getByText("已读", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "可核对的矿业动态" })).toBeVisible();
  await page.route("**/api/site/items/saved?**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("部分收藏暂时无法更新", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "可核对的矿业动态" })).toBeVisible();
  await page.unroute("**/api/site/items/saved?**");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByRole("heading", { name: "可核对的矿业动态" })).toBeVisible();
  withdrawn = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("1 条收藏当前不可查看，已停止展示。", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "可核对的矿业动态" })).toHaveCount(0);
  phase = "theme navigation";
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
  await page.getByLabel("字体", { exact: true }).selectOption("browser");
  await expect(other.locator("html")).toHaveAttribute("data-font", "browser");
  await page.reload();
  await expect(page.getByLabel("字体", { exact: true })).toHaveValue("browser");
  await expect(page.locator("html")).toHaveAttribute("data-font", "browser");
  await other.getByLabel("字体", { exact: true }).selectOption("system");
  await expect(page.locator("html")).toHaveAttribute("data-font", "system");
  phase = "theme close other";
  await other.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
});

test("a combined withdrawal and arrival removes the old card while the new card waits for explicit loading", { timeout: 30000 }, async (t) => {
  withdrawn = false;
  added = false;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
  t.after(async () => {
    t.diagnostic(`last reader phase: ${phase}`);
    await context.close();
  });
  await isolateBrowser(context, [origin]);
  const page = await context.newPage();
  await openQualifiedReader(page);
  withdrawn = true;
  added = true;
  await checkVersionOnFocus(page, "2");
  await expect(page.getByText("已核对撤回和修订内容", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "可核对的矿业动态" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "新到的矿业动态" })).toHaveCount(0);
  await page.getByRole("button", { name: "加载最新" }).click();
  await expect(page.getByRole("heading", { name: "新到的矿业动态" })).toBeVisible();
});

for (const width of [390, 1440]) {
  test(`return to feed keeps pointer titles quiet and keyboard focus visible at ${width}px`, { timeout: 30000 }, async (t) => {
    withdrawn = false;
    added = false;
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    t.after(() => context.close());
    await isolateBrowser(context, [origin]);
    const page = await context.newPage();
    await openQualifiedReader(page, "/");
    const title = page.locator("h3 a").filter({ hasText: "可核对的矿业动态" });
    await title.click();
    await expect(page).toHaveURL(`${origin}/items/fixture-a`);
    await page.goBack();
    await expect(title).toBeVisible();
    // Wait for the existing second layout-settle pass, which used to steal focus again.
    await page.waitForTimeout(200);
    assert.equal(await title.evaluate((el) => el.matches(":focus-visible")), false, "mouse return must not add a title outline");
    assert.equal(await title.evaluate((el) => el === document.activeElement), false, "position restore must not invent pointer focus");
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    for (let i = 0; i < 60 && !(await title.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
    await expect(title).toBeFocused();
    assert.equal(await title.evaluate((el) => el.matches(":focus-visible")), true);
    assert.equal(await title.evaluate((el) => getComputedStyle(el).outlineStyle), "none", "keyboard focus does not draw a box around text");
    assert.equal(await title.evaluate((el) => getComputedStyle(el).textDecorationLine), "underline");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${origin}/items/fixture-a`);
    await page.goBack();
    await expect(title).toBeFocused();
    await page.keyboard.press("Tab");
    assert.equal(await title.evaluate((el) => el === document.activeElement), false, "reader can continue keyboard navigation");
  });
}

test("saved references import/export and partial refresh preserve usable content without resurrecting withdrawals", { timeout: 60000 }, async () => {
  withdrawn = false;
  added = false;
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
    try {
      const blocked = await isolateBrowser(context, [origin]);
      await context.addInitScript(() =>
        localStorage.setItem(
          "amp-starred-items",
          JSON.stringify(Array.from({ length: 101 }, (_, i) => ({ type: "item", id: i === 0 ? "fixture-a" : `saved${i}`, savedAt: "2026-01-01" }))),
        ),
      );
      const page = await context.newPage();
      let mode: "ok" | "partial" | "failed" = "ok";
      await page.route("**/api/site/items/saved?**", (route) => {
        const ids = new URL(route.request().url()).searchParams.get("ids")!.split(",");
        if (mode === "failed" || (mode === "partial" && !ids.includes("fixture-a")))
          return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
        const missing = mode === "partial" ? ["fixture-a"] : [];
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            items: ids.filter((id) => !missing.includes(id)).map((id) => ({ ...card(), id, title: id === "fixture-a" ? "可核对的矿业动态" : `收藏 ${id}` })),
            unavailableIds: missing,
          }),
        });
      });
      await page.goto(`${origin}/starred`);
      await expect(page.getByRole("heading", { name: "可核对的矿业动态", exact: true })).toBeVisible();
      await page.getByLabel("导入收藏文件").setInputFiles({
        name: "saved.json",
        mimeType: "application/json",
        buffer: Buffer.from(
          JSON.stringify({
            version: 1,
            starred: [{ type: "item", id: "imported", savedAt: "2026-02-01", title: "不能导入正文副本" }],
            read: ["fixture-a"],
            theme: "auto",
          }),
        ),
      });
      await expect(page.getByRole("status").filter({ hasText: "新增收藏 1 条、已读记录 1 条" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "收藏 imported", exact: true })).toBeVisible();
      await expect(page.getByText("已读", { exact: true })).toBeVisible();
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: "导出收藏与已读记录" }).click();
      const download = await downloadPromise;
      const bundle = JSON.parse(readFileSync((await download.path())!, "utf8"));
      assert.equal(bundle.starred.length, 102);
      assert.deepEqual(bundle.read, ["fixture-a"]);
      assert.ok(!JSON.stringify(bundle).includes("不能导入正文副本"));
      assert.deepEqual(Object.keys(bundle.starred[0]).sort(), ["id", "savedAt", "type"]);
      mode = "partial";
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(page.getByText("部分收藏暂时无法更新", { exact: false })).toBeVisible();
      await expect(page.getByRole("heading", { name: "可核对的矿业动态", exact: true })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "收藏 saved100", exact: true })).toBeVisible();
      mode = "failed";
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(page.getByText("部分收藏暂时无法更新", { exact: false })).toBeVisible();
      await expect(page.getByRole("heading", { name: "可核对的矿业动态", exact: true })).toHaveCount(0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      assert.deepEqual(blocked, []);
    } finally {
      await context.close();
    }
  }
});

test("news search runs alongside its optional policy search, and invalid dates retain editable filters", { timeout: 20000 }, async () => {
  withdrawn = false;
  added = false;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
  try {
    await isolateBrowser(context, [origin]);
    const page = await context.newPage();
    await page.goto(`${origin}/all?q=${encodeURIComponent("并行测试")}`);
    await expect(page.getByRole("heading", { name: "可核对的矿业动态" })).toBeVisible();
    assert.ok(Math.max(searchTimes.newsStart, searchTimes.policyStart) < Math.min(searchTimes.newsEnd, searchTimes.policyEnd), JSON.stringify(searchTimes));
    const started = Date.now();
    await page.goto(`${origin}/all?q=${encodeURIComponent("超时测试")}`, { timeout: 9000 });
    await expect(page.getByRole("heading", { name: "可核对的矿业动态" })).toBeVisible();
    assert.ok(Date.now() - started < 8000, "an optional stalled search must have a bounded deadline");
    const response = await page.goto(`${origin}/all?from=2026-10-16&to=2026-10-15&mineral=${encodeURIComponent("铜")}`);
    assert.equal(response!.status(), 400);
    await expect(page.getByRole("alert")).toContainText("开始日期不能晚于结束日期");
    await expect(page.getByLabel("开始日期")).toHaveValue("2026-10-16");
    await expect(page.getByLabel("结束日期")).toHaveValue("2026-10-15");
    await expect(page.getByRole("combobox", { name: "矿种", exact: true })).toHaveValue("铜");
    await page.getByLabel("结束日期").fill("2026-10-17");
    await page.getByRole("button", { name: "应用筛选" }).click();
    await expect(page.getByRole("heading", { name: "可核对的矿业动态" })).toBeVisible();
    assert.ok(calls.some((url) => url.includes("mineral=%E9%93%9C") && url.includes("to=2026-10-17")));
  } finally {
    await context.close();
  }
});

test("phone search opens in the tap, contains keyboard focus, reuses local queries and closes on navigation or desktop resize", {
  timeout: 30000,
}, async () => {
  withdrawn = false;
  added = false;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN", reducedMotion: "reduce" });
  try {
    const blocked = await isolateBrowser(context, [origin]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    const trigger = page.getByRole("link", { name: "搜索", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "搜索", exact: true });
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole("searchbox");
    await expect(input).toBeFocused();
    assert.equal(await input.evaluate((element) => getComputedStyle(element).fontSize), "16px");
    await input.press("Enter");
    await expect(dialog).toBeVisible();
    for (let i = 0; i < 9; i++) {
      await page.keyboard.press("Tab");
      assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true);
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("");
    await trigger.click();
    await input.fill(" 铜矿扩建 ");
    await input.press("Enter");
    await expect(page).toHaveURL(/q=%E9%93%9C%E7%9F%BF%E6%89%A9%E5%BB%BA/);
    await expect(dialog).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("amp-recent-searches")!)), ["铜矿扩建"]);
    await page.goto(origin);
    await trigger.click();
    await expect(dialog.getByRole("link", { name: "铜矿扩建", exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "清除记录" }).click();
    await expect(dialog.getByRole("region", { name: "最近搜索" })).toHaveCount(0);
    assert.equal(await page.evaluate(() => localStorage.getItem("amp-recent-searches")), null);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("");
    assert.deepEqual(errors, []);
    assert.deepEqual(blocked, []);
  } finally {
    await context.close();
  }
});

test("phone navigation retries independently of search and removes earlier hot links on reopening", { timeout: 20000 }, async () => {
  withdrawn = false;
  added = false;
  searchNavigationMode = "error";
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN", reducedMotion: "reduce" });
  try {
    const blocked = await isolateBrowser(context, [origin]);
    const page = await context.newPage();
    await page.goto(origin);
    await page.getByRole("link", { name: "搜索", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "搜索", exact: true });
    await expect(dialog.getByText("主题与热点暂时无法读取。", { exact: false })).toBeVisible();
    await expect(dialog.getByRole("searchbox")).toBeEditable();
    searchNavigationMode = "ready";
    await dialog.getByRole("button", { name: "重试导航" }).click();
    await expect(dialog.getByRole("link", { name: "合成矿企主题" })).toHaveAttribute("href", "/topics/synthetic-mine");
    await expect(dialog.getByRole("link", { name: /已确认的矿业热点/ })).toHaveAttribute("href", "/story/synthetic-story");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    searchNavigationMode = "empty";
    const loaded = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/site/search/suggestions");
    await page.getByRole("link", { name: "搜索", exact: true }).click();
    await loaded;
    await expect(dialog.getByRole("link", { name: /已确认的矿业热点/ })).toHaveCount(0);
    await expect(dialog.getByRole("link", { name: "合成矿企主题" })).toHaveCount(0);
    await expect(dialog.getByRole("link", { name: "查看热点榜" })).toBeVisible();
    assert.deepEqual(blocked, []);
  } finally {
    searchNavigationMode = "ready";
    await context.close();
  }
});

test("reading the changelog clears its local unread marker while a newer release restores it", { timeout: 20000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  await isolateBrowser(context, [origin]);
  const page = await context.newPage();
  try {
    changelogVersion = "2026-10-17T12:30";
    await page.goto(`${origin}/more`);
    const link = page.getByRole("link", { name: /^更新日志/ }).filter({ visible: true });
    await expect(link.getByRole("img", { name: "有未读更新" })).toBeVisible();
    await link.click();
    await expect(page.getByRole("heading", { name: "合成阅读更新" })).toBeVisible();
    await page.goto(`${origin}/more`);
    await expect(link.getByRole("img", { name: "有未读更新" })).toHaveCount(0);
    changelogVersion = "2026-10-18T12:30";
    await page.reload();
    await expect(link.getByRole("img", { name: "有未读更新" })).toBeVisible();
  } finally {
    changelogVersion = null;
    await context.close();
  }
});
