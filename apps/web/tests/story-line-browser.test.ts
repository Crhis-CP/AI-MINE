// The story page reads as a line of developments: one node per development with its reports folded under
// it, background before the first node and dated milestones after the last. Production web, synthetic API.
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
const hour = (h: number) => new Date(Date.UTC(2026, 10, 3, h, 30)).toISOString();
const report = (id: string, factId: string, source: string, at: string, firstParty = false) => ({
  id,
  title: `合成报道 ${id}`,
  summary: `合成摘要 ${id}`,
  source: { id: `source-${source}`, name: source, kind: "web_list", firstParty },
  publishedAt: at,
  originalUrl: `https://example.invalid/${id}`,
  selected: false,
  factId,
});
// Development 2: three outlets, the official one published last but listed first when opened.
const timeline = [
  report("d2-media-a", "fact-2", "合成通讯社", hour(3)),
  report("d2-media-b", "fact-2", "合成周刊", hour(4)),
  report("d2-official", "fact-2", "合成公司公告", hour(5), true),
  report("d1-official", "fact-1", "合成公司公告", hour(1), true),
];
const base = {
  publicId: "line-story",
  title: "合成事件：铜矿两次调整计划",
  status: "settled",
  reportCount: 4,
  sourceCount: 3,
  firstReportAt: hour(1),
  latestAt: hour(5),
  digest: "合成综述：铜矿涌水后先维持指引，随后下调指引并推迟复产。",
  digestUpdatedAt: hour(6),
  summary: null,
  excerpt: null,
  latest: "合成最新进展",
  whyHot: { participants48h: 0, newParticipants6h: 0, recentReports24h: 0, observationComplete: true, rank: null, heat: null },
  developments: [
    { factId: "fact-2", title: "合成进展：指引下调至30–35万吨", occurredAt: null, firstReportAt: hour(3), reportCount: 3, representative: timeline[2] },
    { factId: "fact-1", title: "合成进展：地下矿区涌水", occurredAt: null, firstReportAt: hour(1), reportCount: 1, representative: timeline[3] },
  ],
  officialReports: [timeline[2], timeline[3]],
  timeline,
  heat: [],
  related: [],
};
const stories: Record<string, unknown> = {
  "line-story": {
    ...base,
    keyChanges: [{ item: "2027年产量指引", before: "38–42万吨", after: "30–35万吨" }],
    next: [{ what: "公布复产方案", when: "2026年12月" }],
    background: [
      {
        relation: "SAME_STORY",
        item: {
          id: "line-background",
          title: "合成背景：三期选厂投产",
          summary: null,
          source: { name: "合成周刊" },
          selected: false,
          publishedAt: null,
          sourceTime: null,
          originalUrl: "https://example.invalid/background",
        },
      },
    ],
  },
  // One development, and a digest stored before the structured parts existed (no keyChanges / next).
  "single-story": {
    ...base,
    publicId: "single-story",
    reportCount: 3,
    developments: [base.developments[0]],
    officialReports: [timeline[2]],
    timeline: timeline.slice(0, 3),
  },
};

const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://fixture");
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  const send = (value: unknown) => res.end(JSON.stringify(value));
  if (url.pathname === "/api/site/meta") return send({ changelogVersion: null });
  if (url.pathname === "/api/site/content-version") return send({ version: "1", withdrawalVersion: "1" });
  if (url.pathname === "/api/site/items/saved") return send({ items: [], unavailableIds: [] });
  const story = stories[url.pathname.replace("/api/site/stories/", "")];
  if (story) return send(story);
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

test("developments are nodes, oldest first, with their reports folded under them on desktop and phone", { timeout: 60000 }, async () => {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "zh-CN", reducedMotion: "reduce" });
    try {
      const blocked = await isolateBrowser(context, [origin]),
        page = await context.newPage(),
        errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${origin}/story/line-story`);
      const line = page.locator("#event-storyline");
      await expect(line.getByRole("heading", { name: "事件脉络" })).toBeVisible();
      // Background, the two developments in order, then what comes next.
      const headings = await line.locator("h3").allInnerTexts();
      assert.deepEqual(headings, ["历史背景", "合成进展：地下矿区涌水", "合成进展：指引下调至30–35万吨", "接下来关注"]);
      await expect(line.locator("[data-development]")).toHaveCount(2);
      const latest = line.locator('[data-development="fact-2"]');
      await expect(latest).toContainText("第 2 个进展");
      const toggle = latest.getByRole("button", { name: /3 家报道/ });
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(latest.getByRole("link", { name: "合成报道 d2-media-a" })).toHaveCount(0);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      const opened = await latest.locator("ol a").allInnerTexts();
      assert.deepEqual(opened, ["合成报道 d2-official", "合成报道 d2-media-a", "合成报道 d2-media-b"], "official report first, then by time");
      // A single-report development shows its source, not a toggle.
      await expect(line.locator('[data-development="fact-1"]').getByRole("button")).toHaveCount(0);
      await expect(line).toContainText("2026年12月");
      await expect(line).toContainText("公布复产方案");
      // Before → after values sit with the digest.
      const changes = page.locator("#event-overview table");
      await expect(changes.getByRole("rowheader", { name: "2027年产量指引" })).toBeVisible();
      await expect(changes).toContainText("38–42万吨");
      await expect(changes).toContainText("30–35万吨");
      // The flat list remains as its own section.
      await expect(page.locator("#event-reports").getByRole("heading", { name: "全部报道" })).toBeVisible();
      await expect(page.locator("#event-reports").getByRole("link", { name: /合成报道/ })).toHaveCount(4);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.deepEqual(errors, []);
      assert.deepEqual(blocked, []);
    } finally {
      await context.close();
    }
  }
});

test("one development is still a node with folded reports, and an older digest shows no empty structure", { timeout: 30000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", reducedMotion: "reduce" });
  try {
    await isolateBrowser(context, [origin]);
    const page = await context.newPage();
    await page.goto(`${origin}/story/single-story`);
    const line = page.locator("#event-storyline");
    await expect(line.locator("[data-development]")).toHaveCount(1);
    await expect(line.getByRole("button", { name: /3 家报道/ })).toHaveAttribute("aria-expanded", "false");
    await expect(line).not.toContainText("第 1 个进展");
    await expect(line.getByRole("heading", { name: "接下来关注" })).toHaveCount(0);
    await expect(page.locator("#event-overview table")).toHaveCount(0);
    await expect(page.locator("#event-overview")).toContainText("合成综述");
    // English interface: the same line under translated labels.
    await page.goto(`${origin}/en/story/single-story`);
    await expect(page.locator("#event-storyline").getByRole("heading", { name: "Storyline" })).toBeVisible();
    await expect(page.locator("#event-storyline").getByRole("button", { name: /3 outlets reported/ })).toBeVisible();
  } finally {
    await context.close();
  }
});
