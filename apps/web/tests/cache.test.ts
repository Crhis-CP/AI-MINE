// Run after `npm run build -w @amp/web`. Real production server/router, synthetic HTTP API only.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { publicSchemas } from "@amp/api-client/public";
import { CATEGORY_KEYS } from "@amp/contracts/taxonomy";
import { releaseBoundCache } from "../app/lib/api.server.ts";
import { webEnvironment } from "../runtime-env.ts";
import { fetchWithHost } from "../http-probe.ts";

const PRIVATE_HOST = "private.localhost:8443";
const privateHeaders = { Host: PRIVATE_HOST };
let web: ChildProcess;
let origin: string;
let logs = "";
let deadline: number;
let refreshAt: string;
let metaDelayMs = 0;
let metaCalls = 0;
let privatePageFixtures = false;
let poolMode: "ok" | "busy" | "bad" | "missing" = "ok";
let timelineMode: "empty" | "ok" | "bad" | "busy" | "missing" | "invalid" = "empty";
const timelineCalls: Array<{ path: string; accept: string | undefined; ssr: string | undefined }> = [];
const timeline = publicSchemas.TimelineResponse.parse(
  JSON.parse(readFileSync(new URL("../../../scripts/verify/tests/fixtures/timeline-response.json", import.meta.url), "utf8")),
);
const poolCalls: Array<{ path: string; accept: string | undefined; ssr: string | undefined }> = [];
const apiCookies: Array<string | undefined> = [];
const privateCalls: Array<{ path: string; forwarded: string | undefined }> = [];
const privateApi = createServer((req, res) => {
  privateCalls.push({ path: req.url!, forwarded: req.headers["x-forwarded-host"] as string | undefined });
  res.setHeader("Content-Type", "application/json");
  if (req.url!.split("?", 1)[0] === "/api/auth/options") return res.end(JSON.stringify({ password: false, feishu: true }));
  if (req.url!.startsWith("/api/admin/echo")) return res.end(JSON.stringify({ target: "private", path: req.url, forwarded: req.headers["x-forwarded-host"] }));
  if (privatePageFixtures) {
    if (req.url === "/api/admin/me") return res.end(JSON.stringify({ name: "合成管理员", csrf: "test-csrf", dev: false }));
    if (req.url === "/api/admin/nav-counts") return res.end(JSON.stringify({ sources: 888, feedback: 888, runs: 888 }));
    if (req.url?.startsWith("/api/admin/models?"))
      return res.end(JSON.stringify({ days: 7, capabilities: [], choices: [], history: [], benches: [{ id: "old-bench", label: "旧对比记录" }] }));
  }
  res.statusCode = 401;
  res.end(JSON.stringify({ code: "unauthorized" }));
});
const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://api.local");
  apiCookies.push(req.headers.cookie);
  res.setHeader("Content-Type", "application/json");
  if (url.pathname === "/api/site/meta") {
    metaCalls++;
    const respond = () => res.end(JSON.stringify({ changelogVersion: "2026-09-28T12:00" }));
    return metaDelayMs ? setTimeout(respond, metaDelayMs) : respond();
  }
  if (url.pathname === "/api/site/timeline") {
    timelineCalls.push({ path: req.url!, accept: req.headers.accept, ssr: req.headers["x-amp-ssr"] as string | undefined });
    if (["busy", "missing", "invalid"].includes(timelineMode)) {
      res.statusCode = timelineMode === "busy" ? 503 : timelineMode === "missing" ? 404 : 400;
      res.setHeader("Content-Type", "application/problem+json");
      res.setHeader("Retry-After", "17");
      return res.end(JSON.stringify({ code: timelineMode === "invalid" ? "invalid_cursor" : "not_found" }));
    }
    const filters = {
      channel: url.searchParams.get("channel") ?? "all",
      category: url.searchParams.get("category"),
      tag: url.searchParams.get("tag"),
      topic: null,
    };
    res.setHeader("X-Accel-Expires", `@${deadline}`);
    res.setHeader("Cache-Control", "public, max-age=30, s-maxage=30");
    const cards = timelineMode === "empty" ? [] : timeline.cards;
    return res.end(
      JSON.stringify({
        ...timeline,
        filters,
        cards,
        refreshAt: timelineMode === "bad" ? "invalid-date" : refreshAt,
        hot: null,
        dayCounts: timelineMode === "empty" ? {} : timeline.dayCounts,
      }),
    );
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
      PRIVATE_HOST: "private.localhost",
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
      assert.ok(body.includes("public-layout") && body.includes("routes/home"));
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
  const admin = await fetchWithHost(`${origin}/admin/sources.data?_routes=admin-layout`, PRIVATE_HOST);
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
    // The selected loader initially grants a positive TTL, but public layout metadata finishes after it.
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
  const login = await fetchWithHost(origin + "/admin/login", PRIVATE_HOST);
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
  const headers = { ...privateHeaders, "X-Forwarded-Host": "spoofed.invalid" };
  const direct = await fetchWithHost(`${origin}/api/auth/options?from=a%2Fb&from=`, PRIVATE_HOST, { headers });
  assert.deepEqual(await direct.json(), { password: false, feishu: true });
  assert.deepEqual(privateCalls.at(-1), { path: "/api/auth/options?from=a%2Fb&from=", forwarded: PRIVATE_HOST });
  const echo = await fetchWithHost(`${origin}/api/admin/echo?a=%2F&a=&b=2`, PRIVATE_HOST, { headers });
  assert.deepEqual(await echo.json(), { target: "private", path: "/api/admin/echo?a=%2F&a=&b=2", forwarded: PRIVATE_HOST });
  const before = privateCalls.length;
  const login = await fetchWithHost(`${origin}/admin/login`, PRIVATE_HOST, { headers });
  const html = await login.text();
  assert.equal(login.status, 200);
  assert.match(html, /用飞书登录/);
  assert.match(html, /还没有设置管理员密码/);
  assert.ok(privateCalls.slice(before).some((call) => call.path === "/api/auth/options" && call.forwarded === PRIVATE_HOST));
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
    for (const path of ["/all?q=%E9%93%9C+%E9%87%91&page=2", "/all.data?q=%E9%93%9C+%E9%87%91&page=2"]) {
      const busy = await fetch(origin + path, { redirect: "manual" });
      assert.equal(busy.status, 503);
      assert.equal(busy.headers.get("Location"), null);
      assert.equal(busy.headers.get("Cache-Control"), "private, no-store");
      assert.equal(busy.url, origin + path);
      assert.equal(poolCalls.at(-1)!.path, "/api/site/pool?q=%E9%93%9C+%E9%87%91&page=2");
      await busy.text();
    }
  } finally {
    poolMode = "ok";
  }
});

test("home consumes the timeline contract, preserves query/cache headers and keeps failures uncached", async () => {
  try {
    timelineMode = "ok";
    const category = CATEGORY_KEYS.at(-1)!;
    const response = await fetch(`${origin}/?channel=news&category=${category}&tag=%E9%93%9C+%E9%87%91`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /真实精选消费者/);
    assert.deepEqual(timelineCalls.at(-1), {
      path: `/api/site/timeline?channel=news&category=${category}&tag=%E9%93%9C+%E9%87%91`,
      accept: "application/json",
      ssr: "1",
    });
    assert.equal(response.headers.get("X-Accel-Expires"), `@${deadline}`);
    for (const [mode, status] of [
      ["bad", 503],
      ["busy", 503],
      ["missing", 404],
      ["invalid", 400],
    ] as const) {
      timelineMode = mode;
      const failed = await fetch(`${origin}/`);
      assert.equal(failed.status, status, mode);
      assert.equal(failed.headers.get("Cache-Control"), "private, no-store");
      await failed.text();
    }
    timelineMode = "empty";
    const empty = await fetch(origin);
    assert.equal(empty.status, 200);
    assert.match(await empty.text(), /这个筛选下还没有精选内容/);
    const search = await fetch(`${origin}/?q=test`, { redirect: "manual" });
    assert.equal(search.status, 302);
    assert.equal(search.headers.get("Location"), "/all?q=test");
    await search.text();
  } finally {
    timelineMode = "empty";
  }
});

test("public Host rejects private pages, data, API and redirect aliases before any private work", async () => {
  const before = privateCalls.length;
  for (const method of ["GET", "HEAD"]) {
    for (const pathname of [
      "/admin/login",
      "/ADMIN/login",
      "/%61dmin/login",
      "/admin/sources.data?_routes=root",
      "/sources/x",
      "/api/auth/options",
      "/api/%61dmin/me",
    ]) {
      const response = await fetch(origin + pathname, { method, redirect: "manual", headers: { "X-Forwarded-Host": PRIVATE_HOST } });
      assert.equal(response.status, 404, method + " " + pathname);
      assert.equal(response.headers.get("Set-Cookie"), null);
      assert.equal(response.headers.get("Location"), null);
      assert.equal(response.headers.get("Cache-Control"), "private, no-store");
      await response.arrayBuffer();
    }
  }
  assert.equal(privateCalls.length, before, "neither private proxy nor SSR loader ran");
  const redirect = await fetchWithHost(origin + "/sources/x", PRIVATE_HOST);
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("Location"), "/admin/sources/x");
  assert.equal(redirect.headers.get("Cache-Control"), "private, no-store");
  const login = await fetchWithHost(origin + "/admin/login", "PRIVATE.LOCALHOST:443");
  assert.equal(login.status, 200);
  const html = await login.text();
  const asset = html.match(/(?:src|href)="(\/assets\/[^"<>]+\.js)"/)?.[1];
  assert.ok(asset, "built private login loads actual client JavaScript");
  const response = await fetchWithHost(origin + asset, PRIVATE_HOST);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  await response.arrayBuffer();
});

test("actual Vite SSR admits only the configured private Host for login", async (t) => {
  const holder = createServer().listen(0, "127.0.0.1");
  await once(holder, "listening");
  const port = (holder.address() as AddressInfo).port;
  await new Promise<void>((resolve) => holder.close(() => resolve()));
  const dev = spawn(process.execPath, ["node_modules/@react-router/dev/bin.cjs", "dev", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: webEnvironment({
      ...process.env,
      NODE_ENV: "development",
      SITE_URL: "http://public.preview.test",
      PRIVATE_HOST: "private.preview.test",
      WEB_ROUTE_GROUP: "private",
      API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
      PRIVATE_API_BASE_URL: `http://127.0.0.1:${(privateApi.address() as AddressInfo).port}`,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(dev, "exit");
  t.after(async () => {
    if (dev.exitCode === null) dev.kill("SIGTERM");
    await exited;
  });
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(output || "Vite startup timeout")), 30_000);
    dev.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error(output));
    });
    const read = (chunk: Buffer) => {
      output += String(chunk);
      if (output.includes(`http://127.0.0.1:${port}`)) {
        clearTimeout(timeout);
        resolve();
      }
    };
    dev.stdout!.on("data", read);
    dev.stderr!.on("data", read);
  });
  const base = `http://127.0.0.1:${port}`;
  const before = privateCalls.length;
  const denied = await fetchWithHost(base + "/admin/login", "public.preview.test", { headers: { "X-Forwarded-Host": "private.preview.test" } });
  assert.equal(denied.status, 404);
  assert.equal(denied.headers.get("Set-Cookie"), null);
  await denied.text();
  assert.equal(privateCalls.length, before);
  const login = await fetchWithHost(base + "/admin/login", "private.preview.test");
  assert.equal(login.status, 200);
  assert.equal(login.headers.get("Cache-Control"), "private, no-store");
  assert.match(await login.text(), /用飞书登录/);
});

test("two builds keep the private manifest, JavaScript and CSS off the public Host", async () => {
  const assets = (group: string) => new URL(`../build/${group}/client/assets/`, import.meta.url);
  const publicFiles = new Set(readdirSync(assets("public")));
  const privateFiles = readdirSync(assets("private"));
  const privateOnly = privateFiles.filter((file) => !publicFiles.has(file));
  for (const suffix of [".js", ".css"]) assert.ok(privateOnly.some((file) => file.endsWith(suffix)));
  const publicManifest = [...publicFiles].find((file) => file.startsWith("manifest-"))!;
  const manifest = await fetch(origin + "/assets/" + publicManifest);
  assert.equal(manifest.status, 200);
  assert.doesNotMatch(await manifest.text(), /admin-layout|routes\/admin/);
  const css = (group: string) =>
    readdirSync(assets(group))
      .filter((file) => file.endsWith(".css"))
      .map((file) => readFileSync(new URL(file, assets(group)), "utf8"))
      .join("");
  assert.ok(css("private").includes(".w-\\[216px\\]"), "private layout utility is generated");
  assert.ok(!css("public").includes(".w-\\[216px\\]"), "private-only classes are excluded from the public scan");
  assert.ok(css("public").includes(".lg\\:w-60"), "reader search width must survive the public feature scan");
  assert.ok(css("public").includes(".h-\\[42px\\]"), "reader search height must survive the public feature scan");
  const before = privateCalls.length;
  for (const file of privateOnly) {
    for (const method of ["GET", "HEAD"]) {
      const denied = await fetch(origin + "/assets/" + file, { method });
      assert.equal(denied.status, 404, file);
      assert.equal(denied.headers.get("Set-Cookie"), null);
      await denied.arrayBuffer();
    }
    const allowed = await fetchWithHost(origin + "/assets/" + file, PRIVATE_HOST);
    assert.equal(allowed.status, 200, file);
    assert.equal(allowed.headers.get("Cache-Control"), "private, no-store");
    assert.deepEqual(Buffer.from(await allowed.arrayBuffer()), readFileSync(new URL(file, assets("private"))));
  }
  assert.equal(privateCalls.length, before);
  const metaBefore = metaCalls;
  const login = await fetchWithHost(origin + "/admin/login", PRIVATE_HOST);
  assert.equal(login.status, 200);
  assert.equal(metaCalls, metaBefore, "private SSR never calls public metadata");
  assert.doesNotMatch(await (await fetch(origin)).text(), /admin-layout|routes\/admin/);
});

test("existing private preview links redirect only to the configured public origin", async () => {
  for (const method of ["GET", "HEAD"]) {
    for (const pathname of ["/", "/all", "/items/example?q=1", "/story/example", "/items/%2f%2fattacker.invalid"]) {
      const response = await fetchWithHost(origin + pathname, PRIVATE_HOST, { method });
      assert.equal(response.status, 302);
      const target = new URL(response.headers.get("Location")!);
      assert.equal(target.origin, new URL(process.env.SITE_URL || "http://localhost:3000").origin);
      assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    }
  }
  const unknown = await fetchWithHost(origin + "//attacker.invalid", PRIVATE_HOST);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers.get("Location"), null);
});

test("retired daily pages are absent and private navigation no longer requests counts or links construction tools", async () => {
  const before = privateCalls.length;
  privatePageFixtures = true;
  try {
    for (const path of ["/search-busy", "/all/search-busy", "/admin/audit", "/admin/selectbench", "/admin/selectbench/example"]) {
      for (const suffix of ["", ".data?_routes=root"]) {
        for (const method of ["GET", "HEAD"]) {
          const response = path.startsWith("/admin")
            ? await fetchWithHost(origin + path + suffix, PRIVATE_HOST, { method })
            : await fetch(origin + path + suffix, { method });
          assert.equal(response.status, 404, path + suffix);
          assert.equal(response.headers.get("Location"), null);
          assert.equal(response.headers.get("Cache-Control"), "private, no-store");
          assert.equal(response.headers.get("Set-Cookie"), null);
          await response.arrayBuffer();
        }
      }
    }
    const response = await fetchWithHost(origin + "/admin/models", PRIVATE_HOST);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /合成管理员/);
    assert.match(html, /模型与评测/);
    assert.doesNotMatch(html, /\/admin\/(?:selectbench|audit)|同批样本对比|888/);
    assert.ok(privateCalls.slice(before).every(({ path }) => path === "/api/admin/me" || path.startsWith("/api/admin/models?")));
    for (const group of ["public", "private"]) {
      const modules = readFileSync(new URL(`../build/${group}/modules.json`, import.meta.url), "utf8");
      assert.doesNotMatch(modules, /routes\/(?:search-busy|admin\/(?:audit|selectbench))/);
    }
  } finally {
    privatePageFixtures = false;
  }
});
