// Production web, bounded local fixtures; no database, external network or browser installation.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { chromium, expect, type Browser, type BrowserContext, type Page, type Route } from "@playwright/test";
import { browserExecutable, isolateBrowser } from "./browser.ts";
import { webEnvironment } from "../runtime-env.ts";

declare global {
  interface Window {
    __copied: string[];
    __clipboardOk: boolean;
    __legacyCopies: number;
    __shares: ShareData[];
    __shareMode: "ok" | "cancel" | "fail";
  }
}
const original = "31111111-1111-4111-8111-111111111111",
  canonical = "32222222-2222-4222-8222-222222222222";
const at = "2026-10-12T00:00:00Z";
let mode: "public" | "withdrawn" | "failed" | "merged" = "public",
  hold = false;
let held: Array<() => void> = [],
  active = 0,
  peak = 0;
let browser: Browser,
  web: ChildProcess,
  origin = "";
const story = {
  publicId: original,
  title: "事件收藏当前标题",
  status: "settled",
  reportCount: 1,
  sourceCount: 1,
  firstReportAt: at,
  latestAt: at,
  digest: null,
  digestUpdatedAt: null,
  summary: "事件当前摘要",
  excerpt: null,
  latest: null,
  whyHot: { participants48h: 0, newParticipants6h: 0, recentReports24h: 0, observationComplete: true, rank: null, heat: null },
  developments: [],
  officialReports: [],
  timeline: [],
  heat: [],
  related: [],
};
const event = (id: string) => ({
  id,
  title: id === canonical ? "合并后的当前事件" : "事件收藏当前标题",
  summary: "事件当前摘要",
  revision: 1,
  stage: "settled",
  occurred_time: {
    meaning: "event",
    raw: "",
    local_date: null,
    local_time: null,
    timezone: null,
    utc: null,
    precision: "unknown",
    basis: "未提供",
    condition_text: null,
    meaning_label: "事件发生",
    label: "日期待核实",
    beijing_date: null,
  },
  representative_id: null,
  latest_progress_id: null,
  member_count: 1,
  independent_source_count: 1,
  report_count: 1,
  story_id: id,
  status: "active",
  merged_into: null,
  content_version: "1",
  generated_at: at,
  items: [],
  relations: [],
});
const api = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://fixture");
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  const send = (value: unknown) => res.end(JSON.stringify(value));
  if (url.pathname === "/api/site/meta") return send({ changelogVersion: null });
  if (url.pathname === "/api/site/content-version") return send({ version: "1", withdrawalVersion: "1" });
  if (url.pathname === "/api/site/items/saved") return send({ items: [], unavailableIds: [] });
  if (url.pathname.startsWith("/api/site/stories/")) return send(story);
  if (url.pathname.startsWith("/api/v3/events/")) {
    active++;
    peak = Math.max(peak, active);
    let counted = true;
    const done = () => {
      if (counted) {
        counted = false;
        active--;
      }
    };
    res.once("close", done);
    if (hold) await new Promise<void>((resolve) => held.push(resolve));
    if (res.destroyed) {
      done();
      return;
    }
    const id = url.pathname.split("/").at(-1)!;
    if (mode === "merged" && id === original) {
      res.statusCode = 308;
      res.setHeader("location", `/api/v3/events/${canonical}`);
      return res.end();
    }
    if (mode === "failed" || mode === "withdrawn") {
      res.statusCode = mode === "failed" ? 503 : 404;
      return send({ code: "unavailable" });
    }
    return send(event(id));
  }
  if (url.pathname.startsWith("/api/site/reports/")) {
    const [, , , , kind, key] = url.pathname.split("/");
    if (url.pathname.includes("/navigation/")) return send({ items: [] });
    return send({
      kind,
      key,
      title: "可分享的矿业报告",
      windowStart: at,
      windowEnd: at,
      generatedAt: at,
      revision: 1,
      generationStatus: "ready",
      lead: null,
      overview: null,
      highlights: [],
      sections: [],
      stories: [],
      flashes: [],
      metrics: {},
      readingMinutes: 1,
      prev: null,
      next: null,
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
  hold = false;
  for (const finish of held) finish();
  await browser?.close();
  if (web && web.exitCode === null) {
    web.kill("SIGTERM");
    await once(web, "exit");
  }
  api.closeAllConnections();
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

/** Observe hydration and the initial version reconciliation before changing the shared fixture. */
async function openSavedReader(page: Page, path: string) {
  const versionUrl = `${origin}/api/site/content-version`;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const heldVersion = async (route: Route) => {
    await gate;
    await route.continue();
  };
  await page.route(versionUrl, heldVersion, { times: 1 });
  const version = page.waitForResponse((response) => response.url() === versionUrl);
  const revalidation = path.startsWith("/story/") ? page.waitForResponse((response) => new URL(response.url()).pathname === `${path}.data`) : null;
  void version.catch(() => {});
  void revalidation?.catch(() => {});
  try {
    await page.goto(origin + path);
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("visible");
    await expect(page.getByText("正在确认最新内容", { exact: true })).toBeVisible();
    release();
    assert.deepEqual(await (await version).json(), { version: "1", withdrawalVersion: "1" });
    if (revalidation) {
      const loaded = await revalidation;
      assert.equal(loaded.status(), 200);
      // The current DOM/status below proves route commit without awaiting stream EOF.
    }
    await expect(page.getByText("正在确认最新内容", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "暂时无法确认最新内容" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "加载最新", exact: true })).toHaveCount(0);
    if (path.startsWith("/story/")) await expect(page.getByRole("heading", { name: story.title, exact: true })).toBeVisible();
    else await expect(page.getByRole("region", { name: "事件收藏" }).getByRole("link").first()).toBeVisible();
  } finally {
    release();
    await page.unroute(versionUrl, heldVersion);
  }
}
async function closeSavedContext(context: BrowserContext) {
  hold = false;
  for (const finish of held.splice(0)) finish();
  await context.close();
}

test("story references resolve current merged identities, clear text on failure/withdrawal and remain removable", { timeout: 30000 }, async (t) => {
  mode = "public";
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  t.after(() => closeSavedContext(context));
  const blocked = await isolateBrowser(context, [origin]);
  const page = await context.newPage();
  await openSavedReader(page, `/story/${original}`);
  await page.getByRole("button", { name: "收藏事件", exact: true }).click();
  await expect(page.getByRole("button", { name: "已收藏事件", exact: true })).toHaveAttribute("aria-pressed", "true");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("amp-starred-items")!));
  assert.deepEqual(Object.keys(saved[0]).sort(), ["id", "savedAt", "type"]);
  assert.equal(saved[0].type, "story");
  await openSavedReader(page, "/starred");
  const list = page.getByRole("region", { name: "事件收藏" });
  await expect(list.getByRole("link", { name: "事件收藏当前标题" })).toBeVisible();
  await expect(page.getByText("正在确认最新内容", { exact: true })).toHaveCount(0);
  mode = "merged";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(list.getByRole("link", { name: "合并后的当前事件" })).toHaveAttribute("href", `/story/${canonical}`);
  assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem("amp-starred-items")!)))[0].id, original);
  hold = true;
  held = [];
  mode = "failed";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => held.length).toBe(1);
  await expect(list.getByText("合并后的当前事件", { exact: true })).toHaveCount(0);
  await expect(list.getByText("事件当前摘要", { exact: true })).toHaveCount(0);
  hold = false;
  for (const finish of held) finish();
  held = [];
  await expect(list.getByRole("button", { name: "重试事件收藏" })).toBeVisible();
  assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem("amp-starred-items")!))).length, 1);
  mode = "withdrawn";
  await list.getByRole("button", { name: "重试事件收藏" }).click();
  await expect(list.getByText("此事件当前不可查看。", { exact: true })).toBeVisible();
  await list.getByRole("button", { name: "移除事件收藏" }).click();
  await expect(list).toHaveCount(0);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("amp-starred-items")!)), []);
  assert.deepEqual(blocked, []);
});

test("saved event revalidation is periodic and has at most three concurrent requests", { timeout: 30000 }, async (t) => {
  mode = "public";
  const context = await browser.newContext();
  t.after(() => closeSavedContext(context));
  await isolateBrowser(context, [origin]);
  const page = await context.newPage();
  await page.clock.install({ time: new Date(at) });
  await page.addInitScript(() =>
    localStorage.setItem(
      "amp-starred-items",
      JSON.stringify(
        Array.from({ length: 7 }, (_, i) => ({ type: "story", id: `40000000-0000-4000-8000-${String(i).padStart(12, "0")}`, savedAt: "2026-10-12T00:00:00Z" })),
      ),
    ),
  );
  await openSavedReader(page, "/starred");
  const list = page.getByRole("region", { name: "事件收藏" });
  await expect(list.getByRole("link")).toHaveCount(7);
  await expect(page.getByText("正在确认最新内容", { exact: true })).toHaveCount(0);
  hold = true;
  held = [];
  peak = 0;
  await page.clock.fastForward(60_001);
  await expect.poll(() => held.length).toBe(3);
  assert.ok(peak <= 3);
  await expect(list.getByRole("link")).toHaveCount(0);
  hold = false;
  for (const finish of held) finish();
  held = [];
  await expect(list.getByRole("link")).toHaveCount(7);
  assert.ok(peak <= 3);
});

async function shareMocks(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    window.__copied = [];
    window.__shares = [];
    window.__clipboardOk = true;
    window.__legacyCopies = 0;
    window.__shareMode = "ok";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          if (!window.__clipboardOk) throw new Error("copy denied");
          window.__copied.push(value);
        },
      },
    });
    document.execCommand = () => {
      window.__legacyCopies++;
      return false;
    };
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (value: ShareData) => {
        window.__shares.push(value);
        if (window.__shareMode === "cancel") throw new DOMException("cancelled", "AbortError");
        if (window.__shareMode === "fail") throw new Error("share denied");
      },
    });
  });
}
const paths = [`/story/${original}`, "/daily/2026-10-12", "/weekly/2026-W41", "/monthly/2026-10"];
test("desktop copies canonical story and report links and never reports a rejected copy as success", { timeout: 30000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await isolateBrowser(context, [origin]);
  const page = await context.newPage();
  await shareMocks(page);
  for (const path of paths) {
    await page.goto(origin + path);
    await page.getByRole("button", { name: "复制链接", exact: true }).click();
    await expect(page.getByText("链接已复制", { exact: true })).toBeVisible();
    assert.deepEqual(await page.evaluate(() => window.__copied), [origin + path]);
  }
  await page.evaluate(() => {
    window.__clipboardOk = false;
  });
  await page.getByRole("button", { name: "复制链接", exact: true }).click();
  await expect(page.getByText("复制失败，请手动复制地址栏中的链接。", { exact: true })).toBeVisible();
  await expect(page.getByText("链接已复制", { exact: true })).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.__legacyCopies), 1);
  await context.close();
});
test("mobile invokes system sharing for events and all report kinds, and treats cancellation separately from failure", { timeout: 30000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await isolateBrowser(context, [origin]);
  const page = await context.newPage();
  await shareMocks(page);
  for (const path of paths) {
    await page.goto(origin + path);
    await page.getByRole("button", { name: "分享", exact: true }).click();
    await expect(page.getByText("分享已完成", { exact: true })).toBeVisible();
    assert.equal((await page.evaluate(() => window.__shares))[0]!.url, origin + path);
    assert.deepEqual(await page.evaluate(() => window.__copied), []);
  }
  await page.evaluate(() => {
    window.__shareMode = "fail";
  });
  await page.getByRole("button", { name: "分享", exact: true }).click();
  await expect(page.getByText("分享失败，请重试或复制链接。", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.__shareMode = "cancel";
  });
  await page.getByRole("button", { name: "分享", exact: true }).click();
  await expect(page.getByRole("button", { name: "分享", exact: true })).toBeEnabled();
  await expect(page.getByText("分享失败，请重试或复制链接。", { exact: true })).toHaveCount(0);
  await expect(page.getByText("分享已完成", { exact: true })).toHaveCount(0);
  assert.deepEqual(await page.evaluate(() => window.__copied), []);
  await context.close();
});
