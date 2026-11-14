// The /metals presentation helpers and a stationary touch on the production page.
// Contract-checked synthetic prices only; no database or external network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { browserExecutable, isolateBrowser } from "../apps/web/tests/browser.ts";
import { webEnvironment } from "../apps/web/runtime-env.ts";
import { MetalPrices } from "@amp/contracts/http/public";
import {
  changeText,
  headlineIndex,
  isBehind,
  licenceNotes,
  priceText,
  shortLabel,
  trendPoints,
  trendRanges,
  trendScale,
  trendStepped,
  trendWindow,
  TREND_MIN_BAND,
  type Quote,
} from "../modules/metals/web/quotes.ts";

const period = (end: string, label: string) => ({ start: end, end, label });
function prices(overrides: { dayStale?: boolean; dayValue?: string | null } = {}) {
  const { dayStale = false, dayValue = "9812.5" } = overrides;
  const quote = (key: string, source: string, value: string | null, p: ReturnType<typeof period>) => ({
    key,
    source,
    title: `合成 ${key}`,
    spec: null,
    footnote: null,
    value,
    unit: "美元/吨",
    currency: "USD" as const,
    decimals: null,
    period: value ? p : null,
    change: null,
  });
  return MetalPrices.parse({
    generatedAt: "2026-10-04T02:00:00Z",
    intro: "合成",
    latest: [
      { tag: "日", label: "10月2日", stale: dayStale, extras: [] },
      { tag: "周", label: "9月26日", stale: false, extras: [] },
      { tag: "月", label: "9月", stale: false, extras: [] },
    ],
    sources: [
      {
        key: "month",
        name: "合成月源",
        tag: "月",
        status: "fresh",
        latest: { label: "2026年9月", release: { label: "r", url: "https://source.invalid/m", date: null } },
      },
      {
        key: "week",
        name: "合成周源",
        tag: "周",
        status: "fresh",
        latest: { label: "2026年9月26日", release: { label: "r", url: "https://source.invalid/w", date: null } },
      },
      {
        key: "day",
        name: "合成日源",
        tag: "日",
        status: dayValue ? (dayStale ? "stale" : "fresh") : "empty",
        latest: dayValue ? { label: "2026年10月2日", release: { label: "r", url: "https://source.invalid/d", date: null } } : null,
      },
    ],
    metals: [
      {
        key: "copper",
        name: "铜",
        quotes: [
          quote("m", "month", "9245.18", period("2026-09-30", "2026年9月")),
          quote("w", "week", "78350", period("2026-09-26", "2026年9月26日")),
          quote("d", "day", dayValue, period("2026-10-02", "2026年10月2日")),
        ],
      },
      { key: "none", name: "无", quotes: [quote("x", "week", null, period("2026-09-26", "2026年9月26日"))] },
    ],
    notes: [{ ref: null, text: "合成月源数据按 {link} 许可使用。", link: { name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" } }],
    officialLinks: [],
  });
}

test("the most frequent current quote with a price leads, whatever the API order", () => {
  const data = prices();
  assert.equal(data.metals[0]!.quotes[headlineIndex(data, data.metals[0]!)]!.key, "d");
  // Earlier data gives way to a current weekly quote; a missing daily price to the next frequency.
  const stale = prices({ dayStale: true });
  assert.equal(isBehind(stale, stale.metals[0]!, stale.metals[0]!.quotes[2]!), true);
  assert.equal(stale.metals[0]!.quotes[headlineIndex(stale, stale.metals[0]!)]!.key, "w");
  const missing = prices({ dayValue: null });
  assert.equal(missing.metals[0]!.quotes[headlineIndex(missing, missing.metals[0]!)]!.key, "w");
  // A metal without any price still has a card, led by its first quote (shown as 暂缺).
  assert.equal(headlineIndex(missing, missing.metals[1]!), 0);
});

test("periods, prices, changes and licences read as published", () => {
  const data = prices();
  assert.equal(shortLabel(data, "2026年10月2日"), "10月2日");
  assert.equal(shortLabel(data, "2025年12月下旬"), "2025年12月下旬");
  assert.equal(priceText("108770.0", null), "108,770.0");
  assert.equal(priceText("64.599999999999994", 2), "64.60");
  assert.deepEqual(changeText("1.0"), { text: "+1.0%", direction: "up" });
  assert.deepEqual(changeText("-1.6"), { text: "−1.6%", direction: "down" });
  assert.deepEqual(changeText("0.0"), { text: "0.0%", direction: "flat" });
  assert.deepEqual(
    licenceNotes(data.notes, data.sources[0]!).map((note) => note.link?.name),
    ["CC BY 4.0"],
  );
  assert.deepEqual(licenceNotes(data.notes, data.sources[1]!), []);
});

test("a trend line shows only stored periods, offers only ranges that add something, and never exaggerates a small move", () => {
  // TASK-0627: the Owner found the preview's ups and downs misleading; the scale keeps a move's height honest.
  const day = (n: number) => new Date(Date.UTC(2026, 9, 1) + n * 86400_000).toISOString().slice(0, 10);
  const history = Array.from({ length: 40 }, (_, i) => ({ period: { start: day(i), end: day(i), label: `第${i}天` }, value: String(10000 + i) }));
  const quote = { history } as unknown as Quote;
  const points = trendPoints(quote);
  assert.equal(points.length, 40);
  assert.equal(trendWindow(points, 31).length, 32, "the latest day and the 31 before it");
  assert.deepEqual(
    trendRanges(points).map((range) => range.key),
    ["1m", "3m"],
    "a year would show nothing more than three months",
  );
  assert.deepEqual(
    trendRanges(points.slice(-10)).map((range) => range.key),
    ["1m"],
  );
  assert.deepEqual(trendRanges(points.slice(-1)), [], "one period is not a trend");
  assert.deepEqual(trendPoints({ history: undefined } as unknown as Quote), []);
  // A 0.4% move may fill at most a tenth of the height; a 20% move uses nearly all of it.
  const flat = trendScale([10000, 10040]);
  assert.ok((10040 - 10000) / (flat.max - flat.min) < 0.11);
  assert.ok(flat.max - flat.min >= 10020 * TREND_MIN_BAND);
  const wide = trendScale([10000, 12000]);
  assert.ok((12000 - 10000) / (wide.max - wide.min) > 0.9);
  assert.ok(wide.min < 10000 && wide.max > 12000);
  assert.deepEqual(trendScale([5, 5]).max > 5, true);
  assert.equal(trendStepped(points), false);
  assert.equal(trendStepped([{ start: "2026-09-01", end: "2026-09-30", label: "9月", value: 1 }]), true);
});

// Build @amp/web first; this drives the real /metals route without a test-only product export.
test("metal-price captions remain readable on touch and pointer charts", { timeout: 45000 }, async () => {
  const fixture = prices(),
    quote = fixture.metals[0]!.quotes[2]!;
  quote.history = [
    { period: period("2026-09-30", "2026年9月30日"), value: "9700" },
    { period: period("2026-10-01", "2026年10月1日"), value: "9800" },
    { period: quote.period!, value: quote.value! },
  ];
  const gold = { ...quote, key: "caption-gold", title: "合成金价", unit: "美元/盎司", decimals: 2 };
  gold.history = Array.from({ length: 400 }, (_, index) => {
    const date = new Date(Date.parse("2026-10-02T00:00:00Z") - (399 - index) * 86400_000);
    return {
      period: period(date.toISOString().slice(0, 10), `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日`),
      value: (10000.12 + index).toFixed(2),
    };
  });
  gold.period = gold.history.at(-1)!.period;
  gold.value = gold.history.at(-1)!.value;
  fixture.metals[1] = { key: "gold", name: "金", quotes: [gold] };
  const payload = MetalPrices.parse(fixture);
  const evidence = path.join(mkdtempSync(path.join(tmpdir(), "aimine-metal-caption-")), "output/playwright");
  mkdirSync(evidence, { recursive: true });
  const readable = async (page: Page) => {
    const geometry = await page.evaluate(`(() => {
      const label = document.querySelector('[data-trend="caption-gold"] [aria-live]');
      const controls = label.nextElementSibling.getBoundingClientRect();
      const bounds = label.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(label);
      return {
        clipped: label.scrollWidth > label.clientWidth + 1,
        outside: [...range.getClientRects()].some(r => r.left < bounds.left - 1 || r.right > bounds.right + 1),
        overlap: [...range.getClientRects()].some(r => r.left < controls.right && r.right > controls.left && r.top < controls.bottom && r.bottom > controls.top),
      };
    })()`);
    assert.deepEqual(
      geometry,
      { clipped: false, outside: false, overlap: false },
      "the whole date and price must fit without clipping or covering range controls",
    );
  };
  const api = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    const pathname = new URL(req.url!, "http://fixture").pathname;
    const answer =
      pathname === "/api/site/metal-prices"
        ? payload
        : pathname === "/api/site/meta"
          ? { changelogVersion: null }
          : pathname === "/api/site/content-version"
            ? { version: "touch-fixture", withdrawalVersion: "touch-fixture" }
            : pathname === "/api/site/jurisdictions"
              ? []
              : null;
    if (answer === null) res.statusCode = 404;
    res.end(JSON.stringify(answer));
  });
  let web: ChildProcess | undefined, browser: Browser | undefined;
  try {
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    web = spawn(process.execPath, ["apps/web/server.ts"], {
      env: webEnvironment({
        PATH: process.env.PATH,
        NODE_ENV: "production",
        AMP_RELEASE: "fixture-metal-touch",
        WEB_PORT: "0",
        WEB_HOST: "127.0.0.1",
        PRIVATE_HOST: "private.localhost",
        TRUST_PROXY: "false",
        API_BASE_URL: base,
        PRIVATE_API_BASE_URL: base,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const origin = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error(output || "web did not start")), 15000);
      const read = (chunk: Buffer) => {
        output += chunk;
        const match = output.match(/"msg":"web started","port":(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(`http://127.0.0.1:${match[1]}`);
        }
      };
      web!.stdout!.on("data", read);
      web!.stderr!.on("data", read);
      web!.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      web!.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(output));
      });
    });
    browser = await chromium.launch({
      headless: true,
      executablePath: browserExecutable(),
      args: ["--disable-background-networking", "--disable-component-update"],
    });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      locale: "zh-CN",
      reducedMotion: "reduce",
    });
    const blocked = await isolateBrowser(context, [origin]),
      page = await context.newPage(),
      errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/metals`);
    const figure = page.locator('[data-trend="d"]'),
      chart = figure.locator("svg"),
      caption = figure.locator("figcaption");
    // Existing move/leave behavior also proves the component hydrated before the no-move touch.
    await chart.hover();
    await expect(caption).toContainText("10月1日");
    await page.mouse.move(0, 0);
    await expect(caption).toContainText("10月2日");
    await page.evaluate(`(() => {
      const element = document.querySelector('[data-trend="d"] svg');
      element.setAttribute("data-test-moves", "0");
      element.addEventListener("pointermove", () => element.setAttribute("data-test-moves", String(Number(element.getAttribute("data-test-moves")) + 1)));
    })()`);
    const box = (await chart.boundingBox())!,
      session = await context.newCDPSession(page);
    try {
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width * 0.1, y: box.y + box.height * 0.5 }] });
      await expect(chart).toHaveAttribute("data-test-moves", "0");
      const screenshot = path.join(mkdtempSync(path.join(tmpdir(), "aimine-metal-touch-")), "touch-start.png");
      await page.screenshot({ path: screenshot });
      console.log(`stationary touch screenshot: ${screenshot}`);
      await expect(caption).toContainText("9月30日");
      await expect(caption).toContainText("9,700");
      assert.equal(await chart.locator("line").count(), 1, "the pressed period has its own marker");
    } finally {
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
    const firstYear = trendWindow(trendPoints(gold), 366)[0]!;
    for (const width of [390, 360]) {
      await page.setViewportSize({ width, height: 844 });
      const goldFigure = page.locator('[data-trend="caption-gold"]');
      await goldFigure.getByRole("button", { name: "1年", exact: true }).click();
      const cards = await page.locator('[data-metal="copper"], [data-metal="gold"]').all();
      const [left, right] = await Promise.all(cards.map((card) => card.boundingBox()));
      assert.equal(left!.y, right!.y, `${width}px retains two columns`);
      assert.ok(right!.x > left!.x);
      const goldChart = goldFigure.locator("svg"),
        touch = (await goldChart.boundingBox())!;
      try {
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: touch.x + 0.1, y: touch.y + touch.height / 2 }] });
        await expect(goldFigure.locator("figcaption")).toContainText(firstYear.label);
        await expect(goldFigure.locator("figcaption")).toContainText(priceText(String(firstYear.value), gold.decimals));
        assert.equal(await goldChart.locator("line").count(), 1);
        await page.screenshot({ path: path.join(evidence, `touch-${width}.png`) });
        await readable(page);
      } finally {
        await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      }
    }
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN", reducedMotion: "reduce" });
    const desktopBlocked = await isolateBrowser(desktop, [origin]),
      desktopPage = await desktop.newPage();
    desktopPage.on("pageerror", (error) => errors.push(error.message));
    await desktopPage.goto(`${origin}/metals`);
    const desktopFigure = desktopPage.locator('[data-trend="caption-gold"]');
    await desktopFigure.getByRole("button", { name: "1年", exact: true }).click();
    await desktopFigure.locator("svg").hover({ position: { x: 0.1, y: 10 } });
    await expect(desktopFigure.locator("figcaption")).toContainText(firstYear.label);
    await readable(desktopPage);
    await desktopPage.screenshot({ path: path.join(evidence, "pointer-1280.png") });
    await desktopPage.mouse.move(0, 0);
    await expect(desktopFigure.locator("figcaption")).toContainText("10月2日");
    assert.deepEqual(desktopBlocked, []);
    console.log(`caption screenshots: ${evidence}`);
    assert.deepEqual(errors, []);
    assert.deepEqual(blocked, []);
  } finally {
    await browser?.close();
    if (web && web.exitCode === null) {
      web.kill("SIGTERM");
      await once(web, "exit");
    }
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  }
});
