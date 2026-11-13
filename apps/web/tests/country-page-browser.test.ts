// Production SSR + browser against the labelled read-only demo API. No database, models or external network.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { chromium, expect, type Browser } from "@playwright/test";
import { schemas } from "@amp/contracts/http/public";
import { browserExecutable, isolateBrowser } from "./browser.ts";
import { webEnvironment } from "../runtime-env.ts";

let browser: Browser,
  web: ChildProcess,
  origin = "";
let emptyNews = false,
  emptyPolicies = false,
  policyScope = true,
  failNews = false,
  failPolicies = false;
const failedMaps = new Set<string>();
let withdrawn: string | null = null;
const policyList = schemas.PolicyListResponse.parse(JSON.parse(readFileSync("tests/fixtures/policy-public/list.json", "utf8")));
const policy = policyList.items[0]!;
const timeline = schemas.ReportGroupedTimelineResponse.parse(JSON.parse(readFileSync("scripts/verify/tests/fixtures/timeline-response.json", "utf8")));
const now = new Date().toISOString();
const item = (id: string, title: string) => ({
  ...timeline.cards[0]!.item,
  id,
  title,
  publishedAt: now,
  timelineAt: now,
});
const places = [
  { code: "AR", label: "阿根廷" },
  { code: "CN", label: "中国" },
].map((one) => ({ ...one, kind: "country", news_scope: true, policy_scope: true, news_count: 6, policy_count: 5 }));
const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://fixture");
  const send = (body: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/api/site/meta") return send({ changelogVersion: null });
  if (url.pathname === "/api/site/content-version") return send({ version: "1", withdrawalVersion: "1" });
  if (url.pathname === "/api/site/items/availability")
    return send(Object.fromEntries((url.searchParams.get("ids") ?? "").split(",").map((id) => [id, id === withdrawn ? "unavailable" : "public"])));
  if (url.pathname === "/api/site/jurisdictions") return send(places.map((one) => ({ ...one, policy_scope: policyScope })));
  if (url.pathname === "/api/site/pool") {
    if (failNews) return send({ code: "unavailable" }, 503);
    const code = url.searchParams.get("jurisdiction");
    const items = emptyNews
      ? []
      : Array.from({ length: 6 }, (_, i) => item(`demo-${code}-${i}`, `演示：${code}矿业动态${i + 1}`)).filter((one) => one.id !== withdrawn);
    return send(
      schemas.ReportGroupedPoolResponse.parse({
        filters: { channel: "all", category: null, tag: null, topic: null, q: null, tab: "time", jurisdiction: code },
        items,
        page: 1,
        pageCount: 1,
        total: items.length,
        todayCount: items.length,
        freshness: now,
        generatedAt: now,
      }),
    );
  }
  if (url.pathname === "/api/site/news-map") {
    const window = url.searchParams.get("window") as "1d" | "7d" | "30d";
    if (failedMaps.has(window)) return send({ code: "unavailable" }, 503);
    return send({
      window,
      from: new Date(Date.now() - 7 * 86400000).toISOString(),
      to: now,
      countries: places.map(({ code, label }) => ({ code, label, count: window === "1d" ? 3 : 12, previous: 1 })),
    });
  }
  if (url.pathname === "/api/site/policies") {
    if (failPolicies) return send({ code: "unavailable" }, 503);
    assert.equal(url.searchParams.get("page_size"), "5");
    const items = emptyPolicies ? [] : Array.from({ length: 5 }, (_, i) => ({ ...policy, id: `demo-law-${i}`, title: `演示法规 ${i + 1}` }));
    return send({ ...policyList, items, total: items.length, page_size: 5 });
  }
  if (url.pathname === "/api/site/timeline")
    return send({
      ...timeline,
      cards: [{ key: "world", anchorAt: now, item: item("world", "全球演示动态"), group: null }],
      generatedAt: now,
    });
  return send({ code: "not_found" }, 404);
});

before(async () => {
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const reservation = createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  web = spawn(process.execPath, ["apps/web/server.ts"], {
    env: webEnvironment({
      PATH: process.env.PATH,
      NODE_ENV: "production",
      WEB_PORT: String(port),
      WEB_HOST: "127.0.0.1",
      SITE_URL: `http://127.0.0.1:${port}`,
      PRIVATE_HOST: "private.localhost",
      TRUST_PROXY: "false",
      API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
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
  await new Promise<void>((resolve) => api.close(() => resolve()));
});
async function open(path = "/country/AR", width = 390) {
  const context = await browser.newContext({
    viewport: { width, height: width === 390 ? 844 : 1000 },
    serviceWorkers: "block",
    reducedMotion: "reduce",
    timezoneId: "America/Argentina/Buenos_Aires",
  });
  await isolateBrowser(context, [origin]);
  const page = await context.newPage();
  await page.goto(`${origin}${path}`);
  return { context, page };
}

test("country news is in the SSR HTML; the real page has counts, all reports, five policies and both onward links", async () => {
  const response = await fetch(`${origin}/country/AR`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /阿根廷矿业动态/);
  assert.match(html, /演示：AR矿业动态1/);
  assert.match(html, /rel="canonical" href="[^"?]+\/country\/AR"/);
  const { context, page } = await open("/country/AR", 1440);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("阿根廷矿业动态");
  await expect(page.getByText("今天 3 条 · 近 7 天 12 条", { exact: true })).toBeVisible();
  await expect(page.locator("#country-news + *")).toBeVisible();
  await expect(page.locator("a[href^='/items/demo-AR-']")).toHaveCount(6);
  await expect(page.locator("a[href^='/policies/demo-law-']")).toHaveCount(5);
  await expect(page.locator("section[aria-labelledby='country-policies']")).toContainText("法规 · 已公布");
  assert.equal(await page.getByRole("link", { name: "更多阿根廷动态 →" }).getAttribute("href"), "/all?jurisdiction=AR");
  assert.equal(await page.getByRole("link", { name: "全部阿根廷法规 →" }).getAttribute("href"), "/policies?jurisdiction=AR");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await context.close();
});

test("only the launch country codes in their exact uppercase form exist", async () => {
  for (const path of ["/country/CL", "/country/ar", "/country/ARG", "/en/country/CL"]) assert.equal((await fetch(`${origin}${path}`)).status, 404, path);
});

test("country cards join the existing withdrawal guard and remove a withdrawn title and link", async () => {
  const { context, page } = await open();
  let version = "1";
  try {
    await page.route("**/api/site/content-version", (route) => route.fulfill({ json: { version: "1", withdrawalVersion: version } }));
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.locator("[data-item-id='demo-AR-0']")).toHaveCount(1);
    withdrawn = "demo-AR-0";
    version = "2";
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("status")).toContainText("有 1 条内容已撤回");
    await expect(page.getByRole("link", { name: "演示：AR矿业动态1" })).toHaveCount(0);
    await expect(page.locator("[data-item-id]")).toHaveCount(5);
  } finally {
    withdrawn = null;
    await context.close();
  }
});

test("optional counts and policies can fail independently; unknown is never printed as zero", async () => {
  const { context, page } = await open();
  try {
    for (const field of ["empty", "scope", "failed"]) {
      emptyPolicies = field === "empty";
      policyScope = field !== "scope";
      failPolicies = field === "failed";
      await page.reload();
      await expect(page.getByRole("heading", { name: "法规政策", exact: true })).toHaveCount(0);
      await expect(page.getByText("演示：AR矿业动态1")).toBeVisible();
    }
    failedMaps.add("1d");
    await page.reload();
    await expect(page.getByText("今天 3 条")).toHaveCount(0);
    await expect(page.getByText("近 7 天 12 条", { exact: true })).toBeVisible();
    failedMaps.add("7d");
    await page.reload();
    await expect(page.getByText(/今天 0 条|近 7 天 0 条|近 7 天 12 条/)).toHaveCount(0);
  } finally {
    emptyPolicies = false;
    policyScope = true;
    failPolicies = false;
    failedMaps.clear();
    await context.close();
  }
});

test("empty news is honest; a failed read uses the same unavailable page and HTTP 503 as /all", async () => {
  const { context, page } = await open();
  try {
    emptyNews = true;
    assert.equal((await page.reload())!.status(), 200);
    await expect(page.getByText("阿根廷近期没有收录动态。")).toBeVisible();
    await expect(page.getByRole("link", { name: "看全球精选" })).toHaveAttribute("href", "/");
    emptyNews = false;
    failNews = true;
    for (const path of ["/country/AR", "/all?jurisdiction=AR"]) {
      assert.equal((await page.goto(`${origin}${path}`))!.status(), 503);
      await expect(page.getByRole("heading", { name: /暂时/ })).toBeVisible();
    }
  } finally {
    emptyNews = false;
    failNews = false;
    await context.close();
  }
});

test("choosing China changes address and the remembered home country; worldwide returns home", async () => {
  const { context, page } = await open();
  await page.getByLabel("首页先看哪个国家 / 地区").selectOption("CN");
  await expect(page).toHaveURL(`${origin}/country/CN`);
  await page.goto(`${origin}/`);
  await expect(page.locator("[data-home-country='CN']")).toBeVisible();
  await page.goto(`${origin}/country/CN`);
  await page.getByLabel("首页先看哪个国家 / 地区").selectOption("world");
  await expect(page).toHaveURL(`${origin}/`);
  await expect(page.locator("[data-home-country='line']")).toContainText("首页先看全球。");
  await context.close();
});

test("English titles, metadata and navigation stay in English", async () => {
  const { context, page } = await open("/en/country/AR");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Argentina mining news");
  await expect(page.locator("meta[name='description']")).toHaveAttribute("content", /mining announcements.*Argentina/);
  await expect(page.locator("link[rel='canonical']")).toHaveAttribute("href", /\/en\/country\/AR$/);
  await expect(page.getByRole("link", { name: "More news for Argentina →" })).toHaveAttribute("href", "/en/all?jurisdiction=AR");
  await page.getByLabel("Country / region the home page opens with").selectOption("CN");
  await expect(page).toHaveURL(`${origin}/en/country/CN`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("China mining news");
  await context.close();
});
