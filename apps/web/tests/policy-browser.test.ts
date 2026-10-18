// Production router and reader; synthetic qualified projections, no external network, DB or model credentials.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { chromium, expect, type Browser } from "@playwright/test";
import { Policy, PolicyReadingPage, PolicyReport, PolicyReportList, PolicyScopeList } from "@amp/contracts/http/public";
import { browserExecutable, isolateBrowser } from "./browser.ts";
import { webEnvironment } from "../runtime-env.ts";

let readingStatus: "ok" | "temporary" | "changed" | "mismatch" | "partial" = "ok";
let paginateReading = false;
let origin = "",
  web: ChildProcess,
  browser: Browser;
const fixture = (name: string) => JSON.parse(readFileSync(`tests/fixtures/policy-public/${name}.json`, "utf8"));
const complete = Policy.parse(fixture("complete"));
const basic = Policy.parse(fixture("basic-facts"));
basic.attachment_inventory = [
  { title: "annex-missing.pdf", url: "https://official.invalid/annex-missing.pdf", decisive: true, rights: "public", status: "missing" },
];
basic.gaps = ["决定性附件尚未取得：annex-missing.pdf"];
const scope = PolicyScopeList.parse(fixture("scope"));
const report = PolicyReport.parse({
  ...fixture("report"),
  edition: 2,
  correction_of: "previous-revision",
  change: { added: 2, removed: 1, reason: "public_versions_or_coverage_changed" },
});
const zh = '<p><del>旧义务十万元</del>现行义务二十万元，面积 m<sup>2</sup>。</p><ol start="3"><li>采矿义务</li><li>法定例外</li></ol>';
const en = '<p><del>Old duty 10</del>Current duty 20, area m<sup>2</sup>.</p><ol start="3"><li>Mining obligation</li><li>Legal exception</li></ol>';
const legalTable = `<table><caption>法定费用对照</caption><tbody><tr><th colspan="12">费用条款</th></tr><tr><td rowspan="2">采矿许可</td>${Array.from({ length: 11 }, (_, i) => `<td>Fee${i}LongUnbrokenLegalTableValue</td>`).join("")}</tr><tr>${Array.from({ length: 11 }, () => "<td>法定金额</td>").join("")}</tr></tbody></table>`;
const calls: string[] = [];
const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://fixture");
  calls.push(req.url!);
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  const answer = (value: unknown) => res.end(JSON.stringify(value));
  if (url.pathname === "/api/site/meta") return answer({ changelogVersion: null });
  if (url.pathname === "/api/site/content-version") return answer({ version: "policy-fixture", withdrawalVersion: "policy-fixture" });
  if (url.pathname === "/api/site/jurisdictions") return answer([]);
  if (url.pathname === "/api/site/policies/scope") return answer(scope);
  if (url.pathname === "/api/site/policies/reports") return answer(PolicyReportList.parse(fixture("report-list")));
  if (url.pathname === `/api/site/policies/reports/${report.id}`) {
    const edition = Number(url.searchParams.get("edition") ?? 2);
    return answer(PolicyReport.parse({ ...report, edition, correction_of: edition === 1 ? null : "previous-revision", content_version: `report-${edition}` }));
  }
  if (url.pathname === `/api/site/policies/${basic.id}`) return answer(basic);
  if (url.pathname === `/api/site/policies/${complete.id}`) {
    const selected =
      complete.expressions.find((e) => e.id === url.searchParams.get("expression_id")) ??
      complete.expressions.find((e) => e.id === complete.selected_expression_id)!;
    return answer(
      Policy.parse({
        ...complete,
        selected_expression_id: selected.id,
        reading: {
          ...complete.reading!,
          expression_id: selected.id,
          document_revision_id: selected.document_revision_id,
          language: selected.language,
          mode: selected.kind,
          next_cursor: "fixture-first",
          total_blocks: paginateReading ? 2 : 1,
          completed_blocks: paginateReading ? 2 : 1,
        },
      }),
    );
  }
  if (url.pathname === `/api/site/policies/${complete.id}/reading`) {
    if (readingStatus === "temporary" || readingStatus === "changed") {
      res.statusCode = readingStatus === "changed" ? 409 : 503;
      return answer({ code: "synthetic_reading_failure" });
    }
    const expression = complete.expressions.find((e) => e.id === url.searchParams.get("expression_id"))!;
    return answer(
      PolicyReadingPage.parse({
        ...fixture("reading"),
        subject_id: complete.id,
        expression_id: expression.id,
        document_revision_id: readingStatus === "mismatch" ? "wrong-revision" : expression.document_revision_id,
        language: expression.language,
        mode: expression.kind,
        resource_completeness: readingStatus === "partial" ? "partial" : "complete",
        total_blocks: paginateReading ? 2 : 1,
        blocks: [
          {
            block_id: url.searchParams.get("cursor") === "fixture-next" ? "second-source-part" : "same-source-part",
            kind: "paragraph",
            text: "Synthetic legal reading fixture",
            semantic_html:
              url.searchParams.get("cursor") === "fixture-next" ? "<p>第二页合成正文。</p>" : (expression.kind === "ai_translation" ? zh : en) + legalTable,
            table_rows: null,
            evidence_ids: [],
            links: [],
          },
        ],
        next_cursor: paginateReading && url.searchParams.get("cursor") !== "fixture-next" ? "fixture-next" : null,
      }),
    );
  }
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
      AMP_RELEASE: "fixture-policy-release",
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

for (const width of [1440, 390])
  test(`policy comparison, language, gaps and report navigation in ${width}px production browser`, { timeout: 60000 }, async () => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
    const blocked = await isolateBrowser(context, [origin]);
    const page = await context.newPage(),
      errors: string[] = [];
    page.setDefaultTimeout(5000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/policies/${complete.id}`);
    await expect(page.locator('#node-same-source-part [lang="zh-CN"] del')).toHaveText("旧义务十万元");
    await expect(page.locator('#node-same-source-part [lang="zh-CN"] ol')).toHaveAttribute("start", "3");
    const tableRegion = page.getByRole("region", { name: "正文表格（中文）", exact: true });
    await expect(tableRegion).toHaveAttribute("tabindex", "0");
    await expect(tableRegion.locator("td[rowspan]")).toHaveAttribute("rowspan", "2");
    await expect(tableRegion.locator("th[colspan]")).toHaveAttribute("colspan", "12");
    await page.bringToFront();
    await expect.poll(() => tableRegion.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await tableRegion.focus();
    await expect(tableRegion).toBeFocused();
    await tableRegion.press("ArrowRight");
    await expect.poll(() => tableRegion.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));

    await page.getByRole("button", { name: "对照原文", exact: true }).click();
    if (width === 390) await page.getByRole("button", { name: "原文", exact: true }).click();
    await expect(page.locator('#node-same-source-part [lang="en"] del')).toHaveText("Old duty 10");
    await expect(page.locator('#node-same-source-part [lang="en"] del')).toBeVisible();
    await expect(page.getByText("对应原文尚未载入。", { exact: true })).toHaveCount(0);
    if (width === 390) {
      await page.getByRole("button", { name: "中文", exact: true }).click();
      await expect(page.locator('#node-same-source-part [lang="zh-CN"] del')).toBeVisible();
      await expect(page.locator('#node-same-source-part [lang="en"] del')).toBeHidden();
    }
    await page.getByRole("navigation", { name: "阅读语言" }).getByRole("link", { name: "原文 en", exact: true }).click();
    await expect(page).toHaveURL(/expression_id=expression-en/);
    await expect(page.locator('#node-same-source-part [lang="en"] del')).toBeVisible();
    await page.goto(`${origin}/policies/${basic.id}`);
    await expect(page.getByText("决定性附件尚未取得，完整解读不可用", { exact: true })).toBeVisible();
    await expect(page.getByText("annex-missing.pdf", { exact: false }).first()).toBeVisible();
    await page.goto(`${origin}/policies/reports?kind=weekly`);
    await page.getByLabel("国家与组织", { exact: true }).selectOption("CN");
    await page.getByLabel("经营主题", { exact: true }).selectOption("mineral_rights");
    await page.getByRole("button", { name: "筛选", exact: true }).click();
    await expect(page).toHaveURL(/jurisdiction=CN/);
    await expect(page).toHaveURL(/theme=mineral_rights/);
    await page.getByRole("link", { name: report.title, exact: true }).click();
    await expect(page).toHaveURL(/jurisdiction=CN/);
    await page.getByRole("link", { name: "核对上一修订版", exact: true }).click();
    await expect(page).toHaveURL(/edition=1/);
    await expect(page).toHaveURL(/theme=mineral_rights/);
    await page.getByRole("link", { name: "查看最新修订", exact: true }).click();
    await expect(page).not.toHaveURL(/edition=/);
    assert.ok(calls.some((call) => call.includes("edition=1") && call.includes("jurisdiction=CN")));
    assert.deepEqual(errors, []);
    assert.deepEqual(blocked, []);
    await context.close();
  });

test("the first policy page is server-rendered, reused after hydration and paged without repeating the first cursor", { timeout: 30000 }, async () => {
  paginateReading = true;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN", reducedMotion: "reduce" });
  try {
    await isolateBrowser(context, [origin]);
    const before = calls.length;
    const page = await context.newPage();
    const response = await page.goto(`${origin}/policies/${complete.id}`);
    const html = await response!.text();
    assert.ok(html.includes("现行义务二十万元"));
    assert.match(html, /name="amp-release" content="fixture-policy-release"/);
    assert.ok(!html.includes("第二页合成正文"));
    await expect(page.getByRole("button", { name: "继续读取正文", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "继续读取正文", exact: true }).click();
    await expect(page.getByText("第二页合成正文。", { exact: true })).toBeVisible();
    const reads = calls.slice(before).filter((path) => path.includes(`/${complete.id}/reading`));
    assert.equal(reads.filter((path) => path.includes("cursor=fixture-first")).length, 1);
    assert.equal(reads.filter((path) => path.includes("cursor=fixture-next")).length, 1);
    const noScript = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
    try {
      await isolateBrowser(noScript, [origin]);
      const staticPage = await noScript.newPage();
      await staticPage.goto(`${origin}/policies/${complete.id}`);
      await expect(staticPage.locator('#node-same-source-part [lang="zh-CN"] del')).toHaveText("旧义务十万元");
    } finally {
      await noScript.close();
    }
  } finally {
    paginateReading = false;
    await context.close();
  }
});
test("initial policy reading fails closed on revision changes but retains retry for a temporary failure", { timeout: 30000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  try {
    await isolateBrowser(context, [origin]);
    const page = await context.newPage();
    for (const state of ["changed", "mismatch"] as const) {
      readingStatus = state;
      const response = await page.goto(`${origin}/policies/${complete.id}`);
      assert.equal(response!.status(), 409);
      await expect(page.locator("#node-same-source-part")).toHaveCount(0);
      assert.ok(!(await response!.text()).includes("现行义务二十万元"));
    }
    readingStatus = "partial";
    await page.goto(`${origin}/policies/${complete.id}`);
    await expect(page.getByText("当前可读内容已载入，尚不能视为完整正文。", { exact: true })).toBeVisible();
    await expect(page.getByText("正文已全部载入。", { exact: true })).toHaveCount(0);
    readingStatus = "temporary";
    await page.goto(`${origin}/policies/${complete.id}`);
    await expect(page.getByText("正文暂时无法读取，请重试或查看官方原文。", { exact: true })).toBeVisible();
    readingStatus = "ok";
    await page.getByRole("button", { name: "重新读取正文", exact: true }).click();
    await expect(page.locator('#node-same-source-part [lang="zh-CN"] del')).toHaveText("旧义务十万元");
  } finally {
    readingStatus = "ok";
    await context.close();
  }
});
