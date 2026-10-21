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
let unreadGroup = false;
let deepTimeline = false;
let deepPool = false;
let readerWithdrawalVersion = "1";
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
    zh: '<h2 id="section-one">正文第一节</h2><p>合成正文</p><img alt="合成矿山图片" width="300" height="200" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22300%22 height=%22200%22%3E%3Crect width=%22300%22 height=%22200%22 fill=%22gray%22/%3E%3C/svg%3E"><h2 id="section-two">正文第二节</h2><h2 id="section-three">正文第三节</h2>',
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
      const start = news ? "newsStart" : "policyStart";
      const first = searchTimes[start] === 0;
      if (first) searchTimes[start] = Date.now();
      setTimeout(() => {
        if (first) searchTimes[news ? "newsEnd" : "policyEnd"] = Date.now();
        res.end(JSON.stringify(value));
      }, 400);
      return;
    }
    return res.end(JSON.stringify(value));
  };
  if (url.pathname === "/api/site/information")
    return answer({
      about: "本地演示：把分散的矿业报道整理成中文，保留来源和原文，方便继续核对。",
      contactEmail: null,
      contactPage: null,
      metalLinks: [],
      revision: 1,
      updatedAt: null,
    });
  if (url.pathname === "/api/site/stats")
    return answer({
      sources: 2,
      heatOnlySources: 1,
      sourceKinds: { rss: 2 },
      items: 4,
      selected: 1,
      dailies: 1,
      day: { collected: 2, selected: 1 },
      sampleSources: [
        { name: "合成矿业公告", kind: "rss", heatOnly: false },
        { name: "合成行业信号", kind: "rss", heatOnly: true },
      ],
      latest: [{ id: "fixture-a", title: "可核对的矿业动态", source: "合成来源" }],
    });
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
  if (url.pathname === "/api/site/content-version") return answer({ version: added ? "2" : "1", withdrawalVersion: withdrawn ? "2" : readerWithdrawalVersion });
  if (url.pathname === "/api/site/jurisdictions") return answer([]);
  if (url.pathname === "/api/site/timeline")
    return answer({
      filters: {
        channel: url.searchParams.get("channel") ?? "all",
        category: url.searchParams.get("category"),
        tag: null,
        topic: null,
        jurisdiction: url.searchParams.get("jurisdiction"),
      },
      cards: deepTimeline
        ? Array.from({ length: 10 }, (_, i) => {
            const page = Number(url.searchParams.get("cursor") ?? 0);
            const id = page === 3 && i === 9 ? "fixture-a" : `deep-${page}-${i}`;
            const item = card(id);
            return { key: id, anchorAt: now, item: { ...item, title: added ? "更新后的矿业动态" : item.title }, group: null };
          })
        : [
            {
              key: "fixture-a",
              anchorAt: now,
              item: card(),
              group: unreadGroup
                ? { factId: "fixture-fact", story: null, additionalSourceCount: 1, reportCount: 2, developmentCount: 1, memberIds: ["fixture-a", "fixture-b"] }
                : null,
            },
          ],
      nextCursor: deepTimeline && Number(url.searchParams.get("cursor") ?? 0) < 3 ? String(Number(url.searchParams.get("cursor") ?? 0) + 1) : null,
      refreshAt: null,
      hot: null,
      dayCounts: {},
      generatedAt: now,
    });
  if (url.pathname === "/api/site/groups/fixture-fact/reports")
    return answer({
      factId: "fixture-fact",
      revision: "1",
      nextCursor: null,
      reports: [
        {
          id: "fixture-b",
          title: "新到的矿业动态",
          summary: "合成导读",
          source: { id: "fixture-source-b", name: "另一合成来源", kind: "rss", firstParty: false },
          timelineAt: now,
          sourceTime: null,
          originalUrl: "https://example.invalid/other",
          selected: true,
        },
      ],
    });
  if (url.pathname === "/api/site/items/fixture-b") return answer({ ...detail, id: "fixture-b", title: "新到的矿业动态" });
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
      filters: {
        channel: url.searchParams.get("channel") ?? "all",
        category: url.searchParams.get("category"),
        tag: null,
        q: url.searchParams.get("q"),
        tab: "time",
      },
      items: deepPool
        ? Array.from({ length: 20 }, (_, offset) => {
            const index = (Number(url.searchParams.get("page") || 1) - 1) * 20 + offset - (added ? 2 : 0);
            const item = card(index === 64 ? "fixture-a" : `pool-${index}`);
            return {
              ...item,
              title: index === 64 ? item.title : `合成分页报道 ${index}`,
              timelineAt: new Date(Date.parse(now) - index * 86400000).toISOString(),
              category: "commodity_market",
            };
          })
        : withdrawn
          ? added
            ? [card("fixture-new")]
            : []
          : added
            ? [card("fixture-new"), card()]
            : [card()],
      page: Number(url.searchParams.get("page") || 1),
      pageCount: 51,
      total: deepPool ? (added ? 83 : 81) : 1005,
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
async function openQualifiedReader(page: Page, path = "/all", expectedVersion = "1") {
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
  const revalidation = path.split("?")[0] === "/all" ? page.waitForResponse((response) => new URL(response.url()).pathname === "/all.data") : null;
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
    if (deepTimeline) await expect(page.getByRole("heading", { name: "新到的矿业动态" }).first()).toBeVisible();
    else {
      await expect(page.getByRole("heading", { name: "可核对的矿业动态" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "新到的矿业动态" })).toHaveCount(0);
    }
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
  const tabs = page.getByRole("navigation", { name: "底部导航" });
  await expect(tabs.getByRole("link")).toHaveCount(5);
  await expect(tabs.getByRole("link", { name: "金属价格", exact: true })).toBeVisible();
  await expect(tabs.getByRole("link", { name: "我的", exact: true })).toBeVisible();
  await expect(tabs.getByRole("link", { name: "精选", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("navigation", { name: "底部导航" }).getByRole("link", { name: "热点榜" })).toBeVisible();
  const mobileCard = page.locator('[data-item-id="fixture-a"]');
  await expect(mobileCard.locator("header time")).toBeVisible();
  const rowBounds = await mobileCard.boundingBox();
  const slotBounds = await mobileCard.locator("..").boundingBox();
  assert.ok(rowBounds && slotBounds && Math.abs(rowBounds.x - slotBounds.x) < 1, "phone cards use the full row without a separate time column");
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
  await readingTools.getByRole("button", { name: "目录", exact: true }).click();
  await page.getByRole("navigation", { name: "手机文章目录" }).getByRole("link", { name: "正文第二节" }).click();
  await expect(page).toHaveURL(/#section-two$/);
  await readingTools.getByRole("button", { name: "目录", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "手机文章目录" }).getByRole("link", { name: "正文第二节" })).toHaveAttribute("aria-current", "location");
  await outlineDialog.getByRole("button", { name: "关闭", exact: true }).click();
  const picture = page.getByRole("button", { name: "查看大图：合成矿山图片" });
  await picture.click();
  await expect(page.getByRole("dialog", { name: "文章图片" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picture).toBeFocused();
  await page.route("**/og/posters/fixture-a.png", (route) => route.fulfill({ status: 503, body: "unavailable" }));
  await page.mouse.wheel(0, -500);
  await readingTools.getByRole("button", { name: "分享", exact: true }).click();
  await page.getByRole("button", { name: "分享图片", exact: true }).click();
  const poster = page.getByRole("dialog", { name: "分享图片" });
  await expect(poster.getByText("图片暂时无法加载，请重试或分享文章链接。")).toBeVisible();
  await page.unroute("**/og/posters/fixture-a.png");
  await page.route("**/og/posters/fixture-a.png", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBusAAAAASUVORK5CYII=", "base64"),
    }),
  );
  await poster.getByRole("button", { name: "重试" }).click();
  await expect(poster.getByRole("img")).toBeVisible();
  await expect(poster.getByRole("link", { name: "保存图片" })).toHaveAttribute("download", "aimine-fixture-a.png");
  await page.keyboard.press("Escape");

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

async function loadFourTimelinePages(page: Page) {
  const viewport = page.viewportSize()!;
  await page.mouse.move(viewport.width / 2, Math.min(600, viewport.height - 100));
  for (const size of [20, 30]) {
    // Scroll the viewport like a reader; a card node can be replaced during loader refresh.
    await page.mouse.wheel(0, await page.evaluate(() => document.documentElement.scrollHeight));
    await expect.poll(() => page.locator("[data-card-key]").count()).toBeGreaterThanOrEqual(size);
  }
  await page.getByRole("button", { name: "加载更多", exact: true }).click();
  await expect(page.locator("[data-card-key]")).toHaveCount(40);
}

for (const scenario of ["arrivals", "revision check", "reader scroll during check"] as const) {
  test(`return to the filtered fourth pool page after detail reload respects ${scenario}`, { timeout: 30000 }, async (t) => {
    deepPool = true;
    withdrawn = false;
    added = false;
    const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, reducedMotion: "reduce" });
    let releaseCheck = () => {};
    t.after(async () => {
      releaseCheck();
      deepPool = false;
      added = false;
      readerWithdrawalVersion = "1";
      await context.close();
    });
    await isolateBrowser(context, [origin]);
    const page = await context.newPage();
    const path = "/all?channel=firstParty&category=commodity_market&page=4";
    await openQualifiedReader(page, path);
    await expect(page.getByText("第 4 页 · 共 81 条动态", { exact: true })).toBeVisible();
    const link = page.locator('[data-item-id="fixture-a"] h3 a');
    await page.keyboard.press("PageDown");
    await page.waitForTimeout(200);
    await page.mouse.move(800, 500);
    await page.mouse.wheel(0, (await link.evaluate((node) => node.getBoundingClientRect().top)) - 350);
    await expect.poll(async () => Math.abs((await link.evaluate((node) => node.getBoundingClientRect().top)) - 350)).toBeLessThan(30);
    await link.hover();
    const top = await link.evaluate((node) => node.getBoundingClientRect().top);
    assert.ok(top > 72 && top < 800, "the selected article is in the reader's viewport before opening it");
    await link.click();
    await expect(page).toHaveURL(`${origin}/items/fixture-a`);
    await page.getByRole("button", { name: "收藏", exact: true }).click();
    await page.reload();
    await expect(page.getByRole("region", { name: "阅读内容", exact: true })).toHaveAttribute("aria-busy", "false");
    await page.getByRole("button", { name: "取消收藏", exact: true }).click();
    added = true;
    if (scenario === "revision check") readerWithdrawalVersion = "2";
    if (scenario === "reader scroll during check") {
      const gate = new Promise<void>((resolve) => {
        releaseCheck = resolve;
      });
      await page.route(
        `${origin}/api/site/content-version`,
        async (route) => {
          await gate;
          await route.continue();
        },
        { times: 1 },
      );
    }
    await page.getByRole("button", { name: "返回", exact: true }).click();
    await expect(page).toHaveURL(`${origin}${path}`);
    await expect(page.getByText("第 4 页 · 共 83 条动态", { exact: true })).toBeVisible();
    let expectedTop = top;
    if (scenario === "reader scroll during check") {
      await expect(page.getByRole("region", { name: "阅读内容", exact: true })).toHaveAttribute("aria-busy", "true");
      const beforeScroll = await page.evaluate(() => scrollY);
      await page.mouse.move(800, 500);
      await page.mouse.wheel(0, 400);
      await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(beforeScroll + 300);
      expectedTop = await link.evaluate((node) => node.getBoundingClientRect().top);
      releaseCheck();
    }
    await expect(page.getByRole("region", { name: "阅读内容", exact: true })).toHaveAttribute("aria-busy", "false");
    await expect.poll(async () => Math.abs((await link.evaluate((node) => node.getBoundingClientRect().top)) - expectedTop)).toBeLessThan(80);
    // The existing layout-settle pass must not move a restored reader again.
    await page.waitForTimeout(300);
    assert.ok(Math.abs((await link.evaluate((node) => node.getBoundingClientRect().top)) - expectedTop) < 80);
  });
}

test("a new category starts at the top while Back restores the prior category depth", { timeout: 45000 }, async (t) => {
  deepTimeline = true;
  withdrawn = false;
  added = false;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  t.after(async () => {
    deepTimeline = false;
    await context.close();
  });
  await isolateBrowser(context, [origin]);
  const page = await context.newPage();
  await openQualifiedReader(page, "/");
  await loadFourTimelinePages(page);
  const before = calls.length;
  await page.locator('nav[aria-label="新闻分类"] a[href="/?category=company_project"]').click();
  await expect(page).toHaveURL(`${origin}/?category=company_project`);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(150);
  await expect.poll(() => page.locator("[data-card-key]").count()).toBeLessThan(40);
  // The near-viewport prefetch may load page two. It must not restore the old manual fourth page.
  assert.ok(!calls.slice(before).some((url) => url.includes("category=company_project") && url.includes("cursor=3")));
  await page.goBack();
  await expect(page).toHaveURL(`${origin}/`);
  await expect(page.locator("[data-card-key]")).toHaveCount(40);
});

for (const width of [390, 1440]) {
  test(`return from the fourth timeline page revalidates its depth and restores the article anchor at ${width}px`, { timeout: 45000 }, async (t) => {
    deepTimeline = true;
    withdrawn = false;
    added = false;
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    t.after(async () => {
      deepTimeline = false;
      await context.close();
    });
    await isolateBrowser(context, [origin]);
    const page = await context.newPage();
    await openQualifiedReader(page, "/");
    await loadFourTimelinePages(page);
    added = true;
    await checkVersionOnFocus(page, "1");
    await page.getByRole("button", { name: "加载最新", exact: true }).click();
    await expect(page.getByRole("button", { name: "加载最新", exact: true })).toHaveCount(0);
    const link = page.locator('[data-card-key="fixture-a"] h3 a');
    // Forty old cards can still exist while the new loader data is committing.
    // The refreshed last card proves that all four fresh pages have rendered.
    await expect(link).toHaveText("更新后的矿业动态");
    await expect(page.locator("[data-card-key]")).toHaveCount(40);
    await expect(page.getByText("正在加载", { exact: true })).toHaveCount(0);
    // A reader's wheel input supersedes any delayed restoration from "load latest".
    await page.mouse.move(width / 2, 500);
    await page.mouse.wheel(0, await page.evaluate(() => document.documentElement.scrollHeight));
    await link.hover();
    const top = await link.evaluate((node) => node.getBoundingClientRect().top);
    const homeKey = await page.evaluate(() => history.state.key);
    await link.click();
    await expect(page).toHaveURL(`${origin}/items/fixture-a`);
    await expect(page.getByRole("heading", { name: "可核对的矿业动态", exact: true })).toBeVisible();
    t.diagnostic(
      `saved fourth-page position: ${await page.evaluate((key) => {
        const saved = JSON.parse(sessionStorage.getItem(`amp:list:${key}`) ?? "null");
        return JSON.stringify(saved && { scrollY: saved.scrollY, anchor: saved.anchor, batches: saved.data.batches });
      }, homeKey)}`,
    );
    await page.goBack();
    await expect(page.locator("[data-card-key]")).toHaveCount(40);
    await expect.poll(async () => Math.abs((await link.evaluate((node) => node.getBoundingClientRect().top)) - top)).toBeLessThan(80);
    assert.ok(
      (await page.evaluate(() => sessionStorage.getItem(`amp:list:${history.state.key}`)))?.includes('"cards":[]'),
      "restoration keeps references and depth, not stale article copies",
    );
  });
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
    if (width === 1440) {
      const position = await page.evaluate(() => history.state.idx);
      const current = page.getByRole("navigation", { name: "本文目录" }).getByRole("link", { name: "正文第二节" });
      await current.click();
      await expect(current).toHaveAttribute("aria-current", "location");
      assert.equal(await page.evaluate(() => history.state.idx), position);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const target = document.getElementById("section-two")!;
            const landed = target.getBoundingClientRect().top <= (parseFloat(getComputedStyle(target).scrollMarginTop) || 0) + 1;
            return window.scrollY > 0 && (landed || window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4);
          }),
        )
        .toBe(true);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      await expect(current).not.toHaveAttribute("aria-current", "location");
    }
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
  Object.assign(searchTimes, { newsStart: 0, newsEnd: 0, policyStart: 0, policyEnd: 0 });
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

for (const width of [390, 1440])
  test(`unread groups remain until every selected member is read at ${width}px`, { timeout: 30000 }, async () => {
    unreadGroup = true;
    withdrawn = false;
    added = false;
    const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: "reduce" });
    try {
      await isolateBrowser(context, [origin]);
      await context.addInitScript(() => localStorage.setItem("amp-read-items", JSON.stringify(["fixture-a"])));
      const page = await context.newPage();
      await page.goto(origin);
      const toggle = () => page.getByRole("button", { name: "只看未读", exact: true }).filter({ visible: true });
      await toggle().click();
      await expect(toggle()).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("heading", { name: "可核对的矿业动态" })).toBeVisible();
      await page.getByRole("button", { name: "另有 1 家信源报道", exact: true }).click();
      await expect(page.getByText("未读", { exact: true })).toBeVisible();
      await page.screenshot({ path: `.verify/group-unread-${width}.png` });
      await page.getByRole("link", { name: "新到的矿业动态", exact: true }).click();
      await expect(page.getByRole("heading", { name: "新到的矿业动态", exact: true })).toBeVisible();
      await page.goBack();
      await expect(page.getByText("没有未读的精选内容", { exact: true })).toBeVisible();
      await expect(toggle()).toHaveAttribute("aria-pressed", "true");
      await toggle().click();
      await expect(page.getByRole("heading", { name: "可核对的矿业动态" })).toBeVisible();
    } finally {
      unreadGroup = false;
      await context.close();
    }
  });

test("phone feed scope and sheet preserve mining filters and close on desktop resize", { timeout: 30000 }, async (t) => {
  withdrawn = false;
  added = false;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  context.setDefaultTimeout(5000);
  let filterPhase = "open phone page";
  t.after(() => t.diagnostic(`last filter phase: ${filterPhase}`));
  let releaseChoices!: () => void;
  const choicesReady = new Promise<void>((resolve) => {
    releaseChoices = resolve;
  });
  try {
    await isolateBrowser(context, [origin]);
    const page = await context.newPage();
    await page.route("**/api/site/jurisdictions", async (route) => {
      await choicesReady;
      await route.continue();
    });
    await page.goto(origin);
    const bar = page.locator("[data-phone-bar]");
    await expect(bar.getByRole("navigation", { name: "看精选或全部" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "国家 / 地区" })).toBeHidden();
    await page.screenshot({ path: ".verify/feed-phone-bar-390.png" });
    filterPhase = "choose jurisdiction";
    await bar.getByRole("button", { name: "筛选", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "筛选", exact: true });
    await sheet.getByRole("combobox", { name: "国家 / 地区" }).selectOption("none");
    releaseChoices();
    await expect(sheet.getByText("按事件或影响地区 · 数字为已识别资讯数")).toBeVisible();
    await expect(sheet.getByRole("combobox", { name: "国家 / 地区" })).toHaveValue("none");
    await sheet.getByRole("button", { name: "筛选", exact: true }).click();
    await expect(sheet).not.toBeVisible();
    await expect(page).toHaveURL(/jurisdiction=none/);
    filterPhase = "combine category and source";
    await bar.getByRole("button", { name: "筛选（已选）" }).click();
    await sheet.getByRole("link", { name: "企业与项目", exact: true }).click();
    await expect(page).toHaveURL(/category=company_project/);
    await expect(sheet).not.toBeVisible();
    await expect(page.getByRole("link", { name: "取消筛选：企业与项目", exact: true })).toBeVisible();
    assert.equal(new URL(page.url()).searchParams.get("jurisdiction"), "none");
    await bar.getByRole("button", { name: "筛选（已选）" }).click();
    await sheet.getByRole("link", { name: "一手来源", exact: true }).click();
    await expect(page).toHaveURL(/channel=firstParty/);
    await expect(sheet).not.toBeVisible();
    await expect(page.getByRole("link", { name: "取消筛选：一手来源", exact: true })).toBeVisible();
    assert.equal(new URL(page.url()).searchParams.get("category"), "company_project");
    filterPhase = "remove category";
    await page.getByRole("link", { name: "取消筛选：企业与项目", exact: true }).click();
    await expect(page).not.toHaveURL(/category=/);
    await expect(page.getByRole("link", { name: "取消筛选：企业与项目", exact: true })).toHaveCount(0);
    assert.equal(new URL(page.url()).searchParams.get("channel"), "firstParty");
    await bar.getByRole("button", { name: "筛选（已选）" }).click();
    await sheet.getByRole("link", { name: "企业与项目", exact: true }).click();
    await expect(page).toHaveURL(/category=company_project/);
    await expect(sheet).not.toBeVisible();
    await expect(page.getByRole("link", { name: "取消筛选：企业与项目", exact: true })).toBeVisible();
    filterPhase = "switch feed scope";
    await bar.getByRole("navigation", { name: "看精选或全部" }).getByRole("link", { name: "全部", exact: true }).click();
    await expect(page).toHaveURL(/\/all\?/);
    await expect(bar.getByRole("navigation", { name: "看精选或全部" }).getByRole("link", { name: "全部", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await bar.getByRole("button", { name: "筛选（已选）" }).click();
    await sheet.getByText("来源、矿种与日期筛选", { exact: true }).click();
    await expect(sheet.getByLabel("开始日期")).toBeVisible();
    filterPhase = "resize to desktop";
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(sheet).not.toBeVisible();
    await expect(page.getByRole("combobox", { name: "国家 / 地区" })).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "来源属性" }).filter({ visible: true }).getByRole("link", { name: "一手来源", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    const categories = page.getByRole("navigation", { name: "新闻分类" }).filter({ visible: true });
    const naturalSize = await categories.evaluate((node) => ({
      trackWidth: node.scrollWidth,
      viewportWidth: node.parentElement!.clientWidth,
      wrapperWidth: node.parentElement!.parentElement!.clientWidth,
    }));
    t.diagnostic(JSON.stringify(naturalSize));
    if (naturalSize.trackWidth <= naturalSize.wrapperWidth + 2) await expect(page.getByRole("button", { name: "新闻分类向右滚动", exact: true })).toBeHidden();
    // Host CJK fonts can fit all categories at desktop width. Exercise a constrained
    // container as well, so the overflow controls are verified without assuming font metrics.
    await categories.evaluate((node) => {
      node.parentElement!.parentElement!.style.maxWidth = "560px";
    });
    filterPhase = "desktop scroll right";
    await page.getByRole("button", { name: "新闻分类向右滚动", exact: true }).click();
    await expect.poll(() => categories.evaluate((node) => node.parentElement!.scrollLeft)).toBeGreaterThan(0);
    filterPhase = "desktop scroll left";
    await page.getByRole("button", { name: "新闻分类向左滚动", exact: true }).click();
    filterPhase = "desktop category";
    await categories.getByRole("link", { name: "政策监管", exact: true }).click();
    await expect(page).toHaveURL(/category=policy_regulation/);
    assert.equal(new URL(page.url()).searchParams.get("channel"), "firstParty");
    assert.equal(new URL(page.url()).searchParams.get("jurisdiction"), "none");
  } finally {
    releaseChoices();
    await context.close();
  }
});

test("reader links prefetch on press rather than hover, and failed copy never claims success", { timeout: 60000 }, async () => {
  withdrawn = false;
  added = false;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
  try {
    const blocked = await isolateBrowser(context, [origin]);
    const page = await context.newPage();
    await page.goto(origin);
    const title = page.getByRole("link", { name: "可核对的矿业动态", exact: true }).first();
    await expect(title).toBeVisible();
    await title.hover();
    await page.waitForTimeout(150);
    const prefetched = page.locator('link[rel="prefetch"][href*="fixture-a"]');
    assert.equal(await prefetched.count(), 0, "passing the pointer over a card does not fetch it");
    await title.dispatchEvent("pointerdown", { pointerType: "mouse", button: 0 });
    await expect.poll(() => prefetched.count()).toBeGreaterThan(0);
    await title.click();
    await expect(page).toHaveURL(`${origin}/items/fixture-a`);
    await expect(prefetched).toHaveCount(0);
    await page.goto(`${origin}/agent`);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error("fixture denied");
          },
        },
      });
      document.execCommand = () => false;
    });
    const copy = page.getByRole("button", { name: /复制/ }).first();
    await copy.click();
    await expect(copy).toHaveAccessibleName("复制失败，请手动选择");
    assert.equal(await page.locator("textarea").count(), 0);
    await page.evaluate(() => {
      document.execCommand = () => true;
    });
    await copy.click();
    await expect(copy).toHaveAccessibleName("已复制");
    assert.deepEqual(blocked, []);
  } finally {
    await context.close();
  }
});

test("about flow uses supplied sources and headlines on desktop and phone, with theme-aware reduced motion", { timeout: 60000 }, async () => {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "zh-CN", reducedMotion: width === 390 ? "reduce" : "no-preference" });
    try {
      const blocked = await isolateBrowser(context, [origin]),
        page = await context.newPage(),
        errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${origin}/about`);
      const canvas = page.locator("canvas");
      await expect(canvas).toBeVisible();
      await expect(page.getByRole("link", { name: /最近精选.*可核对的矿业动态/ }).filter({ visible: true })).toHaveAttribute("href", "/items/fixture-a");
      assert.equal(await canvas.evaluate((e) => e.tabIndex), -1);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await expect.poll(() => canvas.evaluate((e) => (e as HTMLCanvasElement).width)).toBeGreaterThan(300);
      if (width === 1440) {
        const first = await canvas.evaluate((e) => (e as HTMLCanvasElement).toDataURL());
        await expect.poll(() => canvas.evaluate((e) => (e as HTMLCanvasElement).toDataURL())).not.toBe(first);
      }
      const light = await canvas.evaluate((e) => (e as HTMLCanvasElement).toDataURL());
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await expect.poll(() => canvas.evaluate((e) => (e as HTMLCanvasElement).toDataURL())).not.toBe(light);
      await page.screenshot({ path: `.verify/about-flow-${width}.png` });
      assert.deepEqual(errors, []);
      assert.deepEqual(blocked, []);
    } finally {
      await context.close();
    }
  }
});

test("phone page bars return through reading history and fall back to the parent on a direct visit", { timeout: 60000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: "zh-CN", reducedMotion: "reduce" });
  try {
    const blocked = await isolateBrowser(context, [origin]),
      page = await context.newPage();
    await page.goto(`${origin}/starred`);
    const bar = page.locator("[data-phone-bar]");
    await expect(bar.getByRole("button", { name: "我的", exact: true })).toBeVisible();
    await bar.getByRole("button", { name: "我的", exact: true }).click();
    await expect(page).toHaveURL(`${origin}/more`);
    await page.getByRole("link", { name: "Agent 接入", exact: true }).filter({ visible: true }).click();
    await expect(page).toHaveURL(`${origin}/agent`);
    await expect(bar.getByRole("button", { name: "返回", exact: true })).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 1200));
    await expect(bar.getByText("Agent 接入", { exact: true })).toHaveAttribute("aria-hidden", "false");
    await expect
      .poll(() => page.getByRole("tablist", { name: "接入方式" }).evaluate((e) => e.parentElement!.getBoundingClientRect().top))
      .toBeGreaterThanOrEqual(47);
    await page.getByRole("link", { name: /反馈/ }).filter({ visible: true }).first().click();
    await expect(page).toHaveURL(/\/feedback(?:\?|$)/);
    await bar.getByRole("button", { name: "返回", exact: true }).click();
    await expect(page).toHaveURL(`${origin}/agent`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.deepEqual(blocked, []);
  } finally {
    await context.close();
  }
});
