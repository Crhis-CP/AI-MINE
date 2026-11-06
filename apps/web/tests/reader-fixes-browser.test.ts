// Run after `npm run build --workspace @amp/web`. The reader defects the Owner hit on the live site (TASK-0568),
// end to end on the production web server with a synthetic read-only API: the news map on phones and where a
// country leads, the desktop header search, the light/dark switch on every phone page, and the country chips on
// 全部动态. No external network or accounts.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { chromium, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { addDays, beijingDate, beijingMidnight } from "@amp/contracts/time";
import { browserExecutable, isolateBrowser } from "./browser.ts";
import { webEnvironment } from "../runtime-env.ts";

let browser: Browser,
  web: ChildProcess,
  origin = "";
const now = new Date();
const today = beijingDate(now);
/** The map's window starts at a Beijing midnight, as the API computes it. */
const windowFrom = (days: number) => beijingMidnight(addDays(today, 1 - days)).toISOString();
const pools: URLSearchParams[] = [];

const JURISDICTIONS = [
  ["CL", "智利", 40],
  ["AU", "澳大利亚", 35],
  ["CA", "加拿大", 30],
  ["PE", "秘鲁", 25],
  ["CD", "刚果（金）", 20],
  ["ZA", "南非", 15],
  ["AR", "阿根廷", 12],
  ["US", "美国", 10],
  ["MN", "蒙古", 5],
  ["KZ", "哈萨克斯坦", 0],
] as const;

const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://fixture");
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  const send = (value: unknown) => res.end(JSON.stringify(value));
  const path = url.pathname;
  if (path === "/api/site/meta") return send({ changelogVersion: null });
  if (path === "/api/site/content-version") return send({ version: "1", withdrawalVersion: "1" });
  if (path === "/api/site/stats")
    return send({ sources: 1, sourceKinds: {}, heatOnlySources: 0, items: 1, selected: 1, dailies: 0, day: { collected: 0, selected: 0 } });
  if (path === "/api/site/timeline")
    return send({
      filters: { channel: "all", category: null, tag: null, topic: null },
      cards: [],
      nextCursor: null,
      refreshAt: null,
      hot: null,
      dayCounts: {},
      generatedAt: now.toISOString(),
    });
  if (path === "/api/site/news-map") {
    const window = (url.searchParams.get("window") ?? "7d") as "1d" | "7d" | "30d";
    const days = { "1d": 1, "7d": 7, "30d": 30 }[window];
    return send({
      window,
      from: windowFrom(days),
      to: now.toISOString(),
      countries: [
        { code: "CL", label: "智利", count: 9 * days, previous: 2 },
        { code: "PE", label: "秘鲁", count: 2 * days, previous: 1 },
        { code: "AR", label: "阿根廷", count: days, previous: 0 },
        { code: "AU", label: "澳大利亚", count: 4 * days, previous: 3 },
      ],
    });
  }
  if (path === "/api/site/jurisdictions")
    return send(
      JURISDICTIONS.map(([code, label, count]) => ({
        code,
        label,
        kind: "country",
        news_scope: true,
        policy_scope: false,
        news_count: count,
        policy_count: 0,
      })),
    );
  if (path === "/api/site/policies") return send({ items: [], total: 0, page: 1, page_size: 5 });
  if (path === "/api/site/pool") {
    pools.push(url.searchParams);
    return send({
      filters: {
        channel: "all",
        category: url.searchParams.get("category"),
        tag: null,
        topic: null,
        jurisdiction: url.searchParams.get("jurisdiction"),
        q: url.searchParams.get("q"),
        tab: "time",
        from: url.searchParams.get("from"),
      },
      items: [],
      page: 1,
      pageCount: 1,
      total: 0,
      todayCount: 0,
      freshness: now.toISOString(),
      generatedAt: now.toISOString(),
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

/** A fresh browser that may only reach the local web server; the caller closes it. */
async function open(width: number, touch = false): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce", hasTouch: touch, isMobile: touch });
  await isolateBrowser(context, [origin]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { context, page, errors };
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

test("phones and tablets show the news map, and a country opens all its news of the window", { timeout: 60000 }, async () => {
  for (const width of [344, 375, 390, 430, 800]) {
    const { context, page, errors } = await open(width, true);
    try {
      await page.goto(origin);
      const map = page.getByRole("region", { name: "资讯地图" });
      await expect(map).toBeVisible();
      await expect(map.getByRole("link", { name: /智利/ })).toBeVisible();
      assert.ok((await overflow(page)) <= 1, `no sideways scroll at ${width}px`);
      await page.screenshot({ path: `.verify/reader-fixes-home-${width}.png` });
      // A finger that lands beside the smallest dot (Argentina, next to Chile) still chooses it.
      const dot = await map
        .getByRole("link", { name: /阿根廷/ })
        .locator(".map-bubble")
        .boundingBox();
      assert.ok(dot && dot.width < 12, `the dot itself is small (${dot?.width}px)`);
      await page.touchscreen.tap(dot.x + dot.width / 2, dot.y + dot.height / 2 + 9);
      await expect(page).toHaveURL(`${origin}/all?jurisdiction=AR&from=${addDays(today, -6)}`);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
  const { context, page } = await open(390, true);
  try {
    await page.goto(origin);
    const map = page.getByRole("region", { name: "资讯地图" });
    await expect(map.getByRole("link", { name: /智利/ })).toHaveAttribute("href", `/all?jurisdiction=CL&from=${addDays(today, -6)}`);
    await map
      .getByRole("tab", { name: "30 天" })
      .or(map.getByRole("link", { name: "30 天" }))
      .or(map.getByRole("button", { name: "30 天" }))
      .click();
    await expect(map.getByRole("link", { name: /智利/ })).toHaveAttribute("href", `/all?jurisdiction=CL&from=${addDays(today, -29)}`);
    await map.getByRole("link", { name: /智利/ }).tap();
    await expect(page).toHaveURL(`${origin}/all?jurisdiction=CL&from=${addDays(today, -29)}`);
    assert.equal(pools.at(-1)?.get("jurisdiction"), "CL");
    assert.equal(pools.at(-1)?.get("from"), addDays(today, -29));
    // The country stays marked on 全部动态 and can be taken off there.
    await expect(page.getByRole("navigation", { name: "按国家查看" }).getByRole("link", { name: "取消筛选：智利" })).toBeVisible();
  } finally {
    await context.close();
  }
  // English: the map's link stays in English and the country is named in English.
  const english = await open(390, true);
  try {
    await english.page.goto(`${origin}/en`);
    await expect(english.page.getByRole("region", { name: "News map" }).getByRole("link", { name: /Chile/ })).toHaveAttribute(
      "href",
      `/en/all?jurisdiction=CL&from=${addDays(today, -6)}`,
    );
  } finally {
    await english.context.close();
  }
});

test("the desktop header searches 全部动态 in the page's language", { timeout: 60000 }, async () => {
  const { context, page, errors } = await open(1280);
  try {
    await page.goto(`${origin}/hot`);
    const search = page.getByRole("banner").getByRole("search");
    const field = search.getByRole("searchbox", { name: "搜索" });
    await expect(field).toHaveAttribute("placeholder", "搜索资讯与法规");
    await field.fill("  铜矿  ");
    await field.press("Enter");
    await expect(page).toHaveURL(`${origin}/all?q=${encodeURIComponent("铜矿")}`);
    // Empty input stays put.
    await page.goto(`${origin}/hot`);
    await page.getByRole("banner").getByRole("searchbox").press("Enter");
    await expect(page).toHaveURL(`${origin}/hot`);
    await page.goto(`${origin}/en/hot`);
    const englishField = page.getByRole("banner").getByRole("searchbox", { name: "Search" });
    await expect(page.getByRole("banner").getByRole("search")).toHaveAttribute("action", "/en/all");
    await englishField.fill("copper");
    await englishField.press("Enter");
    await expect(page).toHaveURL(`${origin}/en/all?q=copper`);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("every phone page has the light/dark switch at the top, and the desktop one names itself", { timeout: 90000 }, async () => {
  const { context, page, errors } = await open(390, true);
  try {
    // Pages with their own top bar, and pages that get the shell's top row instead.
    for (const path of ["/", "/all", "/hot", "/more", "/changelog", "/topics", "/nothing-here"]) {
      await page.goto(`${origin}${path}`);
      const toggles = page.locator("[data-theme-toggle]").filter({ visible: true });
      await expect(toggles, path).toHaveCount(1);
      const top = await toggles.first().evaluate((el) => el.getBoundingClientRect().top);
      assert.ok(top < 60, `${path}: the switch is in the top bar (${top}px)`);
      assert.ok((await overflow(page)) <= 1, `${path}: no sideways scroll`);
    }
    await page.goto(`${origin}/all`);
    const toggle = page.locator("[data-theme-toggle]").filter({ visible: true });
    const label = await toggle.getAttribute("aria-label");
    assert.match(label ?? "", /^切换到(深色|浅色)$/);
    await toggle.tap();
    const after = label === "切换到深色" ? "dark" : "light";
    await expect(page.locator("html")).toHaveAttribute("data-theme", after);
    await expect(toggle).toHaveAttribute("aria-label", after === "dark" ? "切换到浅色" : "切换到深色");
    await page.goto(`${origin}/en/more`);
    await expect(page.locator("[data-theme-toggle]").filter({ visible: true })).toHaveAttribute("aria-label", /^Switch to (dark|light)$/);
    // At 344px the feed bar still fits its controls.
    await page.setViewportSize({ width: 344, height: 800 });
    await page.goto(`${origin}/all`);
    const bar = page.locator("[data-phone-bar]");
    const right = await bar.evaluate((el) => Math.max(...[...el.querySelectorAll("a,button")].map((c) => c.getBoundingClientRect().right)));
    assert.ok(right <= 344, `the phone bar's controls stay on screen (${right}px)`);
    const overlap = await bar.evaluate((el) => {
      const [left, center, end] = [...el.querySelector("div")!.children].map((c) => c.getBoundingClientRect());
      return left!.right > center!.left + 1 || center!.right > end!.left + 1;
    });
    assert.equal(overlap, false, "the three parts of the phone bar do not overlap at 344px");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
  const desktop = await open(1280);
  try {
    await desktop.page.goto(`${origin}/hot`);
    const toggle = desktop.page.getByRole("banner").getByRole("button", { name: /^切换到(深色|浅色)$/ });
    await toggle.hover();
    await desktop.page.screenshot({ path: ".verify/reader-fixes-header-1280.png", clip: { x: 0, y: 0, width: 1280, height: 140 } });
    const name = await toggle.getAttribute("aria-label");
    await expect(desktop.page.getByRole("banner").getByText(name!, { exact: true })).toBeVisible();
    assert.equal(await desktop.page.locator("[data-phone-fallback-bar]").isVisible(), false);
  } finally {
    await desktop.context.close();
  }
});

test("全部动态 offers the top countries as chips that keep the other conditions", { timeout: 60000 }, async () => {
  for (const width of [1280, 390]) {
    const { context, page, errors } = await open(width, width < 961);
    try {
      await page.goto(`${origin}/all?category=commodity_market`);
      const row = page.getByRole("navigation", { name: "按国家查看" }).filter({ visible: true });
      await expect(row.getByRole("link")).toHaveCount(8);
      await expect(row.getByRole("link").first()).toContainText("智利");
      await expect(row.getByRole("link").first()).toContainText("40");
      await expect(row.getByRole("link", { name: /蒙古/ })).toHaveCount(0);
      await page.screenshot({ path: `.verify/reader-fixes-all-${width}.png` });
      await row.getByRole("link", { name: /秘鲁/ }).click();
      await expect(page).toHaveURL(`${origin}/all?category=commodity_market&jurisdiction=PE`);
      const chosen = row.getByRole("link", { name: "取消筛选：秘鲁" });
      await expect(chosen).toHaveAttribute("aria-current", "true");
      await chosen.click();
      await expect(page).toHaveURL(`${origin}/all?category=commodity_market`);
      // A country outside the top eight keeps a chip of its own while it is chosen.
      await page.goto(`${origin}/all?jurisdiction=MN`);
      await expect(row.getByRole("link", { name: "取消筛选：蒙古" })).toBeVisible();
      await row.getByRole("button", { name: "更多国家…" }).click();
      if (width < 961) await expect(page.getByRole("dialog", { name: "筛选", exact: true }).getByRole("combobox", { name: "国家 / 地区" })).toBeVisible();
      else await expect(page.locator("select[data-country-select]").filter({ visible: true })).toBeFocused();
      assert.ok((await overflow(page)) <= 1, `no sideways scroll at ${width}px`);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
  const english = await open(1280);
  try {
    await english.page.goto(`${origin}/en/all`);
    const row = english.page.getByRole("navigation", { name: "By country" });
    await expect(row.getByRole("link", { name: /Chile/ })).toHaveAttribute("href", "/en/all?jurisdiction=CL");
    await expect(row.getByRole("button", { name: "More countries…" })).toBeVisible();
  } finally {
    await english.context.close();
  }
});
