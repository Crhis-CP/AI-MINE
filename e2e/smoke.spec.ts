import assert from "node:assert/strict";
import { test as base, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { browserExecutable, isolateBrowser } from "./browser.ts";
import { startBrowserSite } from "./site.ts";
import { FIXED_TIME } from "./time.ts";

const test = base.extend<{ site: Awaited<ReturnType<typeof startBrowserSite>> }>({
  site: async ({ browserName }, use, info) => {
    assert.equal(browserName, "chromium");
    const site = await startBrowserSite(info.outputPath("site.log"));
    try {
      await use(site);
    } finally {
      await site.close();
    }
  },
});

test("production empty reader, private Host boundary and WCAG smoke", async ({ page, context, browser, site }, info) => {
  const blocked = await isolateBrowser(context, [site.publicOrigin, site.privateOrigin, site.badOrigin]);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.setFixedTime(new Date(FIXED_TIME));
  info.annotations.push({ type: "browser", description: `${browser.version()} (${browserExecutable()})` });
  const axeEngines: Array<{ name: string; version: string }> = [];
  const manualReview: Array<{ page: string; rule: string; impact: string | null | undefined }> = [];
  const audit = async (label: string) => {
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    axeEngines.push(result.testEngine);
    manualReview.push(...result.incomplete.map((rule) => ({ page: label, rule: rule.id, impact: rule.impact })));
    await info.attach(`axe-${label}`, { body: JSON.stringify(result, null, 2), contentType: "application/json" });
    expect(
      result.violations
        .filter((v) => v.impact === "critical" || v.impact === "serious")
        .map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target) })),
    ).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(info.project.use.viewport!.width);
  };
  try {
    expect((await page.goto(`${site.publicOrigin}/all`))!.status()).toBe(200);
    await expect(page.getByText("没有找到相关内容", { exact: true })).toBeVisible();
    const search = page.getByRole("textbox", { name: "搜索标题、摘要与正文" });
    await search.fill("铜矿");
    await search.press("Enter");
    await expect(page).toHaveURL(/q=/);
    await expect(page.getByRole("heading", { name: "搜索“铜矿”" })).toBeVisible();
    await page.getByRole("link", { name: "试试“全文相关”，连正文一起搜" }).click();
    await expect(page).toHaveURL(/tab=relevance/);
    assert(site.calls.some((c) => c.role === "public" && new URL(c.path, site.publicOrigin).searchParams.get("q") === "铜矿"));
    await audit("public-empty-search");
    const before = site.calls.filter((c) => c.role === "private").length;
    const denied = await page.goto(`${site.publicOrigin}/admin/login`);
    expect(denied!.status()).toBe(404);
    expect(denied!.headers()["set-cookie"]).toBeUndefined();
    const apiDenied = await page.evaluate(() =>
      fetch("/api/auth/options", { headers: { "X-Forwarded-Host": "private.localhost" } }).then((response) => response.status),
    );
    expect(apiDenied).toBe(404);
    const badHost = await page.goto(`${site.badOrigin}/admin/login`);
    expect(badHost!.status()).toBe(404);
    expect(badHost!.headers()["set-cookie"]).toBeUndefined();
    expect(site.calls.filter((c) => c.role === "private")).toHaveLength(before);
    const login = await page.goto(`${site.privateOrigin}/admin/login`);
    expect(login!.status()).toBe(200);
    expect(login!.headers()["cache-control"]).toContain("no-store");
    await expect(page.getByLabel("管理员密码")).toBeVisible();
    await expect(page.getByRole("link", { name: "用飞书登录" })).toBeVisible();
    await page.getByLabel("管理员密码").fill("synthetic-not-submitted");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "登录", exact: true })).toBeFocused();
    await audit("private-login");
    const probe = "https://blocked.invalid/browser-smoke";
    expect(
      await page.evaluate(
        (url) =>
          fetch(url).then(
            () => false,
            () => true,
          ),
        probe,
      ),
    ).toBe(true);
    expect(blocked).toEqual([probe]);
    expect(errors).toEqual([]);
    expect(site.calls.every((c) => c.method === "GET")).toBe(true);
  } finally {
    console.info(JSON.stringify({ project: info.project.name, browser: browser.version(), axeEngines, manualReview, blocked, errors }));
    await info.attach("browser-evidence", {
      body: JSON.stringify(
        {
          browser: browser.version(),
          executable: browserExecutable(),
          fixedTime: FIXED_TIME,
          blocked,
          errors,
          upstreamCalls: site.calls,
          axeEngines,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  }
});
