import assert from "node:assert/strict";
import { normalizeSourceTime } from "@amp/contracts/time-assertion";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { chromium, expect, type Browser, type Route } from "@playwright/test";
import { browserExecutable, isolateBrowser } from "./browser.ts";
import { webEnvironment } from "../runtime-env.ts";
let origin = "",
  web: ChildProcess,
  browser: Browser;
let followups: "error" | "empty" | "ready" = "ready";
let submitted = "";
let showCorrections = true;
const feedbackKeys: string[] = [];
const story = { publicId: "639e5d80-a69c-4491-918a-69b1c6408af1", title: "合成真实事件" };
const source = { id: "source-r2", name: "原始发布方", kind: "rss", firstParty: true };
const card = {
  id: "fixture-r2",
  title: "矿业历史报道",
  summary: "合成导读",
  reason: null,
  source,
  publishedAt: "2020-01-01T00:00:00Z",
  timelineAt: "2020-01-01T00:00:00Z",
  category: null,
  tags: [],
  score: null,
  selected: false,
  channel: "news",
};
const summary = {
  ...card,
  revision: 1,
  originalTitle: null,
  links: { original: "https://example.invalid/original" },
  discoveredAt: "2026-10-01T00:00:00Z",
  story,
};
const detail = (id: string) => ({
  ...summary,
  id,
  readingMode: "full",
  author: null,
  language: "zh",
  body: null,
  outline: [],
  relatedStories: [],
  indexable: false,
  firstPublicAt: id === "unknown" ? null : "2026-10-12T00:00:00Z",
  readingState: id === "pending" ? "pending" : id === "restricted" ? "restricted" : "unavailable",
  hasTranslation: false,
  bodyLanguage: "zh",
  attribution: { publishers: [{ name: source.name, url: summary.links.original }], license: null, notice: null, legalUrl: null },
  group: { factId: "fact-current", story, reportCount: 2, additionalSourceCount: 1, developmentCount: 1 },
  eventCoverage: {
    representative: { ...summary, id },
    latest: { ...summary, id: "later", title: "新事实进展", source: { ...source, firstParty: false } },
    reportCount: 2,
  },
});
const api = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://fixture");
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  const send = (value: unknown) => res.end(JSON.stringify(value));
  if (url.pathname === "/openapi-v3.json") return send({ openapi: "3.1.0", info: { title: "Fixture v3" }, paths: { "/api/v3/items": {} } });
  if (url.pathname === "/api/site/meta") return send({ changelogVersion: null });
  if (url.pathname === "/api/site/content-version") return send({ version: "1", withdrawalVersion: "1" });
  if (url.pathname === "/api/site/jurisdictions") return send([]);
  if (url.pathname.startsWith("/api/site/reports/")) {
    const [, , , , kind, key] = url.pathname.split("/");
    if (url.pathname.includes("/navigation/")) return send({ items: [] });
    return send({
      kind,
      key,
      title: "合成公开报告",
      windowStart: "2026-10-01T00:00:00Z",
      windowEnd: "2026-10-12T00:00:00Z",
      generatedAt: "2026-10-12T00:00:00Z",
      revision: 2,
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
      ...(showCorrections ? { corrections: [{ revision: 2, reason: "部分引用已更新，报告已同步更正。", at: "2026-10-12T01:30:00Z" }] } : {}),
    });
  }
  if (url.pathname === "/api/site/feedback") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    submitted = Buffer.concat(chunks).toString();
    feedbackKeys.push(String(req.headers["idempotency-key"]));
    if (feedbackKeys.length === 1 || feedbackKeys.length === 3) {
      res.statusCode = 503;
      return send({ detail: "合成网络未知，重试同一次提交" });
    }
    return send({ id: 12 });
  }
  if (url.pathname === "/api/site/pool")
    return send({
      filters: { channel: "all", category: null, tag: null, q: url.searchParams.get("q"), tab: "time" },
      items: [card],
      page: 1,
      pageCount: 1,
      total: 1,
      todayCount: 1,
      freshness: "2026-10-12T00:00:00Z",
      generatedAt: "2026-10-12T00:00:00Z",
    });
  if (url.pathname.startsWith("/api/site/items/")) return send(detail(url.pathname.split("/").at(-1)!));
  if (url.pathname.includes("/followups")) {
    if (followups === "error") {
      res.statusCode = 503;
      return send({ code: "temporarily_unavailable" });
    }
    return send({
      items:
        followups === "empty"
          ? []
          : [
              {
                factId: "fact-current",
                representative: { id: "different-current-representative", title: "同一事实重复稿", source: { name: source.name }, timelineAt: card.timelineAt },
              },
              {
                factId: "fact-later",
                representative: {
                  id: "later",
                  title: "真实后续标题",
                  summary: "这是后续的一句独立摘要。",
                  source: { name: source.name },
                  timelineAt: card.timelineAt,
                  sourceTime: normalizeSourceTime(
                    {
                      meaning: "published",
                      raw: "2020-01-02",
                      local_date: "2020-01-02",
                      local_time: null,
                      timezone: null,
                      utc: null,
                      precision: "date",
                      basis: "原文日期",
                      condition_text: null,
                    },
                    { instantBasis: null, timezoneEvidence: null },
                  ),
                },
              },
            ],
      more: false,
    });
  }
  if (url.pathname.includes("/groups/"))
    return send({
      factId: "fact-current",
      revision: "r1",
      nextCursor: null,
      reports: [
        {
          id: "other-source",
          title: "其他来源的报道",
          summary: null,
          source,
          timelineAt: card.timelineAt,
          originalUrl: summary.links.original,
          selected: false,
        },
      ],
    });
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
    let out = "";
    const timer = setTimeout(() => reject(new Error(out)), 15000);
    const read = (chunk: Buffer) => {
      out += chunk;
      const match = out.match(/"msg":"web started","port":(\d+)/);
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
      reject(new Error(out));
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

test("detail shows honest body states, first-public evidence, representative/latest and the expanded event link", { timeout: 30000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const blocked = await isolateBrowser(context, [origin]);
  const page = await context.newPage();
  for (const [id, label] of [
    ["pending", "正文正在补齐"],
    ["restricted", "本站仅提供中文导读"],
    ["none", "本站暂无正文"],
    ["unknown", "本站暂无正文"],
  ]) {
    await page.goto(`${origin}/items/${id}`);
    await expect(page.getByRole("region", { name: "正文状态" })).toContainText(label!);
    await expect(page.getByRole("link", { name: "打开来源原文", exact: true })).toHaveAttribute("href", summary.links.original);
    await expect(page.getByText(id === "unknown" ? /本站公开 时间未记录/ : /本站公开.*2026-10-12/)).toBeVisible();
  }
  const coverage = page.getByRole("region", { name: "相关报道" });
  await expect(coverage.getByText("代表稿", { exact: true })).toBeVisible();
  await expect(coverage.getByText("最新进展", { exact: true })).toBeVisible();
  await expect(coverage.getByText("正在阅读", { exact: true })).toBeVisible();
  await expect(coverage.getByText("当事方或官方发布", { exact: true })).toBeVisible();
  await expect(coverage.getByRole("link", { name: "新事实进展" })).toHaveAttribute("href", "/items/later");
  await page.getByRole("button", { name: /另有 1 家信源报道/ }).click();
  await expect(page.getByRole("link", { name: "其他来源的报道" })).toBeVisible();
  const group = page
    .locator("div")
    .filter({ has: page.getByRole("button", { name: /另有 1 家信源报道/ }) })
    .last();
  await expect(group.getByRole("link", { name: "查看完整事件" })).toHaveAttribute("href", `/story/${story.publicId}`);
  assert.deepEqual(blocked, []);
  await context.close();
});

test("followups distinguish errors, retry, empty results and one-sentence summaries", { timeout: 30000 }, async (t) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  let phase = "create";
  t.after(async () => {
    t.diagnostic(`last followups phase: ${phase}`);
    followups = "ready";
    await context.close();
  });
  await isolateBrowser(context, [origin]);
  const page = await context.newPage();
  const openReadyItem = async (reload = false) => {
    const versionUrl = `${origin}/api/site/content-version`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holdVersion = async (route: Route) => {
      await gate;
      await route.continue();
    };
    await page.route(versionUrl, holdVersion, { times: 1 });
    const version = page.waitForResponse((response) => response.url() === versionUrl);
    const data = page.waitForResponse((response) => new URL(response.url()).pathname === "/items/none.data");
    void version.catch(() => {});
    void data.catch(() => {});
    try {
      phase = reload ? "reload" : "initial navigation";
      if (reload) await page.reload();
      else await page.goto(`${origin}/items/none`);
      await page.bringToFront();
      await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("visible");
      phase = "initial checking";
      await expect(page.getByRole("region", { name: "阅读内容", exact: true })).toHaveAttribute("aria-busy", "true");
      release();
      phase = "version response";
      const baseline = await version;
      assert.equal(baseline.status(), 200);
      assert.deepEqual(await baseline.json(), { version: "1", withdrawalVersion: "1" });
      phase = "data response";
      assert.equal((await data).status(), 200);
      // Stream EOF is not the route commit; the guard clears checking after revalidate() resolves.
      phase = "DOM qualified";
      await expect(page.getByRole("region", { name: "阅读内容", exact: true })).toHaveAttribute("aria-busy", "false");
      await expect(page.getByRole("status").filter({ hasText: "暂时无法确认最新内容" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "加载最新", exact: true })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "矿业历史报道", exact: true })).toBeVisible();
    } finally {
      release();
      await page.unroute(versionUrl, holdVersion);
    }
  };
  followups = "error";
  await openReadyItem();
  phase = "followup error";
  await page.getByRole("heading", { name: "事件后续", exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByText("事件进展暂时无法读取。", { exact: false })).toBeVisible();
  await expect(page.getByText("暂无更多相关进展。", { exact: true })).toHaveCount(0);
  followups = "ready";
  phase = "retry followups";
  await page.getByRole("button", { name: "重试进展" }).click();
  await expect(page.getByRole("link", { name: "真实后续标题" })).toBeVisible();
  await expect(page.getByText("这是后续的一句独立摘要。", { exact: true })).toBeVisible();
  const sourceDate = page.getByRole("link", { name: "真实后续标题" }).locator("..").locator("time");
  await expect(sourceDate).toHaveAttribute("datetime", "2020-01-02");
  await expect(sourceDate).not.toContainText("00:00");
  await expect(page.getByRole("link", { name: "同一事实重复稿" })).toHaveCount(0);
  followups = "empty";
  await openReadyItem(true);
  phase = "followup empty";
  await page.getByRole("heading", { name: "事件后续", exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByText("暂无更多相关进展。", { exact: true })).toBeVisible();
  phase = "complete";
});

test("SPA feedback carries the current filtered page and item correction URL without submitting stale referrers", { timeout: 30000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await isolateBrowser(context, [origin]);
  const page = await context.newPage();
  const path = "/all?q=%E9%93%9C&source=mine";
  await page.goto(origin + path);
  await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "反馈", exact: true }).click();
  await expect(page.getByLabel("关联页面")).toHaveCount(0);
  const content = page.getByLabel("想说点什么？");
  const send = page.getByRole("button", { name: "发送反馈", exact: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [value, remaining] of [
      ["", 2],
      ["   ", 2],
      ["  一  ", 1],
      ["一二", 0],
      ["🙂", 0],
    ] as const) {
      await content.fill(value);
      await expect(content).toHaveAccessibleDescription(`至少填写2字${remaining ? `，还差 ${remaining} 字可发送` : ""}`);
      await expect(page.locator("#fb-content-hint")).toBeVisible();
      if (remaining) await expect(send).toBeDisabled();
      else await expect(send).toBeEnabled();
    }
  }
  await page.getByLabel("想说点什么？").fill("这是本地合成反馈，不发送到外部。");
  await page.getByRole("button", { name: /提交|发送/ }).click();
  await expect(page.getByText("合成网络未知，重试同一次提交", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("想说点什么？")).toHaveValue("这是本地合成反馈，不发送到外部。");
  await page.getByRole("button", { name: /提交|发送/ }).click();
  await expect(page.getByRole("heading", { name: "收到了，谢谢你" })).toBeVisible();
  assert.match(feedbackKeys[0]!, /^[0-9a-f-]{36}$/);
  assert.equal(feedbackKeys[0], feedbackKeys[1], "unknown-response retry keeps the same idempotency key");
  assert.ok(submitted.includes(origin + path));
  await page.goto(`${origin}/items/none?view=detail`);
  await page.getByRole("link", { name: "内容有误？告诉我们" }).click();
  await expect(page.getByLabel("关联页面")).toHaveCount(0);
  await page.getByLabel("想说点什么？").fill("另一条本地合成反馈，验证修改后新提交。");
  await page.getByRole("button", { name: /提交|发送/ }).click();
  await expect(page.getByText("合成网络未知，重试同一次提交", { exact: true })).toBeVisible();
  await page.getByLabel("想说点什么？").fill("另一条本地合成反馈，内容已经作了修改。");
  await page.getByRole("button", { name: /提交|发送/ }).click();
  await expect(page.getByRole("heading", { name: "收到了，谢谢你" })).toBeVisible();
  assert.notEqual(feedbackKeys[2], feedbackKeys[3], "an edited payload starts a new submission identity");
  assert.ok(submitted.includes(origin + "/items/none?view=detail"), "the hidden origin still reaches the inbox");
  await context.close();
});

test("feedback transport failure never claims an unsaved local draft is safe", { timeout: 30000 }, async () => {
  const context = await browser.newContext();
  await isolateBrowser(context, [origin]);
  await context.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Synthetic storage refusal", "QuotaExceededError");
    };
  });
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/feedback`);
    await page.route("**/api/site/feedback", (route) => route.abort("failed"));
    await page.getByLabel("想说点什么？").fill("合成草稿：存储拒绝后仍保留当前输入。");
    await page.getByRole("button", { name: "发送反馈", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("请保留当前内容");
    await expect(page.getByRole("alert")).not.toContainText("已保存");
    await expect(page.getByLabel("想说点什么？")).toHaveValue("合成草稿：存储拒绝后仍保留当前输入。");
  } finally {
    await context.close();
  }
});

test("daily, weekly and monthly report pages show public correction notes, without inventing absent history", { timeout: 30000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "America/Argentina/Catamarca" });
  await isolateBrowser(context, [origin]);
  const page = await context.newPage();
  for (const path of ["/daily/2026-10-12", "/weekly/2026-W41", "/monthly/2026-10"]) {
    await page.goto(origin + path);
    const notes = page.getByRole("region", { name: "更正说明" });
    await expect(notes).toContainText("修订版本 2");
    await expect(notes).toContainText("2026-10-12 09:30");
    await expect(notes).toContainText("部分引用已更新，报告已同步更正。");
    await expect(notes.locator("time")).toHaveAttribute("datetime", "2026-10-12T01:30:00Z");
  }
  showCorrections = false;
  await page.reload();
  await expect(page.getByRole("region", { name: "更正说明" })).toHaveCount(0);
  await context.close();
  showCorrections = true;
});

test("the public web entry proxies the v3 specification and its guide links to working v3 examples", async () => {
  const spec = await fetch(`${origin}/openapi-v3.json`);
  assert.equal(spec.status, 200);
  assert.deepEqual(await spec.json(), { openapi: "3.1.0", info: { title: "Fixture v3" }, paths: { "/api/v3/items": {} } });
  const guide = await fetch(`${origin}/agent?tab=api`);
  assert.equal(guide.status, 200);
  const html = await guide.text();
  assert.match(html, /href="\/openapi-v3\.json"/);
  assert.match(html, /\/api\/v3\/items\?view=featured/);
  assert.doesNotMatch(html, /\/api\/v1\/items/);
});
