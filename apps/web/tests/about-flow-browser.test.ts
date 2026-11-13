// TASK-0654: the about page's six steps. Production router and browser against a local statistics API; no external
// requests or accounts. The stage list reads without scripts, the figures are the API's, nothing moves under reduced
// motion, and the flow fits desktop and phone widths.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { browserExecutable, isolateBrowser } from "./browser.ts";
import { webEnvironment } from "../runtime-env.ts";

const STATS = {
  sources: 442,
  sourceKinds: { rss: 400, web: 42 },
  heatOnlySources: 3,
  items: 36_210,
  selected: 1_204,
  dailies: 87,
  day: { collected: 1_240, selected: 9 },
  sampleSources: [{ name: "合成矿业公告", kind: "rss", heatOnly: false }],
  latest: [{ id: "flow-a", title: "合成精选动态", source: "合成来源" }],
};
const FIGURES: Record<string, number> = { sources: STATS.sources, collected: STATS.day.collected, selected: STATS.day.selected, dailies: STATS.dailies };
const STAGES = [
  ["收集", "442 个来源，多国多语言"],
  ["预筛", "AI 判断是否和金属矿业有关"],
  ["合并", "多家报道，合成一个事件"],
  ["评分", "五个方面，合成 0–100 分"],
  ["写作", "中文标题、导读和译文"],
  ["出版", "精选、日报、热点榜、全部、法规"],
] as const;

let browser: Browser,
  web: ChildProcess,
  origin = "";
const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://fixture");
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  const send = (value: unknown) => res.end(JSON.stringify(value));
  if (url.pathname === "/api/site/meta") return send({ changelogVersion: null });
  if (url.pathname === "/api/site/information")
    return send({ revision: 0, updatedAt: null, about: "合成网站介绍", contactEmail: null, contactPage: null, metalLinks: [] });
  if (url.pathname === "/api/site/stats") return send(STATS);
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

/** Every figure on screen, by its statistic. */
async function shownFigures(page: Page): Promise<[string, string][]> {
  return page
    .locator("[data-stat]")
    .evaluateAll((nodes) =>
      nodes.filter((n) => (n as HTMLElement).checkVisibility({ visibilityProperty: true })).map((n) => [n.getAttribute("data-stat")!, n.textContent!.trim()]),
    );
}
const snapshot = (page: Page) => page.locator(".pf-river canvas").evaluate((c) => (c as HTMLCanvasElement).toDataURL());

test("the server sends every step with its explanation and the API's figures, in Chinese and English", async () => {
  const html = await (await fetch(`${origin}/about`)).text();
  const markup = html.replace(/<script\b[\s\S]*?<\/script>/g, "");
  for (const [title, sum] of STAGES) {
    assert.ok(markup.includes(`>${title}<`), title);
    assert.ok(markup.includes(sum), sum);
  }
  for (const text of ["AI 先把每篇读一遍", "合成一个事件，并标出有几家来源", "AI 从五个方面给每个事件打分", "每天北京时间 08:00 出刊"])
    assert.ok(markup.includes(text), text);
  for (const [key, value] of Object.entries(FIGURES)) assert.match(markup, new RegExp(`data-stat="${key}">${value.toLocaleString("en-US")}<`), key);
  assert.ok(!markup.includes("示意"), "no illustrative figures");
  assert.ok(!/<canvas[^>]*width="[1-9]/.test(markup), "the river is drawn in the browser only");
  const english = (await (await fetch(`${origin}/en/about`)).text()).replace(/<script\b[\s\S]*?<\/script>/g, "");
  for (const title of ["Collect", "Screen", "Merge", "Score", "Write", "Publish"]) assert.ok(english.includes(`>${title}<`), title);
  assert.ok(english.includes("442 sources, many countries and languages"));
  assert.ok(!/[预筛合并评分写作出版]{2}</.test(english), "no Chinese step names on the English page");
});

for (const width of [1440, 390]) {
  test(`all six steps fit at ${width}px, the figures match the API, and a step explains itself`, { timeout: 40000 }, async () => {
    const context = await browser.newContext({ viewport: { width, height: width > 500 ? 900 : 844 }, locale: "zh-CN", reducedMotion: "no-preference" });
    try {
      const blocked = await isolateBrowser(context, [origin]),
        page = await context.newPage(),
        errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${origin}/about`);
      const flow = page.locator(".pf");
      await expect(flow).toHaveAttribute("data-ready", "");
      const heads = flow.locator(".pf-head");
      await expect(heads).toHaveCount(6);
      for (const [i, [title]] of STAGES.entries()) {
        const head = heads.nth(i);
        await head.scrollIntoViewIfNeeded();
        await expect(head).toBeVisible();
        await expect(head).toContainText(title);
        const box = (await head.boundingBox())!;
        assert.ok(box.x >= 0 && box.x + box.width <= width + 0.5, `${title} stays inside ${width}px`);
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no sideways scrolling");
      const docks = flow.locator(".pf-dock");
      await expect(docks).toHaveCount(5);
      for (const dock of await docks.all()) {
        const box = (await dock.boundingBox())!;
        assert.ok(box.x >= 0 && box.x + box.width <= width + 0.5, "outputs stay on screen");
      }

      const figures = await shownFigures(page);
      assert.ok(figures.length >= 4, "the four figures are shown");
      for (const [key, text] of figures) assert.equal(Number(text.replaceAll(",", "")), FIGURES[key], key);
      assert.deepEqual([...new Set(figures.map(([key]) => key))].sort(), Object.keys(FIGURES).sort());

      // The river moves.
      await flow.locator(".pf-river").scrollIntoViewIfNeeded();
      const first = await snapshot(page);
      await expect.poll(() => snapshot(page)).not.toBe(first);

      const scoring = "AI 从五个方面给每个事件打分";
      if (width > 500) {
        await heads.nth(3).hover();
        await expect(flow).toHaveAttribute("data-active", "3");
        await expect(page.locator(".pf-pane").filter({ visible: true })).toContainText(scoring);
        await page.mouse.move(5, 5);
        await expect(flow).not.toHaveAttribute("data-active", /./);
        await heads.nth(5).click();
        await expect(heads.nth(5)).toHaveAttribute("aria-pressed", "true");
        await expect(page.locator(".pf-pane").filter({ visible: true })).toContainText("各国法规政策的新变化");
        await page.keyboard.press("Escape");
        await expect(heads.nth(5)).toHaveAttribute("aria-pressed", "false");
        await heads.nth(1).focus();
        await page.keyboard.press("Tab");
        await expect(flow).toHaveAttribute("data-active", "2");
      } else {
        const body = page.locator("#pf-body-3").getByText(scoring);
        await expect(body).toBeHidden();
        await heads.nth(3).click();
        await expect(heads.nth(3)).toHaveAttribute("aria-expanded", "true");
        await expect(body).toBeVisible();
        await expect(flow.locator(".pf-stage").nth(3)).toHaveAttribute("data-active", "");
        await heads.nth(3).click();
        await expect(heads.nth(3)).toHaveAttribute("aria-expanded", "false");
        await expect(body).toBeHidden();
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no sideways scrolling after a step opens");
      assert.deepEqual(errors, []);
      assert.deepEqual(blocked, []);
    } finally {
      await context.close();
    }
  });
}

test("the English steps and their outputs fit a phone", { timeout: 30000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  try {
    const blocked = await isolateBrowser(context, [origin]),
      page = await context.newPage();
    await page.goto(`${origin}/en/about`);
    const flow = page.locator(".pf");
    await expect(flow).toHaveAttribute("data-ready", "");
    await expect(flow.locator(".pf-head").first()).toContainText("442 sources");
    for (const element of [...(await flow.locator(".pf-head").all()), ...(await flow.locator(".pf-dock").all())]) {
      await element.scrollIntoViewIfNeeded();
      const box = (await element.boundingBox())!;
      assert.ok(box.x >= 0 && box.x + box.width <= 390.5, `${await element.innerText()} stays on screen`);
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.deepEqual(blocked, []);
  } finally {
    await context.close();
  }
});

test("reduced motion draws the river once and nothing moves", { timeout: 40000 }, async () => {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "zh-CN", reducedMotion: "reduce" });
    try {
      const blocked = await isolateBrowser(context, [origin]),
        page = await context.newPage(),
        errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${origin}/about`);
      const flow = page.locator(".pf");
      await expect(flow).toHaveAttribute("data-ready", "");
      await flow.locator(".pf-river").scrollIntoViewIfNeeded();
      const drawn = await snapshot(page);
      const blank = await page.evaluate(() => {
        const c = document.querySelector(".pf-river canvas") as HTMLCanvasElement;
        const empty = document.createElement("canvas");
        empty.width = c.width;
        empty.height = c.height;
        return empty.toDataURL();
      });
      assert.notEqual(drawn, blank, "the still diagram is drawn");
      await page.waitForTimeout(900);
      assert.equal(await snapshot(page), drawn, "the river stands still");
      const running = await page.evaluate(
        () => document.getAnimations().filter((a) => a.playState === "running" && (a.effect as KeyframeEffect | null)?.target?.closest?.(".pf")).length,
      );
      assert.equal(running, 0, "no running animations in the flow");
      // A theme change repaints the still picture, still without motion.
      await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await expect.poll(() => snapshot(page)).not.toBe(drawn);
      const dark = await snapshot(page);
      await page.waitForTimeout(600);
      assert.equal(await snapshot(page), dark);
      assert.deepEqual(errors, []);
      assert.deepEqual(blocked, []);
    } finally {
      await context.close();
    }
  }
});
