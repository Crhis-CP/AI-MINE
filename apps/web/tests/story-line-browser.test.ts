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
// Source times as the API projects them: a date alone, or a stated instant.
const dateOnly = (day: string) => ({
  meaning: "published",
  raw: day,
  local_date: day,
  local_time: null,
  timezone: null,
  utc: null,
  precision: "date",
  basis: "原文标注的发布时间",
  condition_text: null,
  meaning_label: "来源发布",
  label: `来源发布于 ${day}`,
  beijing_date: day,
});
const stated = (utc: string) => ({ ...dateOnly(utc.slice(0, 10)), raw: utc, local_time: utc.slice(11, 19), utc, precision: "second", label: "来源发布" });
const sourced = (id: string, factId: string, source: string, at: string, sourceTime: unknown, firstParty = false) => ({
  ...report(id, factId, source, at, firstParty),
  sourceTime,
});
// The live audit's story (2026-11-07), synthetic: the newest development was first reported by a source that gives
// a date alone (stored at UTC midnight), and a later report of the first development is the story's newest report.
const auditTimeline = [
  sourced("audit-newest", "audit-1", "合成有色网", "2026-11-06T01:38:22.000Z", stated("2026-11-06T01:38:22Z")),
  sourced("audit-experts", "audit-3", "合成矿业门户", "2026-11-06T00:00:00.000Z", dateOnly("2026-11-06")),
  sourced("audit-analysis", "audit-2", "合成矿业在线", "2026-11-05T18:24:13.000Z", stated("2026-11-05T18:24:13Z")),
  sourced("audit-official", "audit-1", "合成铜业公司", "2026-11-04T16:00:00.000Z", dateOnly("2026-11-05"), true),
];
const auditStory = {
  ...base,
  publicId: "audit-story",
  status: "active",
  reportCount: 4,
  sourceCount: 4,
  firstReportAt: "2026-11-04T16:00:00.000Z",
  latestAt: "2026-11-06T01:38:22.000Z",
  latest: "合成：模型另写的一句最新进展",
  whyHot: { participants48h: 9, newParticipants6h: 0, recentReports24h: 3, observationComplete: true, rank: 1, heat: 44 },
  developments: [
    {
      factId: "audit-3",
      title: "合成进展：部长宣布组建专家组",
      occurredAt: null,
      firstReportAt: "2026-11-06T00:00:00.000Z",
      reportCount: 1,
      representative: auditTimeline[1],
    },
    {
      factId: "audit-2",
      title: "合成进展：审计查出虚报产量",
      occurredAt: null,
      firstReportAt: "2026-11-05T18:24:13.000Z",
      reportCount: 1,
      representative: auditTimeline[2],
    },
    {
      factId: "audit-1",
      title: "合成进展：股东大会支持整改",
      occurredAt: null,
      firstReportAt: "2026-11-04T16:00:00.000Z",
      reportCount: 2,
      representative: auditTimeline[3],
    },
  ],
  officialReports: [auditTimeline[3]],
  timeline: auditTimeline,
};
// 观察中, one party in 48 hours and nothing since: the latest update came from the date-only source.
const watchTimeline = [
  sourced("watch-portal", "watch-1", "合成矿业门户", "2026-11-05T00:00:00.000Z", dateOnly("2026-11-05")),
  sourced("watch-report", "watch-1", "合成矿业报道", "2026-11-04T16:00:00.000Z", dateOnly("2026-11-05")),
];
const watchStory = {
  ...base,
  publicId: "watch-story",
  status: "watching",
  reportCount: 2,
  sourceCount: 2,
  firstReportAt: "2026-11-04T16:00:00.000Z",
  latestAt: "2026-11-05T00:00:00.000Z",
  whyHot: { participants48h: 1, newParticipants6h: 0, recentReports24h: 0, observationComplete: true, rank: null, heat: null },
  developments: [
    {
      factId: "watch-1",
      title: "合成进展：矿业权年费改革生效",
      occurredAt: null,
      firstReportAt: "2026-11-04T16:00:00.000Z",
      reportCount: 2,
      representative: watchTimeline[0],
    },
  ],
  officialReports: [],
  timeline: watchTimeline,
};
// Two picked reports of one three-step story on the home feed.
const progressCard = (id: string, position: number) => ({
  key: id,
  anchorAt: hour(position),
  item: {
    id,
    title: `合成精选 ${id}`,
    summary: "合成导读",
    reason: null,
    source: { name: "合成来源" },
    publishedAt: hour(position),
    timelineAt: hour(position),
    category: null,
    tags: [],
    score: null,
    selected: true,
    channel: "news",
  },
  group: null,
  storyProgress: {
    story: { publicId: "audit-story", title: "合成事件" },
    developmentCount: 3,
    position,
    previous: position > 1 ? { title: "合成进展：上一步", at: hour(position - 1) } : null,
    latest: position < 3 ? { title: "合成进展：最新一步", at: hour(3) } : null,
    backgroundCount: 0,
  },
});
const stories: Record<string, unknown> = {
  "audit-story": auditStory,
  "watch-story": watchStory,
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
  if (url.pathname === "/api/site/timeline")
    return send({
      filters: { channel: "all", category: null, tag: null, topic: null, jurisdiction: null },
      cards: [progressCard("progress-second", 2), progressCard("progress-first", 1)],
      nextCursor: null,
      refreshAt: null,
      hot: null,
      dayCounts: {},
      generatedAt: hour(6),
    });
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

test("最新进展 is the newest development: its title, the time it was first reported and its own report", { timeout: 30000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", reducedMotion: "reduce" });
  try {
    await isolateBrowser(context, [origin]);
    const page = await context.newPage();
    await page.goto(`${origin}/story/audit-story`);
    const latest = page.locator("#event-overview [data-latest-development]");
    await expect(latest).toHaveAttribute("data-latest-development", "audit-3");
    // Before: the model's sentence, the story's newest report time (09:38) and a link to that other report.
    await expect(latest.getByRole("link")).toHaveText("合成进展：部长宣布组建专家组");
    await expect(latest.getByRole("link")).toHaveAttribute("href", "/items/audit-experts");
    await expect(latest).not.toContainText("模型另写");
    // That development was first reported by a source that gave only its date.
    await expect(latest.locator("time")).toHaveText("11月6日");
    await expect(latest.locator("time")).toHaveAttribute("datetime", "2026-11-06");
    // The line marks the same development as the newest, with the same date.
    const node = page.locator('#event-storyline [data-development="audit-3"]');
    await expect(node).toContainText("最新");
    await expect(node.locator("time").first()).toHaveText("11月6日");
  } finally {
    await context.close();
  }
});

test("a date-only report never shows a clock: not on its row, its development, or the story's record", { timeout: 30000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", reducedMotion: "reduce" });
  try {
    await isolateBrowser(context, [origin]);
    const page = await context.newPage();
    await page.goto(`${origin}/story/audit-story`);
    const row = page.locator("#event-reports li").filter({ has: page.getByRole("link", { name: "合成报道 audit-experts" }) });
    await expect(row.locator("time")).toHaveText("—");
    await expect(row.locator("time")).toHaveAttribute("title", /2026-11-06/);
    // A stated time keeps its clock.
    const timed = page.locator("#event-reports li").filter({ has: page.getByRole("link", { name: "合成报道 audit-newest" }) });
    await expect(timed.locator("time")).toHaveText("09:38");
    await page.goto(`${origin}/story/watch-story`);
    const record = page.locator("aside section").filter({ has: page.getByRole("heading", { name: "事件记录" }) });
    await expect(record).toContainText(/最早报道\s*11月5日/);
    await expect(record).toContainText(/最近更新\s*11月5日/);
    await expect(page.locator("header").filter({ has: page.getByRole("heading", { level: 1 }) })).toContainText("11月5日更新");
    const visible = await page.locator("body").innerText();
    assert.doesNotMatch(visible, /08:00/, "a source's date is never shown as 08:00 Beijing time");
  } finally {
    await context.close();
  }
});

test("为什么热 says only what the data shows, and is left out when nothing is new", { timeout: 30000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", reducedMotion: "reduce" });
  try {
    await isolateBrowser(context, [origin]);
    const page = await context.newPage();
    await page.goto(`${origin}/story/audit-story`);
    const why = page.locator("aside section").filter({ has: page.getByRole("heading", { name: "为什么热" }) });
    await expect(why).toContainText("9 个独立主体参与讨论或报道。");
    await expect(why).not.toContainText("新增");
    await expect(why).toContainText("3 篇近期报道");
    await expect(why.getByRole("link", { name: /热点榜第\s*1\s*名/ })).toHaveAttribute("href", "/hot");
    // 观察中 with one party in 48 hours, none new and no recent report: nothing to explain.
    await page.goto(`${origin}/story/watch-story`);
    await expect(page.locator("header").filter({ has: page.getByRole("heading", { level: 1 }) })).toContainText("观察中");
    await expect(page.getByRole("heading", { name: "为什么热" })).toHaveCount(0);
    await expect(page.locator("aside")).not.toContainText("篇近期报道");
  } finally {
    await context.close();
  }
});

test("every feed card of a story says its step the same way: 第 n 次（共 N 次）", { timeout: 30000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", reducedMotion: "reduce" });
  try {
    await isolateBrowser(context, [origin]);
    const page = await context.newPage();
    await page.goto(`${origin}/`);
    const lines = page.locator('[data-story-progress="audit-story"]');
    await expect(lines).toHaveCount(2);
    const texts = await lines.allInnerTexts();
    assert.match(texts[0]!, /事件进展\s*·\s*第 2 次（共 3 次）\s*·\s*上次：/);
    assert.match(texts[1]!, /事件进展\s*·\s*第 1 次（共 3 次）\s*·\s*最新：/);
    await page.goto(`${origin}/en`);
    await expect(page.locator('[data-story-progress="audit-story"]').first()).toContainText("update 2 of 3");
  } finally {
    await context.close();
  }
});
