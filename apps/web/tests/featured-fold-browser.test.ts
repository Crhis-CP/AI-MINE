// 精选 shows an event once (TASK-0570): the card of its newest development says how many other outlets reported it
// and opens the earlier developments under it, in Chinese and English, on phone and desktop. Production web,
// synthetic API shaped like the folded timeline the backend now serves.
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
const hour = (h: number) => new Date(Date.UTC(2026, 10, 5, h, 30)).toISOString();
const item = (id: string, title: string, at: string, source = "合成矿业在线") => ({
  id,
  title,
  summary: "合成导读",
  reason: null,
  source: { name: source },
  publishedAt: at,
  timelineAt: at,
  category: null,
  tags: [],
  score: null,
  selected: true,
  channel: "news",
});
const story = { publicId: "fold-story", title: "合成事件：铜企承认虚报产量" };
// One card for the whole story: development 2 of 2, with one more outlet; development 1 is folded under it.
const eventCard = {
  key: "f2",
  anchorAt: hour(11),
  item: item("fold-audit", "合成：被查出虚报产量", hour(11)),
  group: {
    factId: "fact-audit",
    story,
    memberIds: ["fold-audit", "fold-release", "fold-media"],
    additionalSourceCount: 1,
    reportCount: 2,
    developmentCount: 2,
    latestDevelopment: null,
  },
  storyProgress: {
    story,
    developmentCount: 2,
    position: 2,
    previous: { title: "合成进展：股东大会支持整改", at: hour(5) },
    latest: null,
    backgroundCount: 0,
  },
};
const otherCard = { key: "f9", anchorAt: hour(8), item: item("other-pick", "合成：另一座矿山获环境许可", hour(8)), group: null };
const representative = (id: string, title: string, at: string, source: string) => ({
  ...item(id, title, at, source),
  source: { id: `source-${id}`, name: source, kind: "web_list", firstParty: false },
  sourceTime: null,
});
const requests: URL[] = [];

const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://fixture");
  requests.push(url);
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  const send = (value: unknown) => res.end(JSON.stringify(value));
  if (url.pathname === "/api/site/meta") return send({ changelogVersion: null });
  if (url.pathname === "/api/site/content-version") return send({ version: "1", withdrawalVersion: "1" });
  if (url.pathname === "/api/site/items/saved") return send({ items: [], unavailableIds: [] });
  if (url.pathname === "/api/site/timeline")
    return send({
      filters: { channel: "all", category: null, tag: null, topic: null, jurisdiction: null },
      cards: [eventCard, otherCard],
      nextCursor: null,
      refreshAt: null,
      hot: null,
      dayCounts: { "2026-11-05": 2 },
      generatedAt: hour(12),
    });
  if (url.pathname === "/api/site/groups/fact-audit/reports")
    return send({
      factId: "fact-audit",
      revision: "r1",
      nextCursor: null,
      reports: [
        {
          id: "fold-audit-other",
          title: "合成：审计结果公布",
          summary: null,
          source: { id: "source-other", name: "合成矿业周刊", kind: "web_list", firstParty: false },
          timelineAt: hour(10),
          sourceTime: null,
          originalUrl: "https://example.invalid/fold-audit-other",
          selected: false,
        },
      ],
    });
  if (url.pathname === "/api/site/stories/fold-story/developments")
    return send({
      story,
      revision: "d1",
      nextCursor: null,
      developments: [
        {
          factId: "fact-audit",
          title: "合成进展：审计查出虚报产量",
          occurredAt: null,
          reportCount: 2,
          representative: representative("fold-audit", "合成：被查出虚报产量", hour(11), "合成矿业在线"),
        },
        {
          factId: "fact-meeting",
          title: "合成进展：股东大会支持整改",
          occurredAt: null,
          reportCount: 2,
          representative: representative("fold-release", "合成公司：股东大会支持整改", hour(5), "合成铜业公司"),
        },
      ],
    });
  res.statusCode = 404;
  send({ code: "not_found" });
});

before(async () => {
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  web = spawn(process.execPath, ["apps/web/server.ts"], {
    env: webEnvironment({
      PATH: process.env.PATH,
      NODE_ENV: "production",
      WEB_PORT: "0",
      WEB_HOST: "127.0.0.1",
      PRIVATE_HOST: "private.localhost",
      TRUST_PROXY: "false",
      API_BASE_URL: apiBase,
      PRIVATE_API_BASE_URL: apiBase,
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

const cases = [
  { path: "/", sources: "另有 1 家信源报道", developments: "展开 2 条进展", fullEvent: "查看完整事件" },
  { path: "/en", sources: "1 more sources", developments: "Show 2 developments", fullEvent: "See the full event" },
];

test("精选 shows the event as one card with its other outlets, and its earlier development opens under it", { timeout: 90000 }, async () => {
  for (const width of [390, 1440])
    for (const c of cases) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "zh-CN", reducedMotion: "reduce" });
      try {
        const blocked = await isolateBrowser(context, [origin]),
          page = await context.newPage(),
          errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto(`${origin}${c.path}`);
        const card = page.locator('article[data-item-id="fold-audit"]');
        await expect(card).toBeVisible();
        // One card for the story; no second card of the same event below it.
        await expect(page.locator('[data-story-progress="fold-story"]')).toHaveCount(1);
        await expect(page.locator("article[data-item-id]")).toHaveCount(2);
        await expect(card).toHaveAttribute("data-member-ids", JSON.stringify(["fold-audit", "fold-release", "fold-media"]));

        await card.getByRole("button", { name: c.sources }).click();
        await expect(card.getByRole("link", { name: "合成：审计结果公布" })).toBeVisible();

        await card.getByRole("button", { name: c.developments }).click();
        const earlier = card.getByRole("link", { name: "合成进展：股东大会支持整改", exact: true });
        await expect(earlier).toBeVisible();
        await expect(earlier).toHaveAttribute("href", c.path === "/en" ? "/en/items/fold-release" : "/items/fold-release");
        await expect(card.getByRole("link", { name: c.fullEvent }).last()).toHaveAttribute(
          "href",
          c.path === "/en" ? "/en/story/fold-story" : "/story/fold-story",
        );
        // The folded developments are read under 精选's own scope.
        const asked = requests.filter((url) => url.pathname === "/api/site/stories/fold-story/developments").at(-1)!;
        assert.equal(asked.searchParams.get("scope"), "selected");
        const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        assert.equal(wide, false, `no horizontal scroll at ${width}px`);
        assert.deepEqual(errors, []);
        assert.deepEqual(blocked, []);
      } finally {
        await context.close();
      }
    }
});
