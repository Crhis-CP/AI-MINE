// The regulation page as a side-by-side review (TASK-0657): the interpretation beside the text, linked. Against the
// production web build and the demo API's synthetic policies (e2e/demo-policy.ts): a section shows only when its
// field has content; a clause number takes the reader to its block and highlights it; narrow space gets two tabs and
// keeps the reading position; revision marks go on and off and are not offered without a comparable version; the
// page makes no verdicts and carries one disclaimer; every state of the text (whole, partial, excerpt, none, no
// translation) has its own honest form; nothing overflows from 320 to 1920 pixels; dark and English work.
// No external network, database or model. POLICY_REVIEW_SHOTS=<dir> also saves one screenshot per viewport.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdirSync } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium, expect, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";
import type { Policy } from "@amp/contracts/http/public";
import { browserExecutable, isolateBrowser } from "./browser.ts";
import { webEnvironment } from "../runtime-env.ts";
import { startDemoReaderApi } from "../../../e2e/demo-api.ts";
import { DEMO_REVIEW_IDS, demoReviewPolicy } from "../../../e2e/demo-policy.ts";
import { articleOf, lifecycleOf, redlineOf, sourceState } from "../../../modules/policy/web/features/review.ts";
import { demoPolicyComparison, demoPolicyReading } from "../../../e2e/demo-reader.ts";

let origin = "",
  web: ChildProcess,
  browser: Browser,
  api: Awaited<ReturnType<typeof startDemoReaderApi>>;
const ROYALTY = "demo-policy-royalty";
const ALL = [ROYALTY, "demo-policy-export", "demo-policy-brine", ...DEMO_REVIEW_IDS];
const BANNED = ["需要行动", "要做的事", "影响程度", "待核"];
const CJK = /[㐀-鿿]/;
const SHOTS = process.env.POLICY_REVIEW_SHOTS;

before(async () => {
  api = await startDemoReaderApi(0);
  web = spawn(process.execPath, ["apps/web/server.ts"], {
    env: webEnvironment({
      PATH: process.env.PATH,
      NODE_ENV: "production",
      AMP_RELEASE: "fixture-policy-review",
      WEB_PORT: "0",
      WEB_HOST: "127.0.0.1",
      PRIVATE_HOST: "private.localhost",
      TRUST_PROXY: "false",
      API_BASE_URL: api.url,
      PRIVATE_API_BASE_URL: api.url,
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
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => {
  await browser?.close();
  if (web && web.exitCode === null) {
    web.kill("SIGTERM");
    await once(web, "exit");
  }
  await api?.close();
});

async function open(width: number, height = 900, options: BrowserContextOptions = {}) {
  const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN", timezoneId: "Asia/Shanghai", reducedMotion: "reduce", ...options });
  const blocked = await isolateBrowser(context, [origin]);
  const page = await context.newPage(),
    errors: string[] = [];
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => errors.push(error.message));
  /** Opens a policy page and waits until its scripts have taken over. */
  const visit = async (address: string) => {
    await page.goto(`${origin}${address}`);
    if (options.javaScriptEnabled !== false) await expect(page.locator(".pr-page")).toHaveAttribute("data-pr-ready", "");
  };
  const done = async () => {
    assert.deepEqual(errors, []);
    // The demo set has no app icons; nothing else may be asked for outside the page's own origin.
    assert.deepEqual(blocked, []);
    await context.close();
  };
  return { page, visit, done };
}
const noOverflow = async (page: Page, where: string) =>
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `no sideways scroll (${where})`);
const sections = (page: Page) => page.locator(".pr-read > section").evaluateAll((all) => all.map((section) => section.id));
const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });

test("what of the text can be shown follows the reading record, and marks land on the right blocks", () => {
  const royalty = demoReviewPolicy(ROYALTY)!;
  assert.deepEqual(sourceState(royalty), { kind: "text", excerpt: false });
  const expression = royalty.expressions[0]!;
  const reading = royalty.reading!;
  const state = (change: Partial<typeof reading>, readingState: typeof expression.reading_state = "complete", others: (typeof expression)[] = []) =>
    sourceState({
      expressions: [{ ...expression, id: reading.expression_id, reading_state: readingState }, ...others],
      selected_expression_id: reading.expression_id,
      reading: { ...reading, ...change },
    }).kind;
  assert.equal(state({ completeness: "excerpt", state: "pending" }, "partial"), "text");
  assert.equal(state({ completeness: "partial", state: "in_progress", completed_blocks: 6 }, "partial"), "text");
  // Nothing made yet, a failed or guide-only reading, an unreadable expression, or no reading at all: no text here.
  assert.equal(state({ completeness: "partial", state: "in_progress", completed_blocks: 0 }, "partial"), "none");
  for (const failed of ["guide_only", "failed_terminal"] as const)
    assert.equal(state({ state: failed, completeness: "unavailable", completed_blocks: 0 }), "none");
  assert.equal(state({ completeness: "unavailable", state: "pending", completed_blocks: 0 }), "none");
  for (const closed of ["restricted", "unavailable"] as const) assert.equal(state({}, closed), "none");
  assert.equal(sourceState({ expressions: [], selected_expression_id: null, reading: null }).kind, "none");
  // Another language of the same document can still be read: the page says so instead of going to one column.
  assert.equal(
    state({ state: "failed_terminal", completeness: "unavailable" }, "unavailable", [{ ...expression, id: "other", reading_state: "complete" }]),
    "elsewhere",
  );

  assert.deepEqual(articleOf("第3条　特许权费"), { label: "第3条", rest: "特许权费" });
  assert.deepEqual(articleOf("第十二条之一 采矿权"), { label: "第十二条之一", rest: "采矿权" });
  assert.equal(articleOf("第3条的规定适用于"), null, "a reference inside a sentence is not an article number");
  assert.deepEqual(articleOf("ARTÍCULO 12 bis.- Definiciones"), { label: "ARTÍCULO 12 bis", rest: "Definiciones" });
  assert.deepEqual(articleOf("Section 5A Fees"), { label: "Section 5A", rest: "Fees" });
  assert.equal(articleOf("（一）价格低于基准价的"), null);

  const original = royalty.expressions.find((e) => e.kind === "original")!;
  const rows = demoPolicyReading(ROYALTY, original.id, original.document_revision_id)!.blocks;
  const redline = redlineOf(demoPolicyComparison(ROYALTY, null, null)!, rows);
  // Article 3 and its three items each carry their own part of the diff; article 9 is new; article 4 was dropped after 3.
  for (const id of ["node-4", "node-5", "node-6", "node-7", "node-9"]) assert.equal(redline.marks.get(id)?.kind, "modified", id);
  assert.deepEqual(redline.marks.get("node-10"), { kind: "added", head: true });
  assert.equal(redline.marks.has("node-2"), false, "an unchanged article has no mark");
  assert.deepEqual([...redline.removed.keys()], ["node-7"]);
  assert.deepEqual([...redline.anchors.values()], ["node-node-4", "pr-gone-2", "node-node-9", "node-node-10"]);
  const seven = redline.marks.get("node-9");
  assert.ok(seven?.kind === "modified" && seven.spans.some((s) => s.op === "delete" && s.text === "un año") && seven.spans.some((s) => s.op === "insert"));
  // Text that is not loaded yet gets no mark, and a dropped provision is not shown out of place.
  const partial = redlineOf(demoPolicyComparison(ROYALTY, null, null)!, rows.slice(0, 2));
  assert.deepEqual([partial.marks.size, partial.removed.size], [0, 0]);

  // A draft's source date is not a promulgation date; a published document's is.
  const stages = (policy: Policy) => Object.fromEntries((lifecycleOf(policy) ?? []).map((s) => [s.key, [s.time?.local_date ?? null, s.now]]));
  assert.deepEqual(stages(royalty), {
    proposed: [null, false],
    consultation: [null, false],
    adopted: [null, false],
    published: ["2026-10-02", true],
    in_force: ["2027-01-01", false],
  });
  const draft = stages(demoReviewPolicy("demo-policy-brine")!);
  assert.deepEqual(
    [draft.consultation, draft.published],
    [
      [null, true],
      [null, false],
    ],
  );
});

test("the page is rendered on the server with both sides, and every clause number is a plain anchor", { timeout: 30000 }, async () => {
  const html = await (await fetch(`${origin}/policies/${ROYALTY}`)).text();
  assert.match(html, /name="amp-release" content="fixture-policy-review"/);
  for (const text of [
    "这份条例把特许权费从单一税率改为按金属价格分档",
    "本条例生效前已取得生产许可的项目",
    'href="#node-node-9"',
    'href="#pr-src"',
    'id="node-node-9"',
  ])
    assert.ok(html.includes(text), text);
  const { page, visit, done } = await open(390, 844, { javaScriptEnabled: false });
  await visit(`/policies/${ROYALTY}`);
  // Without scripts both sides follow each other and the tab bar is two jump links.
  await expect(page.locator(".pr-read")).toBeVisible();
  await expect(page.locator(".pr-src")).toBeVisible();
  await page.locator(".pr-pts .pr-ref").nth(1).click();
  await expect(page).toHaveURL(/#node-node-9$/);
  await expect(page.locator("#node-node-9")).toBeInViewport();
  await noOverflow(page, "no scripts");
  await done();
});

test("a section appears only when its field has content", { timeout: 60000 }, async () => {
  const { page, visit, done } = await open(1360);
  await visit(`/policies/${ROYALTY}`);
  assert.deepEqual(await sections(page), ["summary", "analysis", "who", "legal", "compare", "relations", "gaps", "attachments", "related"]);
  await expect(page.locator(".pr-read > section h2")).toHaveText([
    "概要",
    "规定了什么",
    "涉及谁",
    "时间",
    "与演示征求意见稿相比",
    "与其他法规的关系",
    "尚待明确",
    "附件",
    "相关报道",
  ]);
  await expect(page.locator("#who p").first()).toContainText(
    "从条文看，直接涉及铜、锂开采企业，活动是缴纳特许权费。适用条件：年产量超过条例规定门槛。例外：小规模矿山适用简化程序。",
  );
  await expect(page.locator("#legal dt")).toHaveText(["公布", "施行", "截止"]);
  await expect(page.locator("#legal dd").first()).toHaveText("2026 年 10 月 2 日");
  // The lifecycle band: five stages, the stated one marked, a dash where the record has no date.
  await expect(page.locator(".pr-life li")).toHaveCount(5);
  await expect(page.locator('.pr-life li[aria-current="step"]')).toHaveText("公布当前2026-10-02");
  await expect(page.locator(".pr-life li").first()).toHaveText("拟议—");
  // The three actions, as text links.
  await expect(page.locator("[data-policy-tools] a, [data-policy-tools] button")).toHaveText(["官方原文 ↗", "收藏", "版本记录"]);
  await page.getByRole("button", { name: "收藏法规", exact: true }).click();
  await expect(page.getByRole("button", { name: "已收藏法规", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-policy-tools]").getByRole("link", { name: "版本记录" })).toHaveAttribute("href", `/policies/${ROYALTY}/history`);
  await expect(page.locator("[data-policy-primary]")).toHaveAttribute("href", `https://example.invalid/policies/${ROYALTY}`);

  // Nothing but basic facts and the text: every other section is gone, heading and all.
  await visit("/policies/demo-policy-plain");
  assert.deepEqual(await sections(page), ["summary", "legal"]);
  for (const part of [
    "#analysis",
    "#who",
    "#compare",
    "#relations",
    "#gaps",
    "#attachments",
    "#related",
    "#evidence",
    "[data-pr-redline]",
    "[data-pr-redline-link]",
  ])
    await expect(page.locator(part)).toHaveCount(0);
  assert.ok(
    await page
      .locator(".pr-read > section")
      .evaluateAll((all) => all.every((s) => s.children.length > 1 && s.textContent!.length > s.querySelector("h2")!.textContent!.length)),
  );
  // A Chinese original alone: nothing to switch between.
  await expect(page.getByRole("navigation", { name: "阅读语言" })).toHaveCount(0);
  // A complete interpretation with no earlier version: no comparison section and no revision switch.
  await visit("/policies/demo-policy-export");
  assert.deepEqual(await sections(page), ["summary", "analysis", "who", "legal", "attachments", "related"]);
  await expect(page.locator("[data-pr-redline]")).toHaveCount(0);
  await done();
});

test("a clause number takes the text to its block and highlights it; a number that points nowhere is not a link", { timeout: 60000 }, async () => {
  const { page, visit, done } = await open(1360);
  await visit(`/policies/${ROYALTY}`);
  const seven = page.locator(".pr-pts li").nth(1).locator(".pr-ref");
  await expect(seven).toHaveText("第7条");
  await expect(seven).toHaveAttribute("href", "#node-node-9");
  await seven.click();
  const block = page.locator("#node-node-9");
  await expect(block).toBeInViewport({ ratio: 1 });
  await expect(block).toHaveClass(/pr-hit/);
  await expect(block).toContainText("本条例生效前已取得生产许可的项目");
  // After about two seconds the tint goes and a line in the margin stays.
  await expect(block).toHaveClass(/pr-rel/, { timeout: 4000 });
  await expect(block).not.toHaveClass(/pr-hit/);
  // Article 3 is one head and three items: all four carry the evidence and light up together.
  await page.locator(".pr-pts li").first().locator(".pr-ref").click();
  await expect(page.locator(".pr-art.pr-hit")).toHaveCount(4);
  // Pointing at a block lights the numbers that cite it.
  await page.locator("#node-node-10").hover();
  await expect(page.locator(".pr-pts li").nth(2).locator(".pr-ref")).toHaveClass(/\bon\b/);
  await expect(seven).not.toHaveClass(/\bon\b/);

  // A long text read in pages: a number whose block is not loaded yet is plain text, and a link once it is.
  await visit("/policies/demo-policy-plain");
  await expect(page.locator(".pr-status").first()).toHaveText("正文 · 已载入 20 / 30 段内容");
  await expect(page.locator("#legal .pr-ref-plain")).toHaveText("第22条");
  await expect(page.locator("#legal .pr-ref")).toHaveCount(0);
  await page.locator(".pr-doc").getByRole("button", { name: "继续读取正文", exact: true }).click();
  await expect(page.locator(".pr-doc .pr-art")).toHaveCount(30);
  await expect(page.getByText("正文已全部载入。", { exact: true })).toBeVisible();
  const later = page.locator("#legal .pr-ref");
  await expect(later).toHaveText("第22条");
  await later.click();
  await expect(page.locator(".pr-art.pr-hit")).toContainText("这是附则一章的第 2 条示例条文");
  await expect(page.locator(".pr-art.pr-hit")).toBeInViewport({ ratio: 1 });
  assert.ok((await page.locator(".pr-doc").evaluate((doc) => doc.scrollTop)) > 0, "the text pane scrolled on its own");

  // A translation still being made: what is there can be read and cited; the rest is plain.
  await visit("/policies/demo-policy-partial");
  await expect(page.locator(".pr-status").first()).toHaveText("AI 翻译（非官方译文） · 已载入 6 / 10 段内容");
  await expect(page.locator("#legal .pr-ref")).toHaveText("第2条");
  await expect(page.locator("#legal .pr-ref-plain")).toHaveText("第8条");
  await expect(page.locator("[data-pr-state]")).toHaveText("中文译文还在整理，先显示已完成的部分；完整解读暂不可用。");
  await done();
});

test("on a phone the two sides are tabs: a clause number opens the text at its block, and going back keeps the place", { timeout: 60000 }, async () => {
  const { page, visit, done } = await open(390, 844, { hasTouch: true, isMobile: true });
  await visit(`/policies/${ROYALTY}`);
  await expect(page.getByRole("tab")).toHaveText(["解读", "原文"]);
  await expect(tab(page, "解读")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".pr-read")).toBeVisible();
  await expect(page.locator(".pr-src")).toBeHidden();
  // The lifecycle reads top to bottom.
  const stages = await page.locator(".pr-life li").evaluateAll((all) => all.map((li) => li.getBoundingClientRect().top));
  assert.ok(
    stages.every((top, i) => i === 0 || top > stages[i - 1]!),
    "stages are stacked",
  );
  const number = page.locator("#legal .pr-ref").first();
  await number.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -200));
  const left = await page.evaluate(() => window.scrollY);
  assert.ok(left > 400, "the reader is some way down the interpretation");
  // The area that takes the tap is at least 32px tall, though the type is small.
  assert.ok((await number.evaluate((el) => Number.parseFloat(getComputedStyle(el, "::after").height))) >= 32);
  await number.tap();
  await expect(tab(page, "原文")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".pr-read")).toBeHidden();
  const block = page.locator("#node-node-9");
  await expect(block).toBeInViewport({ ratio: 1 });
  await expect(block).toHaveClass(/pr-hit/);
  // The tab bar stays at the top edge and the block is clear of it.
  const bar = (await page.locator(".pr-ptab").boundingBox())!;
  assert.ok(Math.abs(bar.y) <= 1, `the tab bar is stuck to the top (${bar.y})`);
  assert.ok((await block.boundingBox())!.y >= bar.y + bar.height, "the block is below the tab bar");
  await tab(page, "解读").tap();
  await expect(page.locator(".pr-read")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(left);
  // Switching the language keeps the reader on the text tab.
  await tab(page, "原文").tap();
  await page.getByRole("navigation", { name: "阅读语言" }).getByRole("link", { name: "西班牙语原文", exact: true }).tap();
  await expect(page).toHaveURL(/expression_id=demo-policy-royalty-original/);
  await expect(page.locator(".pr-page")).toHaveAttribute("data-pr-ready", "");
  await expect(tab(page, "原文")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".pr-status").first()).toHaveText("西班牙语原文");
  await expect(page.locator('#node-node-9 [lang="es"]')).toContainText("mantienen la tasa anterior durante dos años");
  await noOverflow(page, "phone");
  await done();
});

test("revision marks go on and off in the text, and are not offered without a comparable version", { timeout: 60000 }, async () => {
  const { page, visit, done } = await open(1360);
  await visit(`/policies/${ROYALTY}`);
  const toggle = page.locator("[data-pr-redline]");
  await expect(toggle).toHaveText("修订痕迹");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".pr-doc del, .pr-doc ins")).toHaveCount(0);
  await expect(page.locator("#compare .pr-chg li")).toHaveCount(4);
  await expect(page.locator("#compare .pr-chg li i")).toHaveText(["修改", "删除", "修改", "新增"]);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  // The comparison was made in Spanish: the original appears under each block and carries the marks.
  await expect(page.getByRole("button", { name: "对照原文", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#node-node-9 del")).toHaveText("删去：un año");
  await expect(page.locator("#node-node-9 ins")).toHaveText("加入：dos años");
  await expect(page.locator("#node-node-9 .pr-flag")).toHaveText("修改");
  await expect(page.locator("#node-node-10 .pr-flag")).toHaveText("新增");
  await expect(page.locator("#node-node-10 .pr-o")).toHaveClass(/pr-added/);
  await expect(page.locator("#node-node-2 del, #node-node-2 ins")).toHaveCount(0);
  // The provision the newer version dropped is shown where it used to be, after article 3 and before chapter III.
  const gone = page.locator("#pr-gone-2");
  await expect(gone).toContainText("原 Artículo 4");
  await expect(gone.locator("del")).toContainText("Los pequeños productores quedan exentos");
  assert.deepEqual(await page.locator(".pr-doc > .pr-art").evaluateAll((all) => all.map((row) => row.id).slice(6, 9)), [
    "node-node-7",
    "pr-gone-2",
    "node-node-8",
  ]);
  await expect(page.locator(".pr-legend")).toContainText("与演示征求意见稿（2026-08-18）比较：");
  await expect(page.locator("[data-pr-redline-link]")).toHaveText("隐藏修订痕迹");
  await toggle.click();
  await expect(page.locator(".pr-doc del, .pr-doc ins, .pr-gone, .pr-legend, .pr-flag")).toHaveCount(0);
  // A change in the list leads to its place in the text with the marks on, the dropped provision included.
  await page.locator("#compare .pr-chg li").nth(1).locator(".pr-ref").click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(gone).toBeInViewport({ ratio: 1 });
  await expect(gone).toHaveClass(/pr-hit/);
  await page.locator("[data-pr-redline-link]").click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  // Reading the Spanish original itself, the marks sit in the one text.
  await visit(`/policies/${ROYALTY}?expression_id=demo-policy-royalty-original`);
  await page.locator("[data-pr-redline]").click();
  await expect(page.locator("#node-node-9 .pr-t del")).toHaveText("删去：un año");
  await expect(page.locator("#node-node-10 .pr-t")).toHaveClass(/pr-added/);
  for (const other of ["demo-policy-export", "demo-policy-plain", "demo-policy-partial"]) {
    await visit(`/policies/${other}`);
    await expect(page.locator("[data-pr-redline], [data-pr-redline-link], #compare")).toHaveCount(0);
  }
  await done();
});

test("each state of the text has its own form: excerpt, none at all, original only", { timeout: 60000 }, async () => {
  const wide = await open(1360);
  let page = wide.page;
  await wide.visit("/policies/demo-policy-excerpt");
  const excerpt = page.locator("[data-pr-excerpt]");
  await expect(excerpt).toContainText("这里显示的是节选，不是全文。");
  await expect(excerpt.getByRole("link", { name: "查看官方原文 ↗" })).toHaveAttribute("href", "https://example.invalid/policies/demo-policy-excerpt");
  await expect(page.locator(".pr-doc .pr-art")).toHaveCount(3);
  await expect(page.getByText("正文已全部载入。")).toHaveCount(0);
  await expect(page.locator("#evidence")).toContainText("Section 2");

  // A scanned original that could not be read: one centred column, one line under the band, no empty pane.
  await wide.visit("/policies/demo-policy-scan");
  await expect(page.locator(".pr-page")).toHaveAttribute("data-pr-source", "none");
  await expect(page.locator(".pr-src, .pr-ptab, [role=tab]")).toHaveCount(0);
  const line = page.locator("[data-pr-nosrc]");
  await expect(line).toContainText("这份文书的全文没有在本站显示。演示数据：原件是扫描件，文字没有识别出来。");
  await expect(line.getByRole("link", { name: "查看官方原文 ↗" })).toHaveAttribute("href", "https://example.invalid/policies/demo-policy-scan");
  const column = (await page.locator(".pr-read").boundingBox())!;
  assert.ok(column.width <= 720, `one reading column (${column.width}px)`);
  assert.ok(Math.abs(column.x - (1360 - column.x - column.width)) <= 2, "the column is centred");
  assert.ok((await line.boundingBox())!.y > (await page.locator(".pr-life").boundingBox())!.y, "the line follows the lifecycle band");
  assert.equal((await page.locator("main").innerText()).split("没有在本站显示").length - 1, 1, "said once");

  // The original can be read and there is no translation yet: nothing offers a Chinese text that does not exist.
  await wide.visit("/policies/demo-policy-original-only");
  await expect(page.getByRole("navigation", { name: "阅读语言" })).toHaveCount(0);
  await expect(page.getByText("中文译文")).toHaveCount(0);
  await expect(page.locator(".pr-status").first()).toHaveText("印度尼西亚语原文");
  await expect(page.locator("[data-pr-state]")).toHaveText("中文正文尚未提供，可先查看官方原文");
  await expect(page.locator("#legal .pr-ref")).toHaveText("Pasal 2");
  await wide.done();

  const phone = await open(390, 844);
  page = phone.page;
  await phone.visit("/policies/demo-policy-scan");
  await expect(page.locator(".pr-src, .pr-ptab, [role=tab]")).toHaveCount(0);
  await expect(page.locator("[data-pr-nosrc]")).toBeVisible();
  await expect(page.locator(".pr-read")).toBeVisible();
  await noOverflow(page, "no text, phone");
  await phone.done();
});

test("the page describes and does not decide: no verdict words anywhere, and exactly one disclaimer", { timeout: 90000 }, async () => {
  const { page, visit, done } = await open(1360);
  for (const id of ALL) {
    for (const prefix of ["", "/en"]) {
      await visit(`${prefix}/policies/${id}`);
      // Both sides, whichever is on screen.
      const text = await page.locator(".pr-page").evaluate((element) => element.textContent ?? "");
      for (const word of [...BANNED, "暂无"]) assert.ok(!text.includes(word), `${prefix}/${id}: no “${word}”`);
      await expect(page.locator("[data-pr-disclaimer]")).toHaveCount(1);
      const disclaimer = prefix ? "it is not legal or business advice" : "不构成法律意见或经营建议";
      assert.equal(text.split(disclaimer).length - 1, 1, `${prefix}/${id}: the disclaimer is said once`);
    }
  }
  await visit(`/policies/${ROYALTY}`);
  await page.locator("[data-pr-redline]").click();
  await expect(page.locator("#node-node-9 del")).toBeVisible();
  const marked = await page.locator(".pr-page").evaluate((element) => element.textContent ?? "");
  assert.equal(marked.split("不构成法律意见").length - 1, 1, "the comparison adds no second disclaimer");
  await expect(page.locator("[data-pr-disclaimer]")).toHaveText(
    "本页是对法规文本的整理，由 AI 辅助生成，可能有疏漏，不构成法律意见或经营建议，请以原文和官方公报为准。演示数据：不是真实法规，也不构成法律建议。",
  );
  await done();
});

const VIEWPORTS: [number, number][] = [
  [320, 568],
  [375, 667],
  [390, 844],
  [430, 932],
  [844, 390],
  [768, 1024],
  [820, 1180],
  [1024, 768],
  [1360, 900],
  [1920, 1080],
];
for (const [width, height] of VIEWPORTS)
  test(`at ${width}×${height} nothing overflows, both sides can be reached and the first clause number works`, { timeout: 60000 }, async () => {
    const { page, visit, done } = await open(width, height);
    await visit(`/policies/${ROYALTY}`);
    await noOverflow(page, "on load");
    const frame = (await page.locator(".pr-page").boundingBox())!;
    assert.ok(frame.width <= 1240, `the page is at most 1240px wide (${frame.width})`);
    const tabs = await page.locator(".pr-ptab").isVisible();
    // The layout follows the space the page has: two columns only when each has about 360px for its text.
    assert.equal(tabs, frame.width < 840, `tabs below 840px of page width (${frame.width})`);
    const number = page.locator(".pr-pts .pr-ref").first();
    const block = page.locator("#node-node-4");
    if (tabs) {
      await expect(page.locator(".pr-read")).toBeVisible();
      await expect(page.locator(".pr-src")).toBeHidden();
      await number.click();
      await expect(page.locator(".pr-src")).toBeVisible();
      await expect(block).toBeInViewport();
      await expect(block).toHaveClass(/pr-hit/);
      const bar = (await page.locator(".pr-ptab").boundingBox())!;
      assert.ok(bar.y >= -1 && bar.y + bar.height <= height, "the tab bar is in view");
      assert.ok((await block.boundingBox())!.y >= bar.y + bar.height - 1, "the block is not under the tab bar");
      await noOverflow(page, "text tab");
      // A document page has no bottom bar of the site over it: the last line of each side scrolls fully into view.
      await expect(page.getByRole("navigation", { name: "底部导航" })).toHaveCount(0);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const end = (await page.locator(".pr-doc .pr-end").boundingBox())!;
      assert.ok(end.y >= 0 && end.y + end.height <= height, "the last line of the text can be read");
      await tab(page, "解读").click();
      await expect(page.locator(".pr-read")).toBeVisible();
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const last = (await page.locator("[data-pr-disclaimer]").boundingBox())!;
      assert.ok(last.y >= 0 && last.y + last.height <= height, "the disclaimer can be read");
    } else {
      await expect(page.locator(".pr-read")).toBeVisible();
      await expect(page.locator(".pr-src")).toBeVisible();
      const [read, text] = [(await page.locator(".pr-read").boundingBox())!, (await page.locator(".pr-src").boundingBox())!];
      assert.ok(read.width >= 400 && text.width >= 400, `each column has room for 360px of text (${read.width}, ${text.width})`);
      assert.ok(text.x >= read.x + read.width - 1, "the text is beside the interpretation");
      await number.click();
      await expect(block).toBeInViewport({ ratio: 1 });
      await expect(block).toHaveClass(/pr-hit/);
      // The longest line of the interpretation stays readable on a very wide screen.
      assert.ok((await page.locator(".pr-lead").boundingBox())!.width <= 620);
    }
    await noOverflow(page, "after the click");
    if (SHOTS) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(SHOTS, `viewport-${width}x${height}.png`) });
    }
    await done();
  });

test("the dark theme has its own lines and highlight", { timeout: 30000 }, async () => {
  for (const width of [1360, 390]) {
    const { page, visit, done } = await open(width, width === 390 ? 844 : 900, { colorScheme: "dark" });
    await visit(`/policies/${ROYALTY}`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(21, 19, 15)");
    await page.locator(".pr-pts .pr-ref").nth(1).click();
    const block = page.locator("#node-node-9");
    await expect(block).toHaveClass(/pr-hit/);
    assert.equal(await block.evaluate((el) => getComputedStyle(el).backgroundColor), "rgba(226, 176, 79, 0.26)");
    assert.equal(await page.locator(".pr-panes").evaluate((el) => getComputedStyle(el).borderTopColor), "rgba(255, 255, 255, 0.14)");
    // Text on the paper keeps its contrast: light ink on the dark ground.
    assert.equal(await page.locator(".pr-top h1").evaluate((el) => getComputedStyle(el).color), "rgb(236, 230, 218)");
    await noOverflow(page, `dark ${width}`);
    await done();
  }
});

test("the English interface names every part in English and keeps the reader under /en", { timeout: 60000 }, async () => {
  for (const width of [1360, 390]) {
    const { page, visit, done } = await open(width, width === 390 ? 844 : 900);
    await visit(`/en/policies/${ROYALTY}`);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator(".pr-read > section h2")).toHaveText([
      "Summary",
      "What it provides",
      "Who",
      "Dates",
      "Compared with 演示征求意见稿",
      "Relation to other regulations",
      "Not yet settled",
      "Attachments",
      "Related coverage",
    ]);
    await expect(page.getByRole("tab")).toHaveText(width === 390 ? ["Interpretation", "Original"] : []);
    await expect(page.locator(".pr-life b")).toHaveText(["Proposed", "Consultation", "Adopted", "PublishedNow", "In force"]);
    await expect(page.locator("[data-policy-tools] a, [data-policy-tools] button")).toHaveText(["Official original ↗", "Save", "Version history"]);
    await expect(page.locator("[data-pr-disclaimer]")).toContainText("This page sets out what the regulation's text says.");
    if (width === 390) await tab(page, "Original").click();
    await expect(page.locator(".pr-sbar")).toHaveText("OriginalOriginal (Spanish)Chinese translationSide by sideRevision marks");
    await expect(page.locator(".pr-status").first()).toHaveText("AI translation (not an official translation)");
    await page.locator("[data-pr-redline]").click();
    await expect(page.locator("#node-node-9 .pr-flag")).toHaveText("Amended");
    await expect(page.locator(".pr-legend")).toContainText("Compared with 演示征求意见稿 (2026-08-18): ");
    // The interface around the content is English: labels, margin flags, tools; the content itself stays as written.
    const chrome = await page
      .locator(".pr-crumb, .pr-life b, .pr-read h2, .pr-read i, .pr-read dt, .pr-sbar, .pr-status, .pr-flag, .pr-ptab, .pr-link")
      .evaluateAll((all) => all.filter((el) => (el as HTMLElement).checkVisibility()).map((el) => el.textContent ?? ""));
    assert.deepEqual(
      chrome.filter((text) => CJK.test(text.replace("演示征求意见稿", ""))),
      [],
    );
    const internal = await page.locator('.pr-page a[href^="/"]').evaluateAll((all) => all.map((a) => a.getAttribute("href")!));
    assert.ok(internal.length >= 4 && internal.every((href) => href.startsWith("/en/")), internal.join(" "));
    await noOverflow(page, `English ${width}`);
    await done();
  }
});
