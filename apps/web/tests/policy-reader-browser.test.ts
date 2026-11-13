// The policy pages as a reader meets them, against the 2026-11-07 audit (desktop 1440, phone 390, Chinese and /en):
// a jurisdiction whose documents have no theme yet is not a dead end, empty places are one line, list cards print no
// placeholders or doubled labels and show a split decree once, the detail prints its title once, hides what it does
// not know and keeps the official original in view on a phone, and /en keeps English chrome and /en addresses.
// Production web, synthetic read-only API; no external network, database or model.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { Policy, PolicyCard, PolicyReport, PolicyReportList, PolicyScopeList } from "@amp/contracts/http/public";
import { normalizeSourceTime } from "@amp/contracts/time-assertion";
import { browserExecutable, isolateBrowser } from "./browser.ts";
import { webEnvironment } from "../runtime-env.ts";

let origin = "",
  web: ChildProcess,
  browser: Browser;
const fixture = (name: string) => JSON.parse(readFileSync(`tests/fixtures/policy-public/${name}.json`, "utf8"));
/** Chinese characters and the full-width brackets, colon and enumeration comma. */
const CJK = /[㐀-鿿（）：、]/;

const sourceDate = (date: string, clock: string | null) =>
  normalizeSourceTime(
    {
      meaning: "published",
      raw: clock ? `${date} ${clock}` : date,
      local_date: date,
      local_time: clock ? `${clock}:00` : null,
      timezone: clock ? "Asia/Shanghai" : null,
      utc: clock ? new Date(`${date}T${clock}:00+08:00`).toISOString() : null,
      precision: clock ? "second" : "date",
      basis: "合成来源日期",
      condition_text: null,
    },
    { instantBasis: clock ? "explicit" : null, timezoneEvidence: clock ? "合成时区依据" : null },
  );
const systemTime = (meaning: "site_public" | "checked", at: string) =>
  normalizeSourceTime(
    {
      meaning,
      raw: at,
      local_date: at.slice(0, 10),
      local_time: at.slice(11, -1),
      utc: at,
      timezone: "UTC",
      precision: "second",
      basis: "合成系统时间",
      condition_text: null,
    },
    { instantBasis: "explicit", timezoneEvidence: "系统UTC时钟" },
  );

const basic = Policy.parse(fixture("basic-facts"));
/** A basic-facts document as the projection writes it: no Chinese title for a foreign decree, unknown nature and stage. */
function policyDocument(input: {
  id: string;
  code: "CN" | "AR";
  title: string;
  original: string;
  number: string | null;
  authority: string;
  language: string;
  published: ReturnType<typeof sourceDate>;
}) {
  const version = `${input.id}-version`,
    expression = `${input.id}-expression`;
  return Policy.parse({
    ...basic,
    id: input.id,
    title: input.title,
    original_title: input.original,
    instrument_number: input.number,
    jurisdictions: [{ code: input.code, label: input.code === "CN" ? "中国" : "阿根廷", kind: "country" }],
    authority: { id: `${input.id}-authority`, name: input.authority },
    attributions: [{ name: input.authority, url: `https://official.invalid/${input.id}` }],
    original_url: `https://official.invalid/${input.id}`,
    published_time: input.published,
    sort_time: input.published,
    sort_kind: "published",
    first_public_at: systemTime("site_public", "2026-10-20T02:00:00.000Z"),
    source_checked_at: systemTime("checked", "2026-10-20T02:00:00.000Z"),
    summary: null,
    gaps: ["官方原文可能还有附件，本站尚未全部列出，请以官方原文为准。"],
    attachment_inventory: [],
    versions: [{ id: version, version_label: "本站存档第 4 版", expression_ids: [expression], current: true, legal_brief: basic.legal_brief }],
    expressions: [
      {
        id: expression,
        policy_version_id: version,
        document_revision_id: `${input.id}-revision`,
        language: input.language,
        kind: "original",
        issuing_body: input.authority,
        instrument_number: input.number,
        checked_at: systemTime("checked", "2026-10-20T02:00:00.000Z"),
        reading_state: "unavailable",
      },
    ],
    selected_policy_version_id: version,
    selected_expression_id: expression,
    ai_metadata: { ...basic.ai_metadata, content_id: input.id },
  });
}
const documents = [
  policyDocument({
    id: "pol-cn-dateonly",
    code: "CN",
    title: "【合成】云南省全域消防安全监管实施办法",
    original: "【合成】云南省全域消防安全监管实施办法",
    number: null,
    authority: "合成省人民政府",
    language: "zh-CN",
    published: sourceDate("2026-10-15", null),
  }),
  policyDocument({
    id: "pol-cn-clock",
    code: "CN",
    title: "【合成】矿山安全生产条例",
    original: "【合成】矿山安全生产条例",
    number: "合成令第1号",
    authority: "合成国务院",
    language: "zh-CN",
    published: sourceDate("2026-10-14", "21:00"),
  }),
  ...[1, 2, 3].map((n) =>
    policyDocument({
      id: `pol-ar-part-${n}`,
      code: "AR",
      title: "文书 DECRETO N° 719/26",
      original: `DECRETO N° 719/26 - P${n}/3`,
      number: "DECRETO N° 719/26",
      authority: "合成萨尔塔省公报",
      language: "es",
      published: sourceDate("2026-10-15", null),
    }),
  ),
];
/** TASK-0576: an Argentine law whose procedure the program read from the gazette text (not in the list; opened directly). */
const ruleDate = (meaning: "event" | "signed" | "published" | "effective", date: string, basis: string) =>
  normalizeSourceTime(
    { meaning, raw: date, local_date: date, local_time: null, timezone: null, utc: null, precision: "date", basis, condition_text: null },
    { instantBasis: null, timezoneEvidence: null },
  );
const arLawBase = policyDocument({
  id: "pol-ar-law",
  code: "AR",
  title: "Ley 27.801 RÉGIMEN DE INVERSIONES MINERAS",
  original: "Ley 27.801 RÉGIMEN DE INVERSIONES MINERAS",
  number: "27.801",
  authority: "合成阿根廷国家公报",
  language: "es",
  published: sourceDate("2026-11-04", null),
});
const lawBrief = { stage: "published", in_force: "unknown", repeal: "unknown" } as const;
const arLaw = Policy.parse({
  ...arLawBase,
  nature: { code: "law", label: "法律" },
  legal_brief: lawBrief,
  versions: arLawBase.versions.map((v) => ({ ...v, legal_brief: lawBrief })),
  legal_state: {
    ...arLawBase.legal_state,
    nature: { value: "law", basis: "程序从公报原文抽取：Ley（法律）", evidence_ids: [] },
    legislative_stage: { value: "published", basis: "程序从公报原文抽取：官方来源已正式公布的Ley（法律）", evidence_ids: [] },
    publication: { value: "published", basis: "程序从公报原文抽取：官方来源公布", evidence_ids: [], time: sourceDate("2026-11-04", null) },
  },
  dates: [
    { ...sourceDate("2026-11-04", null), event_kind: "original_publication", occurrence: "occurred" },
    { ...ruleDate("event", "2026-10-28", "程序从公报原文抽取：立法机关通过（Sancionada）"), event_kind: "adoption", occurrence: "occurred" },
    { ...ruleDate("signed", "2026-11-03", "程序从公报原文抽取：行政颁布（Promulgada）"), event_kind: "promulgation", occurrence: "occurred" },
    {
      ...ruleDate("effective", "2026-11-13", "原文未写明施行日；按阿根廷《民商法典》第5条一般规则推算（公布后第八日届满，次日起施行），不是原文所写"),
      event_kind: "entry_into_force",
      occurrence: "planned",
    },
  ],
});
const card = (policy: Policy) => PolicyCard.parse(Object.fromEntries(Object.keys(PolicyCard.shape).map((key) => [key, policy[key as keyof Policy]])));
const counts: Record<string, number> = { CN: 2, AR: 3 };
const scope = PolicyScopeList.parse({
  ...fixture("scope"),
  updates: "paused",
  items: fixture("scope").items.map((item: { jurisdiction: { code: string } }) => ({ ...item, readable_count: counts[item.jurisdiction.code] ?? 0 })),
});
const report = PolicyReport.parse({
  ...fixture("report"),
  edition: 3,
  correction_of: "earlier",
  change: { added: 4, removed: 0, reason: "public_versions_or_coverage_changed" },
});

const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://fixture");
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  const answer = (value: unknown) => res.end(JSON.stringify(value));
  if (url.pathname === "/api/site/meta") return answer({ changelogVersion: null });
  if (url.pathname === "/api/site/content-version") return answer({ version: "policy-reader", withdrawalVersion: "policy-reader" });
  if (url.pathname === "/api/site/jurisdictions") return answer([]);
  if (url.pathname === "/api/site/policies/scope") return answer(scope);
  if (url.pathname === "/api/site/policies") {
    // Like the API, a theme matches on every current language version of a document, not only the card shown.
    const otherLanguageThemes: Record<string, string[]> = { "pol-cn-dateonly": ["safety_environment"] };
    const q = url.searchParams,
      size = Number(q.get("page_size") ?? 20),
      page = Number(q.get("page") ?? 1);
    const items = documents
      .map(card)
      .filter(
        (c) =>
          (!q.get("jurisdiction") || c.jurisdictions.some((j) => j.code === q.get("jurisdiction"))) &&
          (!q.get("theme") || c.themes.some((t) => t.code === q.get("theme")) || !!otherLanguageThemes[c.id]?.includes(q.get("theme")!)),
      );
    return answer({ ...fixture("list"), items: items.slice((page - 1) * size, page * size), page, page_size: size, total: items.length });
  }
  if (url.pathname === "/api/site/policies/reports") return answer(PolicyReportList.parse(fixture("report-list")));
  if (url.pathname === `/api/site/policies/reports/${report.id}`) return answer(report);
  const detail = [...documents, arLaw].find((d) => url.pathname === `/api/site/policies/${d.id}`);
  if (detail) return answer(detail);
  res.statusCode = 404;
  answer({ code: "not_found" });
});

before(async () => {
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  web = spawn(process.execPath, ["apps/web/server.ts"], {
    env: webEnvironment({
      PATH: process.env.PATH,
      NODE_ENV: "production",
      AMP_RELEASE: "fixture-policy-reader",
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
    let output = "";
    const timer = setTimeout(() => reject(new Error(output)), 15000);
    const read = (chunk: Buffer) => {
      output += chunk;
      const match = output.match(/"msg":"web started","port":(\d+)/);
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
      reject(new Error(output));
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

async function open(width: number) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
  const blocked = await isolateBrowser(context, [origin]);
  const page = await context.newPage(),
    errors: string[] = [];
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => errors.push(error.message));
  return { context, page, errors, blocked };
}
const visibleText = (page: Page) => page.locator("main").innerText();
const noOverflow = async (page: Page) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no sideways scroll");

// The contract gained these kinds first (#413) and the page then fell back to the date's own label; with their labels
// shipped (TASK-0576) each kind reads as its own step, in Chinese and English, never as the fallback.
test("new policy date kinds show their own labels in Chinese and English", { timeout: 60000 }, async () => {
  const document = documents[0]!,
    dates = document.dates,
    kinds = ["adoption", "promulgation", "entry_into_force", "repeal"] as const,
    labels = {
      adoption: ["立法机关通过", "Passed by the legislature"],
      promulgation: ["行政颁布", "Promulgated"],
      entry_into_force: ["施行日期", "Entry into force"],
      repeal: ["已废止", "Repealed"],
    } as const;
  const { context, page, errors, blocked } = await open(390);
  try {
    document.dates = Policy.shape.dates.parse(
      kinds.map((event_kind, i) => ({
        ...sourceDate(`2026-10-${10 + i}`, null),
        event_kind,
        occurrence: "occurred",
      })),
    );
    for (const prefix of ["", "/en"]) {
      await page.goto(`${origin}${prefix}/policies/${document.id}`);
      const rows = page.locator("#legal li");
      await expect(rows).toHaveCount(kinds.length);
      for (const [i, kind] of kinds.entries()) await expect(rows.filter({ hasText: `2026-10-${10 + i}` })).toContainText(labels[kind][prefix ? 1 : 0]);
      for (const row of await rows.all()) await expect(row).not.toContainText(prefix ? "Source published" : "来源发布");
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(blocked, []);
  } finally {
    document.dates = dates;
    await context.close();
  }
});

for (const width of [1440, 390])
  test(`the policy list leads somewhere at every level and prints no placeholders (${width}px)`, { timeout: 60000 }, async () => {
    const { context, page, errors, blocked } = await open(width);
    try {
      await page.goto(`${origin}/policies`);
      // One quiet line for the pause switch, and the count caption said once.
      await expect(page.locator("[data-policy-updates]")).toHaveAttribute("data-policy-updates", "paused");
      await expect(page.locator("[data-policy-updates]")).toContainText("暂停更新");
      const main = await visibleText(page);
      assert.ok(!main.includes("登记范围不代表已完成供稿"), "the scope note is not stacked under the caption");
      assert.equal(main.split("篇数").length + main.split("份数").length - 2, 1, "one caption about the counts");
      // Places with documents first as cards; the 34 without any are one line of links, so the phone page stays short.
      await expect(page.locator("[data-jurisdiction-card]")).toHaveCount(2);
      await expect(page.locator('[data-empty-list="jurisdictions"] a[data-empty-item]')).toHaveCount(scope.items.length - 2);
      assert.ok(!main.includes("暂无已公开文书\n"), "no tile per empty place");
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      assert.ok(height < (width === 390 ? 2600 : 1800), `the page is ${height}px tall`);
      await noOverflow(page);
      // A list card: no doubled labels, no placeholders, no “basic facts” tag, the date alone for a date-only source.
      const cards = page.locator("[data-policy-card]");
      const cardText = await cards.allInnerTexts();
      for (const text of cardText) {
        assert.ok(!/来源发布日期：|来源发布于|本站公开：|本站公开于|尚未确认|基本事实|未知/.test(text), text);
        assert.ok(!/文书 DECRETO/.test(text), "the projection's “文书 <number>” placeholder is not a title");
      }
      const dateOnly = page.locator('[data-policy-card="pol-cn-dateonly"]');
      await expect(dateOnly).toContainText("来源发布 2026-10-15");
      await expect(dateOnly).not.toContainText(":00");
      // The three parts of one decree are one entry: the title once and a link to each part.
      await expect(page.locator('[data-policy-card^="pol-ar-part"]')).toHaveCount(1);
      const decree = page.locator('[data-policy-card="pol-ar-part-1"]');
      await expect(decree.getByRole("heading")).toHaveText("DECRETO N° 719/26");
      await expect(decree).toContainText("本文书分 3 部分公布：");
      await expect(decree.getByRole("link", { name: /^第 \d 部分$/ })).toHaveCount(3);
      // An empty place still opens and says so honestly.
      await page.locator('a[data-empty-item="US"]').click();
      await expect(page).toHaveURL(/jurisdiction=US$/);
      await expect(page.getByText("美国暂无已公开文书", { exact: true })).toBeVisible();
      await expect(page.locator("[data-theme-card]")).toHaveCount(0);
      // China: two public documents. One has a theme only in another language version, which the API matches (Codex
      // review #352): it counts under that theme and is not listed as without a theme; the other has none yet.
      await page.goto(`${origin}/policies?jurisdiction=CN`);
      await expect(page.locator('[data-theme-card="all"]')).toContainText("2 份");
      await expect(page.locator('[data-theme-card="safety_environment"]')).toContainText("1 份");
      await expect(page.locator('a[data-theme-card="none"]')).toContainText("1 份");
      await expect(page.locator('[data-empty-list="themes"] [data-empty-item]')).toHaveCount(6);
      assert.ok(!(await visibleText(page)).includes("暂无已公开文书"), "no dead theme tiles");
      await noOverflow(page);
      await page.locator('a[data-theme-card="none"]').click();
      await expect(page).toHaveURL(/jurisdiction=CN&theme=none/);
      await expect(page.locator("[data-policy-card]")).toHaveCount(1);
      await expect(page.getByText("共 1 份文书", { exact: false })).toBeVisible();
      assert.deepEqual(errors, []);
      assert.deepEqual(blocked, []);
    } finally {
      await context.close();
    }
  });

for (const width of [1440, 390])
  test(`a basics-only detail shows its title once, hides what it does not know and keeps the original in view (${width}px)`, { timeout: 60000 }, async () => {
    const { context, page, errors, blocked } = await open(width);
    try {
      await page.goto(`${origin}/policies/pol-ar-part-2`);
      await expect(page.getByRole("heading", { level: 1 })).toContainText("DECRETO N° 719/26");
      await expect(page.getByRole("heading", { level: 1 })).toContainText("第 2/3 部分");
      const main = await visibleText(page);
      assert.equal(main.split("DECRETO N° 719/26").length - 1, 1, "the title is printed once");
      for (const internal of [
        "尚未确认",
        "未知",
        "本站取得修订",
        "法定版本标签未核实",
        "本站存档第",
        "附件清单尚未完整",
        "原文 es",
        "所处阶段",
        "原文中尚未确认具体安排",
      ])
        assert.ok(!main.includes(internal), `no “${internal}” on the page`);
      await expect(page.getByText("官方原文可能还有附件，本站尚未全部列出，请以官方原文为准。", { exact: true })).toBeVisible();
      await expect(page.locator("#legal")).toHaveCount(0);
      await expect(page.locator("#evidence")).toHaveCount(0);
      // The official original is the main action: in view, inside the viewport, on a phone as well.
      const primary = page.locator("[data-policy-primary]");
      await expect(primary).toBeVisible();
      const box = (await primary.boundingBox())!;
      assert.ok(box.x >= 0 && box.x + box.width <= width + 1, `the original link sits inside the ${width}px viewport (${box.x}+${box.width})`);
      await noOverflow(page);
      // A stated clock is shown in Beijing time; a date-only source as its date.
      await page.goto(`${origin}/policies/pol-cn-clock`);
      await expect(page.locator("#facts")).toContainText("2026-10-14 21:00（北京时间）");
      await page.goto(`${origin}/policies/pol-cn-dateonly`);
      await expect(page.locator("#facts")).toContainText("2026-10-15");
      await expect(page.locator("#facts")).not.toContainText(/2026-10-15 \d/);
      assert.deepEqual(errors, []);
      assert.deepEqual(blocked, []);
    } finally {
      await context.close();
    }
  });

/** Internal links and form actions that would take a reader of the English interface to a Chinese page. */
async function chineseAddresses(page: Page): Promise<string[]> {
  const found = await page.evaluate(() => [
    ...[...document.querySelectorAll("a[href]")].map((a) => ({ to: a.getAttribute("href")!, switch: a.getAttribute("hreflang") === "zh-CN" })),
    ...[...document.querySelectorAll("form[action]")].map((form) => ({ to: form.getAttribute("action")!, switch: false })),
  ]);
  const shared = /^\/(?:api|feed|admin|rss|og|media|v1|v3|mcp)(?:[/?#.]|$)|\.(?:xml|json|png|svg|ico|txt)(?:[?#]|$)/;
  return found
    .filter((a) => a.to.startsWith("/") && !a.to.startsWith("//") && !a.switch && !shared.test(a.to) && !/^\/en(?:[/?#]|$)/.test(a.to))
    .map((a) => a.to);
}
/** Chinese in the interface around the content: every piece of synthetic content contains “合成”. */
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
    .filter((text) => CJK.test(["AI矿策", "切换到中文", "中文", "(宋体)"].reduce((rest, name) => rest.replaceAll(name, ""), text)));
}

for (const width of [390, 1440])
  test(`the policy pages in English keep English chrome and English addresses (${width}px)`, { timeout: 90000 }, async () => {
    const { context, page, errors, blocked } = await open(width);
    try {
      for (const path of [
        "/en/policies",
        "/en/policies?jurisdiction=CN",
        "/en/policies?jurisdiction=CN&theme=none",
        "/en/policies?jurisdiction=US",
        "/en/policies/pol-ar-part-1",
        "/en/policies/pol-cn-clock",
        "/en/policies/reports?kind=weekly",
        `/en/policies/reports/${report.id}`,
      ]) {
        await page.goto(`${origin}${path}`);
        await expect(page.locator("html")).toHaveAttribute("lang", "en");
        assert.deepEqual(await chineseChrome(page), [], `${path}: no Chinese in the interface`);
        assert.deepEqual(await chineseAddresses(page), [], `${path}: every link stays under /en`);
      }
      await page.goto(`${origin}/en/policies`);
      await expect(page.locator('a[data-jurisdiction-card="CN"]')).toContainText("China");
      await expect(page.locator('a[data-empty-item="CD"]')).toHaveText("DR Congo");
      await page.locator('a[data-jurisdiction-card="CN"]').click();
      await expect(page).toHaveURL(/\/en\/policies\?jurisdiction=CN$/);
      await page.locator('a[data-theme-card="none"]').click();
      await expect(page).toHaveURL(/\/en\/policies\?jurisdiction=CN&theme=none$/);
      await page.locator('[data-policy-card="pol-cn-clock"] h2 a').click();
      await expect(page).toHaveURL(/\/en\/policies\/pol-cn-clock$/);
      await expect(page.locator("#facts")).toContainText("2026-10-14 21:00 (Beijing time)");
      // The back link returns to the English list the reader came from.
      await page.locator("[data-policy-tools]").locator("xpath=..").getByRole("link").first().click();
      await expect(page).toHaveURL(/\/en\/policies\?jurisdiction=CN&theme=none$/);
      assert.deepEqual(errors, []);
      assert.deepEqual(blocked, []);
    } finally {
      await context.close();
    }
  });

test("a policy report in English shows no revision churn", { timeout: 30000 }, async () => {
  const { context, page, errors } = await open(390);
  try {
    await page.goto(`${origin}/en/policies/reports/${report.id}`);
    const main = await visibleText(page);
    assert.ok(!/revision|edition 3|Edition/i.test(main), "no revision numbers or links");
    await expect(page.locator("[data-report-correction]")).toHaveCount(0);
    await expect(page.locator("[data-report-earlier]")).toHaveCount(0);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("an Argentine law shows its procedure read from the gazette: passed, promulgated, published, in force (computed), in Chinese and English", {
  timeout: 30000,
}, async () => {
  const { context, page, errors, blocked } = await open(390);
  try {
    await page.goto(`${origin}/policies/pol-ar-law`);
    const steps = page.locator('ol[aria-label="文件生命周期"] > li');
    await expect(steps).toHaveCount(4);
    assert.deepEqual(
      (await steps.allInnerTexts()).map((s) => s.replace(/\s+/g, " ").trim()),
      ["国会通过（Sancionada） 2026-10-28", "行政颁布（Promulgada） 2026-11-03", "公报公布 2026-11-04", "施行 2026-11-13（推算）"],
    );
    await expect(steps.nth(2)).toHaveAttribute("aria-current", "step");
    await expect(page.locator("main")).toContainText("施行日原文未写明，按阿根廷《民商法典》第5条推算");
    await noOverflow(page);
    await page.goto(`${origin}/en/policies/pol-ar-law`);
    const english = page.locator('ol[aria-label="Document life cycle"] > li');
    await expect(english).toHaveCount(4);
    const texts = await english.allInnerTexts();
    assert.match(texts[0]!, /Passed by Congress \(Sancionada\)/);
    assert.match(texts[1]!, /Promulgated \(Promulgada\)/);
    assert.match(texts[2]!, /Published in the gazette/);
    assert.match(texts[3]!, /In force[\s\S]*\(computed\)/);
    assert.deepEqual(errors, []);
    assert.deepEqual(blocked, []);
  } finally {
    await context.close();
  }
});
