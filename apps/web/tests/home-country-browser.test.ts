// The home page opens with the reader's country (TASK-0633): the device's time zone suggests it, the reader's own choice
// replaces it and is remembered, a country without items falls back to the worldwide picks, and the HTML the server sends
// is the same for everyone. Run after `npm run build -w @amp/web`. Production web, synthetic read-only API.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { chromium, expect, type Browser } from "@playwright/test";
import { countryOfZone } from "../app/features/region/zones.ts";
import { browserExecutable, isolateBrowser } from "./browser.ts";
import { webEnvironment } from "../runtime-env.ts";

let browser: Browser,
  web: ChildProcess,
  origin = "";
const asked: string[] = [];
/** Items taken down by an operator: no longer listed and answered as unavailable (TASK-0637 review). */
const withdrawn = new Set<string>();
let withdrawals = 1;
const now = new Date().toISOString();
const card = (id: string, title: string) => ({
  id,
  title,
  summary: "合成导读",
  reason: null,
  publishedAt: now,
  timelineAt: now,
  category: null,
  tags: [],
  score: null,
  selected: true,
  channel: "news",
  source: { name: "合成来源" },
});
const place = (code: string, label: string, news: number) => ({
  code,
  label,
  kind: "country",
  news_scope: true,
  policy_scope: false,
  news_count: news,
  policy_count: 0,
});
const province = (code: string, label: string, news: number) => ({ ...place(code, label, news), kind: "subdivision", parent: "CN" });
const LOCAL: Record<string, number> = { AR: 7, CN: 3, "CN-XJ": 2 };

const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://fixture");
  const send = (value: unknown) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(value));
  };
  const country = url.searchParams.get("jurisdiction");
  if (url.pathname === "/api/site/meta") return send({ changelogVersion: null });
  if (url.pathname === "/api/site/content-version") return send({ version: "1", withdrawalVersion: String(withdrawals) });
  if (url.pathname === "/api/site/items/availability")
    return send(Object.fromEntries((url.searchParams.get("ids") ?? "").split(",").map((id) => [id, withdrawn.has(id) ? "unavailable" : "public"])));
  if (url.pathname === "/api/site/jurisdictions")
    return send([
      place("AR", "阿根廷", 40),
      place("CN", "中国", 90),
      place("CL", "智利", 55),
      place("JP", "日本", 0),
      province("CN-XJ", "新疆维吾尔自治区", 8),
      province("CN-YN", "云南省", 0),
    ]);
  if (url.pathname === "/api/site/news-map")
    return send({
      window: url.searchParams.get("window") ?? "7d",
      from: new Date(Date.now() - 7 * 86_400_000).toISOString(),
      to: now,
      countries: [
        { code: "AR", label: "阿根廷", count: 12, previous: 9 },
        { code: "CN", label: "中国", count: 30, previous: 30 },
      ],
    });
  if (url.pathname === "/api/site/timeline")
    return send({
      filters: { channel: "all", category: null, tag: null, topic: null, jurisdiction: country },
      cards: [{ key: "world-a", anchorAt: now, item: card("world-a", "全球精选合成动态"), group: null }],
      nextCursor: null,
      refreshAt: null,
      hot: null,
      dayCounts: {},
      generatedAt: now,
    });
  if (url.pathname === "/api/site/pool") {
    asked.push(country ?? "");
    const n = LOCAL[country ?? ""] ?? 0;
    return send({
      filters: { channel: "all", category: null, tag: null, topic: null, jurisdiction: country, q: null, tab: "time" },
      items: Array.from({ length: n }, (_, i) => card(`${country}-${i}`, `${country} 合成动态 ${i + 1}`)).filter((item) => !withdrawn.has(item.id)),
      hot: [],
      facets: { sources: [], minerals: [] },
      page: 1,
      pageCount: 1,
      total: n,
      todayCount: n,
      freshness: now,
      generatedAt: now,
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

async function open(timezoneId: string, path = "/") {
  const context = await browser.newContext({ timezoneId, viewport: { width: 390, height: 844 }, serviceWorkers: "block", reducedMotion: "reduce" });
  await isolateBrowser(context, [origin]);
  const page = await context.newPage();
  await page.goto(`${origin}${path}`);
  return { context, page };
}

test("a time zone names one country; a zone that is nobody's names none", () => {
  assert.equal(countryOfZone("America/Argentina/Salta"), "AR");
  assert.equal(countryOfZone("America/Buenos_Aires"), "AR", "the older name some browsers still report");
  assert.equal(countryOfZone("Asia/Shanghai"), "CN");
  assert.equal(countryOfZone("Asia/Urumqi"), "CN");
  assert.equal(countryOfZone("Asia/Calcutta"), "IN");
  assert.equal(countryOfZone("America/Santiago"), "CL");
  assert.equal(countryOfZone("Australia/Perth"), "AU");
  for (const none of ["UTC", "Etc/GMT+3", "", null, undefined]) assert.equal(countryOfZone(none), null);
});

test("a device in Argentina opens with Argentina's newest items above the worldwide picks", async () => {
  const { context, page } = await open("America/Argentina/Buenos_Aires");
  const block = page.locator("[data-home-country='AR']");
  await expect(block.getByRole("heading")).toContainText("阿根廷 · 最新动态");
  await expect(block.getByRole("heading")).toContainText("近 7 天 12 条");
  await expect(block.getByRole("listitem")).toHaveCount(5); // seven exist, five open the page
  await expect(block.getByText("按你设备的时区显示，可以更换")).toBeVisible();
  assert.match((await block.getByRole("link", { name: /看阿根廷全部动态/ }).getAttribute("href"))!, /^\/all\?jurisdiction=AR&from=\d{4}-\d{2}-\d{2}$/);
  await expect(page.getByText("全球精选合成动态")).toBeVisible();
  const box = await block.boundingBox();
  const world = await page.getByText("全球精选合成动态").boundingBox();
  assert.ok(box!.y < world!.y, "the country comes first");
  await context.close();
});

test("the reader's own choice replaces the guess and is kept; “worldwide” is a choice too", async () => {
  const { context, page } = await open("America/Argentina/Buenos_Aires");
  await page.locator("[data-home-country='AR']").getByRole("button", { name: "换国家 / 地区" }).click();
  // Only the launch countries are offered (Chile has items but has not joined), in name order, after “worldwide”.
  assert.deepEqual(await page.getByLabel("首页先看哪个国家 / 地区").locator("option").allTextContents(), ["全球（不指定）", "阿根廷", "中国"]);
  await page.getByLabel("首页先看哪个国家 / 地区").selectOption("CN");
  await expect(page.locator("[data-home-country='CN']").getByRole("heading")).toContainText("中国 · 最新动态");
  await expect(page.locator("[data-home-country='CN']").getByRole("listitem")).toHaveCount(3);
  await expect(page.getByText("按你设备的时区显示，可以更换")).toHaveCount(0); // it is the reader's choice now
  await page.reload();
  await expect(page.locator("[data-home-country='CN']")).toBeVisible();
  await page.locator("[data-home-country='CN']").getByRole("button", { name: "换国家 / 地区" }).click();
  await page.getByLabel("首页先看哪个国家 / 地区").selectOption("world");
  await expect(page.locator("[data-home-country='line']")).toContainText("首页先看全球。");
  await page.reload();
  await expect(page.locator("[data-home-country='line']")).toContainText("首页先看全球。");
  await expect(page.locator("section[data-home-country]")).toHaveCount(0);
  await context.close();
});

test("a country that has not joined, or a zone of no country, opens with the world and can still choose", async () => {
  for (const zone of ["Asia/Tokyo", "America/Santiago", "UTC"]) {
    const { context, page } = await open(zone);
    await expect(page.locator("[data-home-country='line']")).toContainText("首页先看全球。");
    await expect(page.getByText("全球精选合成动态")).toBeVisible();
    await expect(page.locator("section[data-home-country]")).toHaveCount(0);
    await page.getByRole("button", { name: "选一个常看的国家 / 地区" }).click();
    await page.getByLabel("首页先看哪个国家 / 地区").selectOption("AR");
    await expect(page.locator("[data-home-country='AR']")).toBeVisible();
    await context.close();
  }
});

test("a launch country with nothing collected yet says so and leaves the worldwide picks", async () => {
  LOCAL.CN = 0;
  try {
    const { context, page } = await open("Asia/Shanghai");
    await expect(page.locator("[data-home-country='line']")).toContainText("中国近期没有收录动态，下面是全球精选。");
    await expect(page.getByText("全球精选合成动态")).toBeVisible();
    await context.close();
  } finally {
    LOCAL.CN = 3;
  }
});

test("a reader in China can put a province first: its items lead, the country's fill the rest, and the choice is kept", async () => {
  const { context, page } = await open("Asia/Shanghai");
  const block = page.locator("[data-home-country='CN']");
  await expect(block.getByRole("listitem")).toHaveCount(3);
  // Only provinces that have items are offered.
  assert.deepEqual(await page.getByLabel("优先看哪个省份").locator("option").allTextContents(), ["全国（不指定省份）", "新疆维吾尔自治区"]);
  await page.getByLabel("优先看哪个省份").selectOption("CN-XJ");
  await expect(block.getByRole("listitem")).toHaveCount(5);
  assert.deepEqual(
    await block
      .getByRole("listitem")
      .allTextContents()
      .then((rows) => rows.map((row) => row.startsWith("本省"))),
    [true, true, false, false, false],
  );
  await expect(block.getByRole("listitem").first()).toContainText("CN-XJ 合成动态 1");
  assert.match((await block.getByRole("link", { name: /看新疆维吾尔自治区全部动态/ }).getAttribute("href"))!, /^\/all\?jurisdiction=CN-XJ&from=/);
  await page.reload();
  await expect(page.locator("[data-home-country='CN'] [data-near]")).toHaveCount(2);
  // Another country starts without a province, and coming back finds it again.
  await page.locator("[data-home-country='CN']").getByRole("button", { name: "换国家 / 地区" }).click();
  await page.getByLabel("首页先看哪个国家 / 地区").selectOption("AR");
  await expect(page.locator("[data-home-country='AR']").getByRole("listitem")).toHaveCount(5);
  await expect(page.getByLabel("优先看哪个省份")).toHaveCount(0); // Argentina's items are not sorted by province yet
  await expect(page.locator("[data-near]")).toHaveCount(0);
  await page.locator("[data-home-country='AR']").getByRole("button", { name: "换国家 / 地区" }).click();
  await page.getByLabel("首页先看哪个国家 / 地区").selectOption("CN");
  await expect(page.locator("[data-home-country='CN'] [data-near]")).toHaveCount(2);
  await page.getByLabel("优先看哪个省份").selectOption("");
  await expect(page.locator("[data-home-country='CN']").getByRole("listitem")).toHaveCount(3);
  await expect(page.locator("[data-near]")).toHaveCount(0);
  await context.close();
});

test("an item taken down while the page is open leaves the country block, even when nothing else on the page went", async () => {
  const { context, page } = await open("America/Argentina/Buenos_Aires");
  const block = page.locator("[data-home-country='AR']");
  await expect(block.getByRole("listitem")).toHaveCount(5);
  await expect(block.locator("[data-item-id='AR-0']")).toHaveCount(1);
  withdrawn.add("AR-0");
  withdrawals += 1;
  try {
    // The guard checks on focus; only the country block shows AR-0, the worldwide picks are untouched.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(block.locator("[data-item-id='AR-0']")).toHaveCount(0, { timeout: 10_000 });
    await expect(block.getByText("AR 合成动态 1", { exact: true })).toHaveCount(0);
    // Nothing new is waiting, so the next item fills the gap, as on the other lists.
    await expect(block.getByRole("listitem")).toHaveCount(5);
    await expect(block.locator("[data-item-id='AR-5']")).toHaveCount(1);
    await expect(page.getByText("全球精选合成动态")).toBeVisible();
  } finally {
    withdrawn.clear();
    withdrawals += 1;
    await context.close();
  }
});

test("a filtered home page asked for something else: no country block, and no country is read", async () => {
  asked.length = 0;
  const { context, page } = await open("America/Argentina/Buenos_Aires", "/?jurisdiction=CL");
  await expect(page.getByText("全球精选合成动态")).toBeVisible();
  await page.waitForTimeout(600);
  await expect(page.locator("[data-home-country]")).toHaveCount(0);
  assert.deepEqual(asked, []);
  await context.close();
});

test("the English interface names the country in English", async () => {
  const { context, page } = await open("America/Argentina/Buenos_Aires", "/en");
  await expect(page.locator("[data-home-country='AR']").getByRole("heading")).toContainText("Argentina · Latest");
  await expect(page.getByRole("link", { name: /All news for Argentina/ })).toBeVisible();
  await context.close();
});

test("the server sends every reader the same page: the country block is not in the HTML", async () => {
  const html = await (await fetch(`${origin}/`)).text();
  assert.doesNotMatch(html, /data-home-country|最新动态/);
  assert.match(html, /全球精选合成动态/);
});
