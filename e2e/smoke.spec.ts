import assert from "node:assert/strict";
import { test as base, expect, type Response } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { browserExecutable, isolateBrowser } from "./browser.ts";
import { startBrowserSite } from "./site.ts";
import { FIXED_TIME } from "./time.ts";

type CspViolation = { directive: string; blockedURI: string };
declare global {
  interface Window {
    __reportCsp: (violation: CspViolation) => Promise<void>;
    __injected?: number;
    __injected2?: number;
  }
}

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

test("login renews an expired or other-tab ticket before one native password submission", async ({ page, context, site }) => {
  const blocked = await isolateBrowser(context, [site.privateOrigin]);
  let issued = 0;
  let currentToken = "";
  let now = Date.parse(FIXED_TIME);
  let expires = 0;
  const ticket = (sequence: number) => `synthetic_login_ticket_${sequence}`.padEnd(43, "_");
  let releaseSubmit!: () => void;
  const submitReady = new Promise<void>((resolve) => {
    releaseSubmit = resolve;
  });
  const posts: Array<{ token: string | null; cookie: string; name: string | null; password: string | null }> = [];
  await context.route(`${site.privateOrigin}/api/auth/password-nonce`, async (route) => {
    const token = ticket(++issued);
    if (issued === 3) await submitReady;
    currentToken = token;
    expires = now + 300_000;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store", "set-cookie": `amp_login_nonce=${token}; Path=/; HttpOnly; SameSite=Lax` },
      body: JSON.stringify({ token, expires_at: new Date(expires).toISOString() }),
    });
  });
  await context.route(`${site.privateOrigin}/api/auth/password`, async (route) => {
    const data = new URLSearchParams(route.request().postData() ?? "");
    const posted = {
      token: data.get("login_nonce"),
      cookie: (await route.request().headerValue("cookie")) ?? "",
      name: data.get("login_name"),
      password: data.get("password"),
    };
    posts.push(posted);
    const verified = expires > now && posted.token === currentToken && posted.cookie.includes(`amp_login_nonce=${currentToken}`);
    currentToken = "consumed";
    await route.fulfill({
      status: verified ? 200 : 400,
      contentType: "text/html; charset=utf-8",
      body: verified ? "<h1>合成登录完成</h1>" : "<h1>合成验证失败</h1>",
    });
  });
  await page.clock.setFixedTime(new Date(now));
  await page.goto(`${site.privateOrigin}/admin/login?return=%2Fadmin&error=verification`);
  await expect(page.locator('input[name="login_nonce"]')).toHaveValue(ticket(1));
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page).not.toHaveURL(/error=verification/);
  await page.getByLabel("登录名", { exact: true }).fill("synthetic.operator");
  await page.getByLabel("密码", { exact: true }).fill("synthetic-password");
  now += 6 * 60_000;
  await page.clock.setFixedTime(new Date(now));
  const other = await context.newPage();
  await other.goto(`${site.privateOrigin}/admin/login`);
  await expect(other.locator('input[name="login_nonce"]')).toHaveValue(ticket(2));
  await expect(page.locator('input[name="login_nonce"]')).toHaveValue(ticket(1));
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect.poll(() => issued).toBe(3);
  await expect(page.getByRole("button", { name: "正在登录…", exact: true })).toBeDisabled();
  await page.locator("form").evaluate((form: HTMLFormElement) => form.requestSubmit());
  expect(issued).toBe(3);
  expect(posts).toHaveLength(0);
  const submission = page.waitForResponse((response) => response.url() === `${site.privateOrigin}/api/auth/password` && response.request().method() === "POST");
  releaseSubmit();
  const submitted = await submission;
  expect(posts).toEqual([{ token: ticket(3), cookie: `amp_login_nonce=${ticket(3)}`, name: "synthetic.operator", password: "synthetic-password" }]);
  expect(submitted.status()).toBe(200);
  expect(submitted.headers()["content-type"]).toBe("text/html; charset=utf-8");
  await expect(page.getByRole("heading", { name: "合成登录完成" })).toBeVisible();
  expect(blocked).toEqual([]);
  await other.close();
});

test("login keeps entered credentials after ticket failure and ignores a response after leaving", async ({ page, context, site }) => {
  const blocked = await isolateBrowser(context, [site.privateOrigin]);
  let issued = 0;
  let posts = 0;
  let releaseLate!: () => void;
  const lateResponse = new Promise<void>((resolve) => {
    releaseLate = resolve;
  });
  await context.route(`${site.privateOrigin}/api/auth/password-nonce`, async (route) => {
    const sequence = ++issued;
    if (sequence === 2) return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    if (sequence === 3) await lateResponse;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token: `synthetic-retry-ticket-${sequence}`, expires_at: new Date(Date.parse(FIXED_TIME) + 300_000).toISOString() }),
    });
  });
  await context.route(`${site.privateOrigin}/api/auth/password`, async (route) => {
    posts++;
    await route.abort();
  });
  await page.goto(`${site.privateOrigin}/admin/login`);
  await expect(page.getByRole("button", { name: "登录", exact: true })).toBeEnabled();
  await page.getByLabel("登录名", { exact: true }).fill("synthetic.operator");
  await page.getByLabel("密码", { exact: true }).fill("synthetic-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("已填写的内容会保留");
  await expect(page.getByLabel("登录名", { exact: true })).toHaveValue("synthetic.operator");
  await expect(page.getByLabel("密码", { exact: true })).toHaveValue("synthetic-password");
  await expect(page.getByRole("button", { name: "登录", exact: true })).toBeEnabled();
  expect(posts).toBe(0);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect.poll(() => issued).toBe(3);
  await page.getByRole("link", { name: /回到/ }).click();
  releaseLate();
  await expect(page).toHaveURL(`${site.privateOrigin}/`);
  await expect(page.locator('input[name="password"]')).toHaveCount(0);
  expect(posts).toBe(0);
  expect(blocked).toEqual([]);
});

test("production empty reader, private Host boundary and WCAG smoke", async ({ page, context, browser, site }, info) => {
  const blocked = await isolateBrowser(context, [site.publicOrigin, site.privateOrigin, site.badOrigin]);
  const violations: CspViolation[] = [];
  await page.exposeBinding("__reportCsp", (_source, violation: CspViolation) => violations.push(violation));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      void window.__reportCsp({ directive: event.effectiveDirective, blockedURI: event.blockedURI });
    });
  });
  const pageNonce = async (response: Response) => {
    const nonce = response.headers()["content-security-policy"]?.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    await expect(page.locator("html")).toHaveAttribute("data-theme", /^(light|dark)$/);
    const nonces = await page
      .locator('script:not([type="application/ld+json"])')
      .evaluateAll((scripts) => scripts.map((script) => (script as HTMLScriptElement).nonce));
    expect(nonces.length).toBeGreaterThan(0);
    expect(nonces.every((value) => value === nonce)).toBe(true);
    return nonce;
  };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const privateAssets: { pathname: string; status: number }[] = [];
  page.on("response", (response) => {
    const pathname = new URL(response.url()).pathname;
    if (pathname.startsWith("/admin/assets/")) privateAssets.push({ pathname, status: response.status() });
  });
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
    const reader = await page.goto(`${site.publicOrigin}/all`);
    expect(reader!.status()).toBe(200);
    await pageNonce(reader!);
    await expect(page.getByText("没有找到相关内容", { exact: true })).toBeVisible();
    const phone = info.project.name === "mobile";
    if (phone) await page.getByRole("link", { name: "搜索", exact: true }).click();
    const search = phone
      ? page.getByRole("dialog", { name: "搜索", exact: true }).getByRole("searchbox", { name: "搜索标题、摘要与正文" })
      : page.getByRole("textbox", { name: "搜索标题、摘要与正文" });
    await search.fill("铜矿");
    await search.press("Enter");
    await expect(page).toHaveURL(/q=/);
    if (phone) await expect(page.getByRole("button", { name: "修改搜索：铜矿", exact: true })).toBeVisible();
    else await expect(page.getByRole("heading", { name: "搜索“铜矿”" })).toBeVisible();
    await page.getByRole("link", { name: "试试“全文相关”，连正文一起搜" }).click();
    await expect(page).toHaveURL(/tab=relevance/);
    assert(site.calls.some((c) => c.role === "public" && new URL(c.path, site.publicOrigin).searchParams.get("q") === "铜矿"));
    await audit("public-empty-search");
    expect(violations).toEqual([]);
    const before = site.calls.filter((c) => c.role === "private").length;
    const denied = await page.goto(`${site.badOrigin}/admin/login`);
    expect(denied!.status()).toBe(404);
    expect(denied!.headers()["set-cookie"]).toBeUndefined();
    const apiDenied = await page.evaluate(() =>
      fetch("/api/auth/options", { headers: { "X-Forwarded-Host": "127.0.0.1" } }).then((response) => response.status),
    );
    expect(apiDenied).toBe(404);
    expect(site.calls.filter((c) => c.role === "private")).toHaveLength(before);
    const nonceResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/auth/password-nonce");
    const login = await page.goto(`${site.privateOrigin}/admin/login`);
    expect(login!.status()).toBe(200);
    expect(login!.headers()["cache-control"]).toContain("no-store");
    await expect(page.getByLabel("登录名", { exact: true })).toBeVisible();
    await expect(page.getByLabel("密码", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "用飞书登录" })).toBeVisible();
    expect(privateAssets.some(({ pathname }) => pathname.endsWith(".js"))).toBe(true);
    expect(privateAssets.some(({ pathname }) => pathname.endsWith(".css"))).toBe(true);
    expect(privateAssets.every(({ status }) => status === 200)).toBe(true);
    const issued = await nonceResponse;
    expect(issued.status()).toBe(200);
    expect(issued.headers()["cache-control"]).toContain("no-store");
    const loginNonce = page.locator('input[name="login_nonce"]');
    await expect(loginNonce).toHaveValue("synthetic-login-nonce-1");
    await expect(page.getByRole("button", { name: "登录", exact: true })).toBeEnabled();
    await page.getByLabel("登录名", { exact: true }).fill("synthetic.operator");
    await page.getByLabel("密码", { exact: true }).fill("synthetic-not-submitted");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "登录", exact: true })).toBeFocused();
    await audit("private-login");
    const firstNonce = await pageNonce(login!);
    const reopened = await page.goto(`${site.privateOrigin}/admin/login`);
    expect(await pageNonce(reopened!)).not.toBe(firstNonce);
    await expect(loginNonce).toHaveValue("synthetic-login-nonce-2");
    await expect(page.getByRole("button", { name: "登录", exact: true })).toBeEnabled();
    expect(violations).toEqual([]);

    const injectionUrl = `${site.publicOrigin}/about`;
    await page.route(
      injectionUrl,
      async (route) => {
        const response = await route.fetch();
        const body = (await response.text()).replace("</body>", '<script>window.__injected=1</script><img src="/x" onerror="window.__injected2=1"></body>');
        await route.fulfill({ response, body });
      },
      { times: 1 },
    );
    expect((await page.goto(injectionUrl))!.status()).toBe(200);
    await expect.poll(() => violations.map((event) => event.directive).sort()).toEqual(["script-src-attr", "script-src-elem"]);
    expect(await page.evaluate(() => [window.__injected, window.__injected2])).toEqual([undefined, undefined]);
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
    await expect.poll(() => violations.filter((event) => event.directive === "connect-src")).toEqual([{ directive: "connect-src", blockedURI: probe }]);
    expect(blocked).toEqual([]);
    const blank = await context.newPage();
    try {
      expect(
        await blank.evaluate(
          (url) =>
            fetch(url).then(
              () => false,
              () => true,
            ),
          probe,
        ),
      ).toBe(true);
    } finally {
      await blank.close();
    }
    expect(blocked).toEqual([probe]);
    expect(errors).toEqual([]);
    expect(site.calls.every((c) => c.method === "GET")).toBe(true);
  } finally {
    console.info(JSON.stringify({ project: info.project.name, browser: browser.version(), axeEngines, manualReview, blocked, errors, violations }));
    await info.attach("browser-evidence", {
      body: JSON.stringify(
        {
          browser: browser.version(),
          executable: browserExecutable(),
          fixedTime: FIXED_TIME,
          blocked,
          errors,
          violations,
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
