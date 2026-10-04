// Run after `npm run build -w @amp/web`. Real production server/router, synthetic HTTP API only.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { CATEGORY_KEYS } from "@amp/contracts/taxonomy";
import { releaseBoundCache } from "../app/lib/api.server.ts";
import { webEnvironment } from "../runtime-env.ts";

let web: ChildProcess;
let origin: string;
let logs = "";
let deadline: number;
let refreshAt: string;
let metaDelayMs = 0;
let poolMode: "ok" | "busy" | "bad" | "missing" = "ok";
const poolCalls: Array<{ path: string; accept: string | undefined; ssr: string | undefined }> = [];
const apiCookies: Array<string | undefined> = [];
const privateCalls: Array<{ path: string; forwarded: string | undefined }> = [];
const privateApi = createServer((req, res) => {
  privateCalls.push({ path: req.url!, forwarded: req.headers["x-forwarded-host"] as string | undefined });
  res.setHeader("Content-Type", "application/json");
  if (req.url!.split("?", 1)[0] === "/api/auth/options") return res.end(JSON.stringify({ password: false, feishu: true }));
  if (req.url!.startsWith("/api/admin/echo")) return res.end(JSON.stringify({ target: "private", path: req.url, forwarded: req.headers["x-forwarded-host"] }));
  res.statusCode = 401;
  res.end(JSON.stringify({ code: "unauthorized" }));
});
const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://api.local");
  apiCookies.push(req.headers.cookie);
  res.setHeader("Content-Type", "application/json");
  if (url.pathname === "/api/site/meta") {
    const respond = () => res.end(JSON.stringify({ changelogVersion: "2026-09-28T12:00" }));
    return metaDelayMs ? setTimeout(respond, metaDelayMs) : respond();
  }
  if (url.pathname === "/api/site/timeline") {
    const filters = { channel: "all", category: url.searchParams.get("category"), tag: null, topic: null };
    res.setHeader("X-Accel-Expires", `@${deadline}`);
    res.setHeader("Cache-Control", "public, max-age=30, s-maxage=30");
    return res.end(JSON.stringify({ filters, cards: [], nextCursor: null, refreshAt, dayCounts: [], hot: null, generatedAt: "2026-09-28T00:00:00Z" }));
  }
  if (url.pathname === "/api/site/pool") {
    poolCalls.push({ path: req.url!, accept: req.headers.accept, ssr: req.headers["x-amp-ssr"] as string | undefined });
    if (poolMode === "busy" || poolMode === "missing") {
      res.statusCode = poolMode === "busy" ? 503 : 404;
      res.setHeader("Content-Type", "application/problem+json");
      res.setHeader("Retry-After", "17");
      return res.end(JSON.stringify({ code: poolMode === "busy" ? "temporarily_unavailable" : "not_found" }));
    }
    return res.end(
      JSON.stringify({
        filters: { channel: "all", category: null, tag: null, topic: null, q: url.searchParams.get("q"), tab: "time" },
        items: [
          {
            id: "pool-fixture",
            title: "真实列表消费者",
            summary: null,
            reason: null,
            source: { name: "合成来源" },
            publishedAt: null,
            timelineAt: "2026-10-04T00:00:00Z",
            category: null,
            tags: [],
            score: poolMode === "bad" ? "invalid" : null,
            selected: false,
            channel: "news",
          },
        ],
        page: Number(url.searchParams.get("page") || 1),
        pageCount: 3,
        total: 81,
        todayCount: 1,
        freshness: "2026-10-04T00:00:00Z",
        generatedAt: "2026-10-04T00:00:00Z",
      }),
    );
  }
  if (url.pathname === "/api/site/hot") return res.end(JSON.stringify({ entries: [] }));
  if (url.pathname === "/api/site/echo-routing") return res.end(JSON.stringify({ target: "public", path: req.url }));
  if (url.pathname === "/api/site/echo-client") return res.end(JSON.stringify({ forwarded: req.headers["x-forwarded-for"], real: req.headers["x-real-ip"] }));
  if (url.pathname === "/api/site/items/long-lived") return res.end(JSON.stringify({ id: "long-lived", title: "t" }));
  if (url.pathname === "/api/site/stories/merged") {
    res.statusCode = 308;
    return res.end(JSON.stringify({ mergedInto: "surviving-story" }));
  }
  res.statusCode = url.pathname.startsWith("/api/admin/") ? 401 : 404;
  res.end(JSON.stringify({ code: "not_found" }));
});

before(async () => {
  deadline = Math.floor(Date.now() / 1000) + 20;
  refreshAt = new Date((deadline + 5) * 1000).toISOString();
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  privateApi.listen(0, "127.0.0.1");
  await once(privateApi, "listening");
  web = spawn(process.execPath, [fileURLToPath(new URL("../server.ts", import.meta.url))], {
    env: webEnvironment({
      ...process.env,
      WEB_PORT: "0",
      TRUST_PROXY: "false",
      API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
      PRIVATE_API_BASE_URL: `http://127.0.0.1:${(privateApi.address() as AddressInfo).port}`,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`web did not start: ${logs}`)), 15_000);
    web.on("exit", () => {
      clearTimeout(timeout);
      reject(new Error(`web exited: ${logs}`));
    });
    web.stderr!.on("data", (chunk) => {
      logs += String(chunk);
    });
    web.stdout!.on("data", (chunk) => {
      logs += String(chunk);
      const match = logs.match(/"msg":"web started","port":(\d+)/);
      if (match) {
        origin = `http://127.0.0.1:${match[1]}`;
        clearTimeout(timeout);
        resolve();
      }
    });
  });
});

after(async () => {
  if (web && web.exitCode === null) {
    web.kill("SIGTERM");
    await once(web, "exit");
  }
  for (const server of [api, privateApi]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("public route subsets produce the same complete navigation data; filters still differ", async () => {
  const answers = await Promise.all(
    ["", "?_routes=root", "?_routes=routes%2Fhome", "?_routes=unknown"].map(async (query) => {
      const res = await fetch(`${origin}/_.data${query}`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("Cache-Control")!, /^public,/);
      assert.equal(res.headers.get("X-Accel-Expires"), `@${deadline}`);
      assert.doesNotMatch(res.headers.get("Cache-Control")!, /stale/);
      const body = await res.text();
      assert.ok(body.includes("root") && body.includes("routes/home"));
      return body;
    }),
  );
  assert.ok(answers.every((body) => body === answers[0]));
  const category = CATEGORY_KEYS.at(-1)!;
  const filtered = await fetch(`${origin}/_.data?category=${category}&_routes=root`);
  const body = await filtered.text();
  assert.ok(body.includes(category));
  assert.notEqual(body, answers[0]);
});

test("HTML and navigation share freshness; cookies do not personalize public results", async () => {
  const html = await fetch(`${origin}/`);
  assert.equal(html.status, 200);
  assert.equal(html.headers.get("X-Accel-Expires"), `@${deadline}`);
  assert.match(await html.text(), /精选/);
  const plain = await fetch(`${origin}/about.data`);
  const signedIn = await fetch(`${origin}/about.data?_routes=root`, { headers: { cookie: "admin_session=private; amp_vid=reader" } });
  assert.match(plain.headers.get("Cache-Control")!, /^public,/);
  assert.match(plain.headers.get("X-Accel-Expires")!, /^@\d+$/);
  assert.equal(plain.headers.get("Cache-Control"), "public, max-age=300, s-maxage=300, must-revalidate");
  assert.equal(Date.parse(plain.headers.get("Date")!) / 1000 + 300, Number(plain.headers.get("X-Accel-Expires")!.slice(1)));
  assert.equal(signedIn.headers.get("Set-Cookie"), null);
  assert.equal(await signedIn.text(), await plain.text());
  assert.ok(apiCookies.every((cookie) => !cookie));
});

test("missing routes cannot be hidden by a root-only request; errors and redirects stay uncached", async () => {
  for (const pathname of ["/items/missing.data?_routes=root", "/does-not-exist.data?_routes=root", "/items/missing"]) {
    const res = await fetch(origin + pathname);
    assert.equal(res.status, 404, pathname);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    assert.equal(res.headers.get("X-Accel-Expires"), "0");
    await res.text();
  }
  for (const [pathname, target] of [
    ["/story/merged.data?_routes=root", "/story/surviving-story"],
    ["/_.data?q=search&_routes=root", "/all?q=search"],
  ]) {
    const res = await fetch(origin + pathname);
    assert.equal(res.status, 202);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    assert.match(await res.text(), new RegExp(target.replace("?", "\\?")));
  }
});

test("admin data and actions never become public cache entries", async () => {
  const admin = await fetch(`${origin}/admin/sources.data?_routes=admin-layout`);
  assert.equal(admin.status, 202);
  assert.equal(admin.headers.get("Cache-Control"), "private, no-store");
  assert.equal(admin.headers.get("X-Accel-Expires"), "0");
  assert.match(await admin.text(), /admin\/login/);
  const action = await fetch(`${origin}/hot.data`, { method: "POST" });
  assert.equal(action.status, 405);
  assert.equal(action.headers.get("Cache-Control"), "private, no-store");
  assert.equal(action.headers.get("X-Accel-Expires"), "0");
  await action.text();
});

test("an elapsed release deadline cannot be extended by a fresh page/data response", async () => {
  const saved = refreshAt;
  refreshAt = new Date(Date.now() - 1000).toISOString();
  try {
    for (const pathname of ["/", "/_.data?_routes=routes%2Fhome"]) {
      const res = await fetch(origin + pathname);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("Cache-Control"), "no-cache");
      assert.equal(res.headers.get("X-Accel-Expires"), "0");
      await res.text();
    }
  } finally {
    refreshAt = saved;
  }
  const now = Date.parse("2026-09-28T00:00:00Z");
  const upstream = new Headers({ "X-Accel-Expires": `@${now / 1000 + 7}` });
  const headers = releaseBoundCache(new Date(now + 20_000).toISOString(), 30, now + 2_000, upstream);
  assert.equal(headers["Cache-Control"], "public, max-age=0, s-maxage=5");
  assert.equal(headers["X-Accel-Expires"], upstream.get("X-Accel-Expires"));
});

test("browser freshness shares the selected deadline, including slow sibling loaders", async () => {
  const savedDeadline = deadline;
  const savedRefresh = refreshAt;
  try {
    deadline = Math.floor(Date.now() / 1000) + 20;
    refreshAt = new Date((deadline + 5) * 1000).toISOString();
    for (const pathname of ["/", "/_.data?_routes=routes%2Fhome"]) {
      const res = await fetch(origin + pathname);
      const cc = res.headers.get("Cache-Control")!;
      const browser = Number(cc.match(/(?:^|,)\s*max-age=(\d+)/)![1]);
      const shared = Number(cc.match(/(?:^|,)\s*s-maxage=(\d+)/)![1]);
      assert.ok(browser > 0 && browser === shared);
      assert.ok(Date.parse(res.headers.get("Date")!) / 1000 + browser <= deadline);
      assert.equal(res.headers.get("X-Accel-Expires"), `@${deadline}`);
      assert.match(cc, /must-revalidate/);
      assert.doesNotMatch(cc, /stale/);
      await res.text();
    }
    // The selected loader initially grants a positive TTL, but root metadata finishes after it.
    deadline = Math.floor(Date.now() / 1000) + 2;
    refreshAt = new Date((deadline + 5) * 1000).toISOString();
    metaDelayMs = 2300;
    await Promise.all(
      ["/", "/_.data?_routes=routes%2Fhome"].map(async (pathname) => {
        const res = await fetch(origin + pathname);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("Cache-Control"), "no-cache");
        assert.equal(res.headers.get("X-Accel-Expires"), "0");
        await res.text();
      }),
    );
  } finally {
    deadline = savedDeadline;
    refreshAt = savedRefresh;
    metaDelayMs = 0;
  }
});

test("the edge may keep a page longer than browsers, which a withdrawal purge cannot reach", async () => {
  const res = await fetch(`${origin}/items/long-lived.data`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=300, s-maxage=600, must-revalidate");
  await res.text();
});

test("browser caching preserves noindex and private sign-in responses", async () => {
  const feedback = await fetch(origin + "/feedback");
  assert.equal(feedback.status, 200);
  assert.match(await feedback.text(), /name="robots" content="noindex/);
  assert.equal(feedback.headers.get("Cache-Control"), "public, max-age=300, s-maxage=300, must-revalidate");
  const login = await fetch(origin + "/admin/login");
  assert.equal(login.status, 200);
  assert.equal(login.headers.get("Cache-Control"), "private, no-store");
  assert.equal(login.headers.get("X-Robots-Tag"), "noindex, nofollow");
  await login.text();
});

test("a visitor cannot name its own address to the api without a trusted proxy in front", async () => {
  const res = await fetch(`${origin}/api/site/echo-client`, { headers: { "X-Forwarded-For": "6.6.6.6", "X-Real-IP": "6.6.6.6" } });
  assert.deepEqual(await res.json(), { forwarded: "127.0.0.1", real: "127.0.0.1" });
});

test("private proxy and login SSR use the private API, preserve raw queries, and replace a spoofed host", async () => {
  const headers = { "X-Forwarded-Host": "spoofed.invalid" };
  const direct = await fetch(`${origin}/api/auth/options?from=a%2Fb&from=`, { headers });
  assert.deepEqual(await direct.json(), { password: false, feishu: true });
  assert.deepEqual(privateCalls.at(-1), { path: "/api/auth/options?from=a%2Fb&from=", forwarded: new URL(origin).host });
  const echo = await fetch(`${origin}/api/admin/echo?a=%2F&a=&b=2`, { headers });
  assert.deepEqual(await echo.json(), { target: "private", path: "/api/admin/echo?a=%2F&a=&b=2", forwarded: new URL(origin).host });
  const before = privateCalls.length;
  const login = await fetch(`${origin}/admin/login`, { headers });
  const html = await login.text();
  assert.equal(login.status, 200);
  assert.match(html, /用飞书登录/);
  assert.match(html, /还没有设置管理员密码/);
  assert.ok(privateCalls.slice(before).some((call) => call.path === "/api/auth/options" && call.forwarded === new URL(origin).host));
  assert.equal(login.headers.get("Cache-Control"), "private, no-store");
  const reader = await fetch(`${origin}/api/site/echo-routing?q=/api/auth/options`);
  assert.deepEqual(await reader.json(), { target: "public", path: "/api/site/echo-routing?q=/api/auth/options" });
});

test("the real /all page consumes its generated pool contract and preserves error routing", async () => {
  try {
    const page = await fetch(`${origin}/all?q=%E9%93%9C+%E9%87%91&page=2`, { headers: { cookie: "admin_session=private" } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /真实列表消费者/);
    assert.deepEqual(poolCalls.at(-1), { path: "/api/site/pool?q=%E9%93%9C+%E9%87%91&page=2", accept: "application/json", ssr: "1" });
    assert.equal(page.headers.get("Cache-Control"), "public, max-age=60, s-maxage=60, must-revalidate");
    assert.ok(apiCookies.every((cookie) => !cookie));
    for (const [mode, status] of [
      ["bad", 503],
      ["missing", 404],
    ] as const) {
      poolMode = mode;
      const response = await fetch(`${origin}/all`);
      assert.equal(response.status, status, mode);
      assert.equal(response.headers.get("Cache-Control"), "private, no-store");
      await response.text();
    }
    poolMode = "busy";
    const busy = await fetch(`${origin}/all`, { redirect: "manual" });
    assert.equal(busy.status, 302);
    assert.equal(busy.headers.get("Location"), "/all/search-busy");
    await busy.text();
  } finally {
    poolMode = "ok";
  }
});
