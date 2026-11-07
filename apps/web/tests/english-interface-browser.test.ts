// The English interface (/en) end to end, against the defects of the 2026-11-07 audit: each report address
// opens its own kind, links, forms and redirects keep the reader under /en, and the report masthead, the
// story page and the news cards read in English while the Chinese pages stay as they were. Production web,
// synthetic read-only API; no external network or accounts.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { chromium, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { beijingDate } from "@amp/contracts/time";
import { browserExecutable, isolateBrowser } from "./browser.ts";
import { webEnvironment } from "../runtime-env.ts";

let browser: Browser,
  web: ChildProcess,
  origin = "";
const HOUR = 3600_000;
const now = Date.now();
const ago = (hours: number) => new Date(now - hours * HOUR).toISOString();
/** Chinese characters and the full-width brackets, colon and enumeration comma. */
const CJK = /[㐀-鿿（）：、]/;

// Reports: three dailies (the latest is issue 3), two weeklies, two monthlies.
const INDEX = {
  daily: [
    { key: "2026-11-06", title: "合成日报：铜矿扩建获批", count: 3 },
    { key: "2026-11-05", title: "合成日报：前一日要闻", count: 2 },
    { key: "2026-11-04", title: "合成日报：更早一期", count: 1 },
  ],
  weekly: [
    { key: "2026-W44", title: "合成周报：本周矿业综述", count: 4 },
    { key: "2026-W43", title: "合成周报：上一周", count: 3 },
  ],
  monthly: [
    { key: "2026-10", title: "合成月报：十月盘点", count: 5 },
    { key: "2026-09", title: "合成月报：九月盘点", count: 4 },
  ],
} as const;
type Kind = keyof typeof INDEX;
const cite = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  itemId: id,
  title,
  summary: `合成导读 ${id}`,
  sourceName: "合成官方来源",
  sourceUrl: `https://example.invalid/${id}`,
  sourceId: "official",
  firstParty: true,
  role: "官方",
  storyPublicId: null,
  publishedAt: "2026-11-05T03:00:00Z",
  available: true,
  ...extra,
});
function report(kind: Kind, at: number) {
  const entry = INDEX[kind][at]!;
  const lead = cite(`${entry.key}-lead`, entry.title);
  const more = cite(`${entry.key}-more`, `合成看点 ${entry.key}`, {
    sources: 3,
    followUp: "2026-11-04",
    related: [
      {
        itemId: `${entry.key}-related`,
        title: "合成相关进展",
        sourceName: "合成报道来源",
        sourceUrl: "https://example.invalid/r",
        sourceId: null,
        storyPublicId: null,
        available: true,
      },
    ],
  });
  const market = cite(`${entry.key}-market`, `合成市场报道 ${entry.key}`, { firstParty: false });
  // The September monthly lost a citation: the API keeps one page under its fixed "仍公开的报道", marks the
  // withdrawn story with its fixed title and names the correction with one of its fixed reasons
  // (publication/reports.ts); the interface names those in its own language (TASK-0573).
  const withdrawnIssue = kind === "monthly" && entry.key === "2026-09";
  const gone = {
    ...cite(`${entry.key}-gone`, "已撤回的报道"),
    summary: null,
    sourceName: "",
    sourceUrl: "",
    sourceId: null,
    publishedAt: null,
    available: false,
  };
  const sections = withdrawnIssue
    ? [{ label: "仍公开的报道", summary: null, items: [lead, more, market, gone] }]
    : [
        { label: "企业与项目", summary: null, items: [lead, more] },
        { label: "市场与技术", summary: null, items: [market] },
      ];
  return {
    kind,
    key: entry.key,
    title: entry.title,
    windowStart: "2026-11-05T00:00:00Z",
    windowEnd: "2026-11-06T00:00:00Z",
    generatedAt: "2026-11-06T00:00:00Z",
    firstPublishedAt: "2026-11-06T00:00:00Z",
    revision: 1,
    generationStatus: "ready",
    lead: { title: entry.title, leadParagraph: "合成导语" },
    leadItemId: lead.itemId,
    overview: null,
    highlights: withdrawnIssue ? [more, gone] : [more],
    ...(withdrawnIssue ? { corrections: [{ revision: 2, reason: "部分引用已撤回，本期仅保留仍可公开的内容。", at: "2026-10-02T02:00:00Z" }] } : {}),
    sections,
    stories: sections.flatMap((s) => s.items.map((item) => ({ ...item, label: s.label }))),
    flashes: [],
    metrics: { totalEvents: 3, sourcesCount: 5, firstPartyEvents: 1 },
    readingMinutes: 4,
    prev: INDEX[kind][at + 1]?.key ?? null,
    next: at > 0 ? INDEX[kind][at - 1]!.key : null,
  };
}

// A story whose last report came two hours ago, an official report leading its newest development.
const storyReport = (id: string, factId: string, source: string, at: string, firstParty = false) => ({
  id,
  title: `合成报道 ${id}`,
  summary: `合成摘要 ${id}`,
  source: { id: `source-${id}`, name: source, kind: "web_list", firstParty },
  publishedAt: at,
  originalUrl: `https://example.invalid/${id}`,
  selected: false,
  factId,
});
const timeline = [
  storyReport("s-media", "fact-1", "合成通讯社", ago(5)),
  storyReport("s-official", "fact-1", "合成公司公告", ago(4), true),
  storyReport("s-older", "fact-0", "合成周刊", ago(30)),
];
const hourMark = Math.floor(now / HOUR) * HOUR;
const story = {
  publicId: "en-story",
  title: "合成事件：铜矿扩建",
  status: "active",
  reportCount: 3,
  sourceCount: 3,
  firstReportAt: ago(30),
  latestAt: ago(2),
  digest: "合成综述。",
  digestUpdatedAt: ago(3),
  summary: null,
  excerpt: null,
  latest: "合成最新进展",
  whyHot: { participants48h: 4, newParticipants6h: 1, recentReports24h: 2, observationComplete: true, rank: 2, heat: 12 },
  developments: [
    { factId: "fact-0", title: "合成进展：项目获批", occurredAt: null, firstReportAt: ago(30), reportCount: 1, representative: timeline[2] },
    { factId: "fact-1", title: "合成进展：扩建开工", occurredAt: null, firstReportAt: ago(5), reportCount: 2, representative: timeline[1] },
  ],
  officialReports: [timeline[1]],
  timeline,
  heat: [5, 4, 3, 2, 1, 0].map((k) => ({ hour: new Date(hourMark - k * HOUR).toISOString(), heat: 10 + k, participants: 2 })),
  related: [],
};

const card = (id: string) => ({
  id,
  title: `合成动态 ${id}`,
  summary: "合成导读",
  reason: null,
  publishedAt: ago(1),
  timelineAt: ago(1),
  // The model tags an item with its category's Chinese name as well: "市场价格" is commodity_market.
  category: "commodity_market",
  tags: ["市场价格", "合成矿种"],
  score: null,
  selected: false,
  channel: "news",
  source: { name: "合成来源" },
});
const item = {
  ...card("en-item"),
  revision: 1,
  originalTitle: null,
  source: { id: "fixture-source", name: "合成来源", kind: "web_list", firstParty: true },
  links: { original: "https://example.invalid/source" },
  discoveredAt: ago(1),
  story: null,
  readingMode: "full",
  author: null,
  language: "zh",
  body: { zh: "<p>合成正文</p>", original: null, zhKind: "original", complete: true },
  outline: [],
  relatedStories: [],
  indexable: false,
  group: null,
  hasTranslation: false,
  bodyLanguage: "zh",
};

// The changelog: a major update with its version, an improvement, and a date-only notice; titles and bodies are content.
const changelog = {
  latestVersion: "2026-11-07T06:52",
  releases: [
    { date: "2026-11-07", time: "06:52", kind: "优化", title: "合成优化标题", body: ["合成优化说明。", "- 合成要点"] },
    { date: "2026-11-07", time: "02:10", kind: "更新", title: "合成更新标题", body: ["合成更新说明。"] },
    { date: "2026-10-06", time: "02:50", kind: "重大更新", version: "2.0", title: "合成大版本", body: ["合成大版本说明。"] },
    { date: "2026-09-15", kind: "公告", title: "合成公告标题", body: ["合成公告说明。"] },
  ],
};

const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://fixture");
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  const send = (value: unknown) => res.end(JSON.stringify(value));
  const path = url.pathname;
  if (path === "/api/site/meta") return send({ changelogVersion: null });
  if (path === "/api/site/content-version") return send({ version: "1", withdrawalVersion: "1" });
  if (path === "/api/site/items/availability")
    return send(
      Object.fromEntries(
        (url.searchParams.get("ids") ?? "")
          .split(",")
          .filter(Boolean)
          .map((id) => [id, "public"]),
      ),
    );
  if (path === "/api/site/jurisdictions") return send([]);
  if (path === "/api/site/changelog") return send(changelog);
  const reports = /^\/api\/site\/reports\/(daily|weekly|monthly)(?:\/(latest-page|navigation\/[^/]+|months\/[^/]+|[^/]+))?$/.exec(path);
  if (reports) {
    const kind = reports[1] as Kind;
    const rest = reports[2];
    if (!rest || rest.startsWith("navigation/") || rest.startsWith("months/")) return send({ items: INDEX[kind] });
    if (rest === "latest-page") return send({ index: INDEX[kind], report: report(kind, 0) });
    const at = INDEX[kind].findIndex((entry) => entry.key === rest);
    if (at >= 0) return send(report(kind, at));
  }
  if (path === "/api/site/pool")
    return send({
      filters: {
        channel: "all",
        category: url.searchParams.get("category"),
        tag: url.searchParams.get("tag"),
        topic: null,
        jurisdiction: null,
        q: url.searchParams.get("q"),
        tab: "time",
      },
      items: [card("en-a")],
      hot: [{ rank: 1, title: "合成热点事件", heat: 12, trend: "up", storyPublicId: "en-story", itemId: null }],
      facets: { sources: [{ id: "fixture-source", name: "合成来源", count: 12 }], minerals: ["合成矿种"] },
      page: Number(url.searchParams.get("page") || 1),
      pageCount: 3,
      total: 41,
      todayCount: 1,
      freshness: ago(0),
      generatedAt: ago(0),
    });
  if (path === "/api/site/hot")
    return send({
      computedAt: ago(1),
      ruleVersion: "fixture-1",
      windowHours: 48,
      entries: [
        {
          rank: 1,
          story: { publicId: "en-story", title: story.title },
          heat: 12,
          trend: "up",
          trendPct: 20,
          badges: ["surge"],
          participantCount: 4,
          sourceCount: 3,
          signalCount: 12,
          reportCount: 3,
          sourceNames: ["合成通讯社", "合成公司公告", "合成周刊"],
          latestAt: ago(2),
          firstReportAt: ago(30),
          representative: null,
          spark: Array.from({ length: 24 }, (_, h) => h / 2),
          summary: "合成热点摘要",
          latest: "合成最新进展",
        },
      ],
    });
  if (path === "/api/site/stories/en-story") return send(story);
  if (path === "/api/site/stories/merged-story") {
    res.statusCode = 308;
    res.setHeader("location", "/api/site/stories/en-story");
    return send({ mergedInto: "en-story" });
  }
  if (path === "/api/site/items/en-item") return send(item);
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
async function open(width: number): Promise<{ context: BrowserContext; page: Page; errors: string[]; blocked: string[] }> {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
  const blocked = await isolateBrowser(context, [origin]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { context, page, errors, blocked };
}

/** Addresses every language shares (the same rule as i18n localizedPath). */
const SHARED = /^\/(?:api|feed|admin|rss|og|media|v1|v3|mcp)(?:[/?#.]|$)|\.(?:xml|json|png|svg|ico|txt)(?:[?#]|$)/;
/** Internal links and form actions on the page that would take a reader of the English interface to a Chinese page. */
async function chineseAddresses(page: Page): Promise<string[]> {
  const found = await page.evaluate(() => [
    ...[...document.querySelectorAll("a[href]")].map((a) => ({ to: a.getAttribute("href")!, switch: a.getAttribute("hreflang") === "zh-CN" })),
    ...[...document.querySelectorAll("form[action]")].map((form) => ({ to: form.getAttribute("action")!, switch: false })),
  ]);
  return found
    .filter((a) => a.to.startsWith("/") && !a.to.startsWith("//") && !a.switch && !SHARED.test(a.to) && !/^\/en(?:[/?#]|$)/.test(a.to))
    .map((a) => a.to);
}

/**
 * Chinese in the interface around the content: visible text and labelling attributes that hold Chinese or
 * full-width punctuation. Every piece of synthetic content above contains "合成", so whatever Chinese is
 * left is the interface's own. Chinese on purpose: the site's name, the switch to the Chinese interface, and
 * 宋体, the name of the Chinese serif face the reading tools offer for the (Chinese) text.
 */
async function chineseChrome(page: Page): Promise<string[]> {
  const pieces = await page.evaluate(() => {
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || parent.closest("script, style, noscript, [aria-hidden='true']") || !parent.checkVisibility()) continue;
      out.push(node.textContent ?? "");
    }
    for (const element of document.body.querySelectorAll("[aria-label], [title], [placeholder], img[alt]"))
      for (const name of ["aria-label", "title", "placeholder", "alt"]) if (element.hasAttribute(name)) out.push(element.getAttribute(name)!);
    return out;
  });
  return pieces
    .map((text) => text.trim())
    .filter((text) => !text.includes("合成"))
    .filter((text) => CJK.test(["AI矿策", "切换到中文", "中文", "(宋体)"].reduce((rest, name) => rest.replaceAll(name, ""), text)))
    .filter((text) => !PENDING.some((pending) => pending.test(text)));
}
const PENDING: RegExp[] = [];

test("the interface chrome of English pages has no Chinese outside the content", { timeout: 60000 }, async () => {
  for (const width of [390, 1440]) {
    const { context, page, errors } = await open(width);
    try {
      for (const path of [
        "/en/daily/2026-11-06",
        "/en/weekly/2026-W44",
        "/en/monthly/2026-10",
        "/en/daily/archive",
        "/en/all",
        `/en/all?tag=${encodeURIComponent("市场价格")}`,
        "/en/items/en-item",
        "/en/story/en-story",
        "/en/hot",
        "/en/more",
        "/en/nothing-here",
        "/en/about",
        "/en/feedback",
        "/en/agent",
      ]) {
        await page.goto(`${origin}${path}`);
        await expect(page.locator("html")).toHaveAttribute("lang", "en");
        assert.deepEqual(await chineseChrome(page), [], `${path} at ${width}px`);
      }
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
});

test("every report address in English opens its own kind of report", async () => {
  for (const [path, title] of [
    ["/en/weekly", INDEX.weekly[0].title],
    ["/en/monthly", INDEX.monthly[0].title],
    ["/en/daily", INDEX.daily[0].title],
    ["/en/weekly/2026-W44", INDEX.weekly[0].title],
    ["/en/weekly/2026-W43", INDEX.weekly[1].title],
    ["/en/monthly/2026-10", INDEX.monthly[0].title],
    ["/en/daily/2026-11-05", INDEX.daily[1].title],
    ["/weekly/2026-W44", INDEX.weekly[0].title],
    ["/monthly", INDEX.monthly[0].title],
  ] as const) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert.ok(html.includes(title), `${path} shows ${title}`);
    for (const kind of ["daily", "weekly", "monthly"] as const)
      if (!path.includes(kind)) assert.ok(!html.includes(INDEX[kind][0].title), `${path} does not show the ${kind} report`);
  }
  // Keys of another kind are still not found, in either language.
  for (const path of ["/en/weekly/2026-11-06", "/en/monthly/2026-W44", "/weekly/2026-10"]) assert.equal((await fetch(`${origin}${path}`)).status, 404, path);
});

test("redirects from English pages land on English pages", async () => {
  const location = async (path: string) => {
    const response = await fetch(`${origin}${path}`, { redirect: "manual" });
    assert.ok(response.status >= 300 && response.status < 400, `${path} redirects (${response.status})`);
    return response.headers.get("location");
  };
  assert.equal(await location("/en?q=%E9%93%9C"), "/en/all?q=%E9%93%9C");
  assert.equal(await location("/en/topics/copper/page/1"), "/en/topics/copper");
  assert.equal(await location("/en/story/merged-story"), "/en/story/en-story");
  // The Chinese addresses keep redirecting to Chinese pages.
  assert.equal(await location("/?q=%E9%93%9C"), "/all?q=%E9%93%9C");
  assert.equal(await location("/topics/copper/page/1"), "/topics/copper");
  assert.equal(await location("/story/merged-story"), "/story/en-story");
});

test("links and forms on English pages keep the /en prefix", { timeout: 90000 }, async () => {
  for (const width of [390, 1440]) {
    const { context, page, errors, blocked } = await open(width);
    try {
      for (const path of [
        "/en/daily/2026-11-06",
        "/en/weekly/2026-W44",
        "/en/monthly/2026-10",
        "/en/daily/archive",
        "/en/all",
        "/en/items/en-item",
        "/en/story/en-story",
        "/en/hot",
        "/en/more",
        "/en/nothing-here",
      ]) {
        await page.goto(`${origin}${path}`);
        await expect(page.locator("html")).toHaveAttribute("lang", "en");
        assert.deepEqual(await chineseAddresses(page), [], `${path} at ${width}px links only to English pages`);
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(blocked, []);
    } finally {
      await context.close();
    }
  }
  // The places the audit found, one by one, and the language switch that leads back to Chinese.
  const { context, page } = await open(1440);
  try {
    await page.goto(`${origin}/en/more`);
    const more = page.getByRole("main");
    await expect(more.getByRole("link", { name: "Trending", exact: true })).toHaveAttribute("href", "/en/hot");
    await expect(more.getByRole("link", { name: "切换到中文" })).toHaveAttribute("href", "/more");
    await page.goto(`${origin}/en/all`);
    const article = page.locator('[data-item-id="en-a"]');
    await expect(article.getByRole("link", { name: "Markets & prices", exact: true })).toHaveAttribute("href", "/en/all?category=commodity_market");
    await expect(article.getByRole("link", { name: "#合成矿种" })).toHaveAttribute("href", `/en/all?tag=${encodeURIComponent("合成矿种")}`);
    await expect(page.getByRole("link", { name: "合成热点事件" })).toHaveAttribute("href", "/en/story/en-story");
    await expect(page.getByRole("navigation", { name: "Pagination" }).getByRole("link", { name: "2", exact: true })).toHaveAttribute("href", "/en/all?page=2");
    await expect(page.locator('form[role="search"]').first()).toHaveAttribute("action", "/en/all");
    await page.goto(`${origin}/en/items/en-item`);
    await expect(page.getByRole("link", { name: "#合成矿种" }).first()).toHaveAttribute("href", `/en/all?tag=${encodeURIComponent("合成矿种")}`);
    // The daily's kind switch goes to the English weekly, and the weekly page is the weekly.
    await page.goto(`${origin}/en/daily/2026-11-06`);
    const kinds = page.getByRole("navigation", { name: "Switch between daily, weekly and monthly" });
    await expect(kinds.getByRole("link", { name: "Weekly", exact: true })).toHaveAttribute("href", "/en/weekly");
    await kinds.getByRole("link", { name: "Weekly", exact: true }).click();
    await expect(page).toHaveURL(`${origin}/en/weekly`);
    await expect(page.locator("#report-start")).toContainText("Weekly brief");
    await expect(page.getByRole("heading", { name: INDEX.weekly[0].title })).toBeVisible();
    // From the Chinese weekly, the language switch opens the same weekly in English.
    await page.goto(`${origin}/weekly/2026-W44`);
    const english = page.getByRole("link", { name: "Switch to English" });
    await expect(english).toHaveAttribute("href", "/en/weekly/2026-W44");
    await english.click();
    await expect(page).toHaveURL(`${origin}/en/weekly/2026-W44`);
    await expect(page.getByRole("heading", { name: INDEX.weekly[0].title })).toBeVisible();
    await expect(page.locator("#report-start")).toContainText("Weekly brief");
  } finally {
    await context.close();
  }
});

test("the English report pages speak English around the Chinese news", { timeout: 60000 }, async () => {
  for (const width of [390, 1440]) {
    const { context, page, errors } = await open(width);
    try {
      await page.goto(`${origin}/en/daily/2026-11-06`);
      const masthead = page.locator("header").filter({ has: page.locator("#report-start") });
      const text = await masthead.innerText();
      assert.ok(!CJK.test(text), `the masthead has no Chinese: ${text}`);
      assert.ok(!/\bPage\b/.test(text), "the issue is not called a page");
      assert.match(text, /Issue 3/);
      assert.match(text, /Friday, November 6, 2026/);
      assert.match(text, /Daily at 08:00 Beijing time/);
      assert.match(text, /November 2026/);
      assert.match(text, /\b3\s+major events\b/);
      assert.match(text, /\b5\s+sources\b/);
      assert.match(text, /\b1\s+first-party release\n/);
      await expect(page.locator("#report-start .sr-only")).toHaveText("Daily brief · Friday, November 6, 2026");
      await expect(page.locator("#report-start svg text")).toHaveText("Daily Brief");
      // Section names, the neighbours and the colophon are English too; story titles stay Chinese.
      await expect(page.getByRole("heading", { name: "Companies & projects" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Markets & technology" })).toBeVisible();
      await expect(page.getByText("Reported by 3 sources")).toBeVisible();
      await expect(page.getByText("Related developments and coverage (1)")).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Adjacent daily issues" })).toContainText("Previous day · Nov 5");
      await expect(page.locator("footer").filter({ hasText: "End of issue" })).toContainText("This daily brief is edited automatically");
      const tabs = page.getByRole("navigation", { name: "Switch between daily, weekly and monthly" });
      assert.deepEqual(await tabs.getByRole("link").allInnerTexts(), ["Daily", "Weekly", "Monthly"]);
      if (width === 1440) {
        await expect(masthead).toContainText("Metal mining · Daily headlines", { ignoreCase: true });
        await expect(masthead).toContainText("November");
        await expect(masthead).toContainText("3 issues this month");
        const archive = page.getByRole("navigation", { name: "Daily archive" });
        await expect(archive).toContainText("November 2026");
        assert.ok(!CJK.test((await archive.innerText()).replace(/合成日报：\S+/g, "")), "the archive column names months and days in English");
      } else {
        // The phone's recent issues: today's issue is "Today", the others by date.
        const chips = page.getByRole("link", { name: /^(Today|[A-Z][a-z]{2} \d{1,2})$/ });
        await expect(chips.first()).toBeVisible();
        const today = beijingDate(Date.now());
        assert.deepEqual(
          await chips.allInnerTexts(),
          INDEX.daily.map((e) => (e.key === today ? "Today" : `Nov ${Number(e.key.slice(8))}`)),
        );
      }
      // A weekly: its dates and its list of earlier issues.
      await page.goto(`${origin}/en/weekly/2026-W44`);
      const weekly = await page
        .locator("header")
        .filter({ has: page.locator("#report-start") })
        .innerText();
      assert.ok(!CJK.test(weekly), `the weekly masthead has no Chinese: ${weekly}`);
      assert.match(weekly, /Week 44, 2026/);
      assert.match(weekly, /Oct 26 — Nov 1/);
      assert.match(weekly, /Mondays at 10:00 Beijing time/);
      await expect(page.getByText("Past weekly briefs").first()).toBeVisible();
      await expect(page.locator("article time").first()).toHaveText("Nov 5");
      // The bound archive.
      await page.goto(`${origin}/en/daily/archive`);
      await expect(page.locator("#report-start svg text")).toHaveText("Daily Brief Archive");
      await expect(page.getByRole("heading", { name: "November 2026" })).toBeVisible();
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
});

test("the Chinese report pages are unchanged", async () => {
  const { context, page, errors } = await open(1440);
  try {
    await page.goto(`${origin}/daily/2026-11-06`);
    const masthead = await page
      .locator("header")
      .filter({ has: page.locator("#report-start") })
      .innerText();
    for (const words of [
      "第 3 期",
      "2026 年 11 月 6 日 · 星期五",
      "每天 08:00 出刊",
      "金属矿业 · 每日要闻",
      "十一月",
      "本月 3 期",
      "件大事",
      "件一手发布",
      "个来源",
    ])
      assert.ok(masthead.includes(words), `${words} in ${masthead}`);
    await expect(page.locator("#report-start .sr-only")).toHaveText("矿业日报 · 2026 年 11 月 6 日 · 星期五");
    await expect(page.getByRole("heading", { name: "企业与项目" })).toBeVisible();
    await expect(page.getByText("3 家来源报道")).toBeVisible();
    await expect(page.getByText("相关进展与报道（1）")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "前后日报" })).toContainText("前一日 · 11月5日");
    await expect(page.locator("footer").filter({ hasText: "（本期完）" })).toContainText(
      "AI矿策 日报由编辑系统根据公开来源自动编辑，每条均附原文 · 日报合订本",
    );
    const tabs = page.getByRole("navigation", { name: "切换日报、周报、月报" });
    await expect(tabs.getByRole("link", { name: "周报", exact: true })).toHaveAttribute("href", "/weekly");
    await expect(page.getByRole("navigation", { name: "日报历史" })).toContainText("2026 年 11 月");
    await page.goto(`${origin}/weekly/2026-W44`);
    const weekly = await page
      .locator("header")
      .filter({ has: page.locator("#report-start") })
      .innerText();
    for (const words of ["2026 年第 44 周 · 10.26 — 11.01", "每周一 10:00 出刊", "全年 2 期"]) assert.ok(weekly.includes(words), `${words} in ${weekly}`);
    await expect(page.getByText("往期矿业周报")).toBeVisible();
    await expect(page.locator("article time").first()).toHaveText("11.05");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("the English story page and news cards use English dates, word order and punctuation", { timeout: 60000 }, async () => {
  const { context, page, errors } = await open(1440);
  try {
    await page.goto(`${origin}/en/story/en-story`);
    const header = page.locator("header").filter({ has: page.getByRole("heading", { name: story.title }) });
    await expect(header).toContainText("updated 2 h ago");
    assert.ok(!(await header.innerText()).includes("ago updated"));
    const latest = page.locator("#event-overview").getByText("Latest", { exact: true }).locator("..");
    assert.match(await latest.innerText(), /^Latest\s*[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}$/);
    const reports = await page.locator("#event-reports").innerText();
    assert.ok(!/\d+月\d+日/.test(reports), "day headings are English");
    assert.match(reports, /\n[A-Z][a-z]{2} \d{1,2}\n/);
    const toggle = page.locator("#event-storyline").getByRole("button", { name: /outlets reported/ });
    await expect(toggle).toContainText("Official first-party: 合成公司公告");
    assert.ok(!(await toggle.innerText()).includes("："));
    const heat = await page.locator("#event-heat").innerText();
    assert.ok(!/[（）]/.test(heat), `the heat line has no Chinese brackets: ${heat}`);
    assert.ok(!/\d+月\d+日/.test(await page.locator("aside").last().innerText()), "the story record shows English dates");
    await page.goto(`${origin}/en/all`);
    const article = page.locator('[data-item-id="en-a"]');
    await expect(article.getByRole("link", { name: "#Markets & prices", exact: true })).toHaveAttribute(
      "href",
      `/en/all?tag=${encodeURIComponent("市场价格")}`,
    );
    await expect(article.getByRole("link", { name: "#市场价格" })).toHaveCount(0);
    assert.deepEqual(await page.locator('select[name="source"] option').allTextContents(), ["All sources", "合成来源 (12)"]);
    await page.goto(`${origin}/en/all?tag=${encodeURIComponent("市场价格")}`);
    await expect(page.getByRole("heading", { name: "#Markets & prices", level: 1 })).toBeVisible();
    await page.goto(`${origin}/en/hot`);
    await expect(page.getByText("Past 48 hours · 1 trending events")).toBeAttached();
    await expect(page.getByText("合成通讯社, 合成公司公告")).toBeVisible();
    await page.goto(`${origin}/hot`);
    await expect(page.getByText("过去48小时 · 1个热点")).toBeAttached();
    await expect(page.getByText("合成通讯社、合成公司公告")).toBeVisible();
    // Chinese cards keep the Chinese tag.
    await page.goto(`${origin}/all`);
    await expect(page.locator('[data-item-id="en-a"]').getByRole("link", { name: "#市场价格" })).toHaveAttribute(
      "href",
      `/all?tag=${encodeURIComponent("市场价格")}`,
    );
    assert.deepEqual(await page.locator('select[name="source"] option').allTextContents(), ["全部来源", "合成来源（12）"]);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("terms, privacy and about link only to English pages, the copy's own links included", { timeout: 60000 }, async () => {
  // The audit's A1: "[反馈页](/feedback)" inside the terms copy took a reader of /en/terms to the Chinese page.
  for (const width of [390, 1440]) {
    const { context, page, errors, blocked } = await open(width);
    try {
      for (const path of ["/en/terms", "/en/privacy", "/en/about"]) {
        await page.goto(`${origin}${path}`);
        await expect(page.locator("html")).toHaveAttribute("lang", "en");
        assert.deepEqual(await chineseAddresses(page), [], `${path} at ${width}px links only to English pages`);
      }
      await page.goto(`${origin}/en/terms`);
      const copy = page.locator(".prose");
      await expect(copy.getByRole("link", { name: "反馈页" })).toHaveAttribute("href", "/en/feedback");
      await expect(copy.getByRole("link", { name: "更新日志" })).toHaveAttribute("href", "/en/changelog");
      await expect(copy.getByRole("link", { name: "隐私说明" })).toHaveAttribute("href", "/en/privacy");
      await copy.getByRole("link", { name: "反馈页" }).click();
      await expect(page).toHaveURL(`${origin}/en/feedback`);
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      assert.deepEqual(errors, []);
      assert.deepEqual(blocked, []);
    } finally {
      await context.close();
    }
  }
  // The Chinese copy keeps its Chinese addresses.
  const { context, page } = await open(1440);
  try {
    await page.goto(`${origin}/terms`);
    await expect(page.locator(".prose").getByRole("link", { name: "反馈页" })).toHaveAttribute("href", "/feedback");
  } finally {
    await context.close();
  }
});

test("the English changelog names its days, months and kinds of update in English", { timeout: 60000 }, async () => {
  // The audit's A2: "2026 年 11 月 7 日 周六" over the English changelog.
  for (const width of [390, 1440]) {
    const { context, page, errors } = await open(width);
    try {
      await page.goto(`${origin}/en/changelog`);
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      assert.deepEqual(await chineseChrome(page), [], `/en/changelog at ${width}px`);
      assert.deepEqual(await chineseAddresses(page), [], `/en/changelog at ${width}px links only to English pages`);
      const day = page.locator("#d-2026-11-07 h2");
      await expect(day).toContainText("Nov 7, 2026");
      await expect(day).toContainText("Sat");
      await expect(page.locator("#d-2026-11-07")).toContainText("Improvement");
      await expect(page.locator("#d-2026-11-07")).toContainText("Update");
      await expect(page.locator("#d-2026-10-06")).toContainText("Major update 2.0");
      await expect(page.locator("#d-2026-10-06")).toContainText("Oct 6, 2026 Tue");
      await expect(page.locator("#d-2026-09-15")).toContainText("Notice");
      if (width === 1440) {
        const months = page.getByRole("navigation", { name: "By month" });
        assert.deepEqual(
          (await months.getByRole("link").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim()),
          ["November 2026 2 items", "October 2026 1 items", "September 2026 1 items"],
        );
      }
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
  // The Chinese changelog is unchanged.
  const { context, page } = await open(1440);
  try {
    await page.goto(`${origin}/changelog`);
    await expect(page.locator("#d-2026-11-07 h2")).toContainText("2026 年 11 月 7 日");
    await expect(page.locator("#d-2026-11-07 h2")).toContainText("周六");
    await expect(page.locator("#d-2026-10-06")).toContainText("重大更新 2.0");
    await expect(page.getByRole("navigation", { name: "按月份" })).toContainText("2026 年 11 月");
  } finally {
    await context.close();
  }
});

test("an English issue with a withdrawn citation names the API's fixed labels in English", { timeout: 60000 }, async () => {
  // The audit's A2: "仍公开的报道" as a section of /en/monthly/2026-10 once one of its citations was withdrawn.
  for (const width of [390, 1440]) {
    const { context, page, errors } = await open(width);
    try {
      await page.goto(`${origin}/en/monthly/2026-09`);
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      assert.deepEqual(await chineseChrome(page), [], `/en/monthly/2026-09 at ${width}px`);
      await expect(page.getByRole("heading", { name: "Coverage still public" })).toBeVisible();
      await expect(page.getByText("Withdrawn report").first()).toBeVisible();
      await expect(page.locator("#report-corrections").locator("..")).toContainText("Some citations were withdrawn");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
  const { context, page } = await open(1440);
  try {
    await page.goto(`${origin}/monthly/2026-09`);
    await expect(page.getByRole("heading", { name: "仍公开的报道" })).toBeVisible();
    await expect(page.getByText("已撤回的报道").first()).toBeVisible();
    await expect(page.locator("#report-corrections").locator("..")).toContainText("部分引用已撤回，本期仅保留仍可公开的内容。");
  } finally {
    await context.close();
  }
});

test("every time meaning and every fixed report label the API sends has an English phrase", async () => {
  const { PHRASES } = await import("../app/i18n/phrases.ts");
  const { TIME_MEANINGS } = await import("@amp/contracts/time-assertion");
  const fixed = [...Object.values(TIME_MEANINGS), "发布时间", "仍公开的报道", "已撤回的报道"];
  assert.deepEqual(
    fixed.filter((text) => !(text in PHRASES)),
    [],
  );
});
