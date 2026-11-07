// The request guard on the one public entry (TASK-0583): per-visitor limits, security headers on every response,
// oversized URLs refused, and the server's own checks never limited.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { webEnvironment } from "../runtime-env.ts";
import { bucketFor, clientAddress, guardLimits, RateLimiter, securityHeaders } from "../request-guard.ts";

const request = (remoteAddress: string, forwarded?: string) =>
  ({ headers: forwarded ? { "x-forwarded-for": forwarded } : {}, socket: { remoteAddress } }) as unknown as IncomingMessage;

test("each visitor gets its own window per bucket; over the limit it waits for the window to end", () => {
  let now = 1_000_000;
  const limiter = new RateLimiter({ page: 3, api: 5, write: 1, windowMs: 60_000 }, () => now);
  for (let i = 0; i < 3; i++) assert.deepEqual(limiter.take("203.0.113.7", "page"), { ok: true });
  assert.deepEqual(limiter.take("203.0.113.7", "page"), { ok: false, retryAfter: 60 });
  assert.deepEqual(limiter.take("203.0.113.8", "page"), { ok: true }, "another visitor is not affected");
  assert.deepEqual(limiter.take("203.0.113.7", "api"), { ok: true }, "buckets are counted apart");
  assert.deepEqual(limiter.take("203.0.113.7", "write"), { ok: true });
  assert.equal(limiter.take("203.0.113.7", "write").ok, false);
  now += 45_000;
  assert.deepEqual(limiter.take("203.0.113.7", "page"), { ok: false, retryAfter: 15 });
  now += 15_000;
  assert.deepEqual(limiter.take("203.0.113.7", "page"), { ok: true }, "a new window starts after the old one ends");
});

test("memory stays bounded under a flood from many addresses", () => {
  let now = 0;
  const limiter = new RateLimiter({ page: 10, api: 10, write: 10, windowMs: 60_000 }, () => now, 100);
  for (let i = 0; i < 1000; i++) limiter.take(`198.51.100.${i % 250}-${i}`, "page");
  assert.ok(limiter.size <= 101, `tracked ${limiter.size}`);
  now += 60_000;
  limiter.take("192.0.2.1", "page");
  assert.ok(limiter.size <= 101);
});

test("build files are not counted; writes of any kind are; pages and api reads apart", () => {
  assert.equal(bucketFor("GET", "/assets/app-1a2b.js", false, true), null);
  assert.equal(bucketFor("GET", "/", false, false), "page");
  assert.equal(bucketFor("GET", "/items/abc.data", false, false), "page");
  assert.equal(bucketFor("GET", "/api/site/news", true, false), "api");
  assert.equal(bucketFor("POST", "/api/site/visit", true, false), "write");
  assert.equal(bucketFor("POST", "/assets/x.js", false, true), "write", "a write to a file path is still a write");
});

test("the visitor address: the proxy's record only when trusted; private addresses are never limited", () => {
  assert.deepEqual(clientAddress(request("172.18.0.5", "203.0.113.9"), true), { address: "203.0.113.9", distinct: true });
  assert.deepEqual(
    clientAddress(request("172.18.0.5", "198.51.100.1, 203.0.113.9"), true),
    { address: "203.0.113.9", distinct: true },
    "only the entry the proxy itself appended counts; a visitor cannot prepend a fake one",
  );
  assert.deepEqual(clientAddress(request("172.18.0.5", "203.0.113.9"), false), { address: "172.18.0.5", distinct: false }, "untrusted header ignored");
  assert.deepEqual(clientAddress(request("203.0.113.10"), false), { address: "203.0.113.10", distinct: true }, "directly exposed");
  assert.equal(clientAddress(request("::ffff:127.0.0.1"), false).distinct, false);
  assert.equal(clientAddress(request("172.18.0.5", "10.0.0.4"), true).distinct, false, "the server's own checks through the proxy");
  assert.equal(clientAddress(request("172.18.0.5", "::1"), true).distinct, false);
  assert.equal(clientAddress(request("172.18.0.5", "2001:db8::1"), true).distinct, true);
});

test("limits come from the environment and can be switched off", () => {
  assert.deepEqual(guardLimits({}), { page: 240, api: 600, write: 30, windowMs: 60_000 });
  assert.deepEqual(guardLimits({ RATE_LIMIT_PAGE: "5", RATE_LIMIT_WRITE: "x" }), { page: 5, api: 600, write: 30, windowMs: 60_000 });
  assert.equal(guardLimits({ RATE_LIMIT: "off" }), null);
});

test("HSTS only for an https site, without forcing other hosts under the domain", () => {
  assert.equal(securityHeaders("https://example.com")["Strict-Transport-Security"], "max-age=31536000");
  assert.equal(securityHeaders("http://localhost:3000")["Strict-Transport-Security"], undefined);
  assert.equal(securityHeaders(undefined)["X-Frame-Options"], "DENY");
});

// The real server: the guard runs before routing, on pages, api proxying and refusals alike.
let web: ChildProcess;
let origin = "";
let logs = "";
let apiHits = 0;
const api = createServer((_req, res) => {
  apiHits += 1;
  res.setHeader("Content-Type", "application/json");
  res.end("{}");
});

before(async () => {
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  web = spawn(process.execPath, [fileURLToPath(new URL("../server.ts", import.meta.url))], {
    env: webEnvironment({
      ...process.env,
      WEB_PORT: "0",
      SITE_URL: "https://example.com",
      PRIVATE_HOST: "private.localhost",
      TRUST_PROXY: "true",
      RATE_LIMIT_PAGE: "2",
      RATE_LIMIT_API: "3",
      RATE_LIMIT_WRITE: "1",
      API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`web did not start: ${logs}`)), 15_000);
    web.on("exit", () => reject(new Error(`web exited: ${logs}`)));
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
  web?.kill();
  api.close();
});

const get = (path: string, visitor: string, init: RequestInit = {}) =>
  fetch(`${origin}${path}`, { ...init, headers: { host: "example.com", "x-forwarded-for": visitor, ...(init.headers ?? {}) }, redirect: "manual" });

test("over its api limit a visitor gets 429 with Retry-After and the api is not reached; others still pass", async () => {
  const before = apiHits;
  const answers = [];
  for (let i = 0; i < 4; i++) answers.push(await get("/api/site/news", "203.0.113.20"));
  assert.deepEqual(
    answers.map((r) => r.status),
    [200, 200, 200, 429],
  );
  const refused = answers[3]!;
  assert.ok(Number(refused.headers.get("retry-after")) >= 1);
  assert.equal(refused.headers.get("cache-control"), "private, no-store");
  assert.equal(apiHits - before, 3, "the refused request never reached the api");
  assert.equal((await get("/api/site/news", "203.0.113.21")).status, 200, "another visitor passes");
  assert.equal((await get("/api/site/news", "10.0.0.4")).status, 200, "the server's own checks are not limited");
});

test("writes have their own tighter limit", async () => {
  const first = await get("/api/site/visit", "203.0.113.30", { method: "POST", body: "{}" });
  const second = await get("/api/site/visit", "203.0.113.30", { method: "POST", body: "{}" });
  assert.notEqual(first.status, 429);
  assert.equal(second.status, 429);
});

test("every response carries the security headers, refusals included; oversized URLs are refused", async () => {
  for (const response of [await get("/api/site/news", "203.0.113.40"), await get(`/?q=${"a".repeat(9000)}`, "203.0.113.41")]) {
    assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.match(response.headers.get("permissions-policy") ?? "", /camera=\(\)/);
    assert.equal(response.headers.get("x-frame-options"), "DENY");
  }
  assert.equal((await get(`/?q=${"a".repeat(9000)}`, "203.0.113.42")).status, 414);
});
