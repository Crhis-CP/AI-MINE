// The request guard on the one public entry (TASK-0583): per-visitor limits, security headers on every response,
// oversized URLs refused, and the server's own checks never limited.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { webEnvironment } from "../runtime-env.ts";
import {
  bucketFor,
  buildAsset,
  clientAddress,
  clientHeaderName,
  guardLimits,
  fromOutside,
  ObserveTally,
  OriginTally,
  originEnforced,
  originSecret,
  RateLimiter,
  rateLimitObserved,
  securityHeaders,
} from "../request-guard.ts";

const SECRET = "s3cret-origin-value-for-tests-0123456789";
const sealed = { "x-origin-auth": SECRET };
const request = (remoteAddress: string, forwarded?: string, extra: Record<string, string> = {}) =>
  ({ headers: { ...(forwarded ? { "x-forwarded-for": forwarded } : {}), ...extra }, socket: { remoteAddress } }) as unknown as IncomingMessage;

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
  assert.equal(bucketFor("GET", "/feed.xml", true, buildAsset("/feed.xml")), "api", "a feed reads the database: counted (Codex review #379)");
  assert.equal(bucketFor("GET", "/sitemaps/1.xml", true, buildAsset("/sitemaps/1.xml")), "api");
  assert.equal(bucketFor("GET", "/wp-login.php", false, buildAsset("/wp-login.php")), "page", "a probe with an extension is counted");
  assert.equal(buildAsset("/assets/app-1a2b.js"), true);
  assert.equal(buildAsset("/admin/assets/app-1a2b.js"), true);
  assert.equal(buildAsset("/robots.txt"), false);
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
  assert.deepEqual(clientAddress(request("198.51.100.10", "203.0.113.9"), true), { address: "198.51.100.10", distinct: true });
  assert.deepEqual(clientAddress(request("172.18.0.5", "not-an-address"), true), { address: "172.18.0.5", distinct: false });
});

test("limiting is on only when the deployment says where the visitor address comes from (Codex review #379)", () => {
  assert.equal(guardLimits({}), null, "behind a CDN with nothing configured, the last forwarded entry is a shared edge node");
  assert.equal(guardLimits({ TRUST_PROXY: "true" }), null);
  assert.equal(guardLimits({ CLIENT_IP_HEADER: "eo-connecting-ip" }), null, "the header alone is not believed (TASK-0586)");
  assert.deepEqual(guardLimits({ CLIENT_IP_HEADER: "eo-connecting-ip", ORIGIN_SECRET: SECRET }), { page: 240, api: 600, write: 30, windowMs: 60_000 });
  assert.deepEqual(guardLimits({ RATE_LIMIT: "on", RATE_LIMIT_PAGE: "5", RATE_LIMIT_WRITE: "x" }), { page: 5, api: 600, write: 30, windowMs: 60_000 });
  assert.equal(guardLimits({ RATE_LIMIT: "off", CLIENT_IP_HEADER: "eo-connecting-ip", ORIGIN_SECRET: SECRET }), null, "off always wins");
  assert.equal(clientHeaderName({ CLIENT_IP_HEADER: " EO-Connecting-IP " }), "eo-connecting-ip");
  assert.equal(clientHeaderName({ CLIENT_IP_HEADER: "bad header" }), null);
});

test("the CDN's client-address header is believed only with the CDN's secret, from our own proxy, and must be an address", () => {
  const header = "eo-connecting-ip";
  const secret = originSecret({ ORIGIN_SECRET: SECRET });
  assert.deepEqual(clientAddress(request("172.18.0.5", "198.51.100.77", { [header]: "203.0.113.60", ...sealed }), true, header, secret), {
    address: "203.0.113.60",
    distinct: true,
  });
  assert.deepEqual(
    clientAddress(request("172.18.0.5", "198.51.100.77", { [header]: "203.0.113.60" }), true, header, secret),
    { address: "198.51.100.77", distinct: true },
    "without the secret (someone reaching the origin directly) the header is ignored: counted by the address our proxy saw (Codex 2026-11-07)",
  );
  assert.deepEqual(
    clientAddress(request("172.18.0.5", "198.51.100.77", { [header]: "203.0.113.60", "x-origin-auth": `${SECRET}x` }), true, header, secret),
    { address: "198.51.100.77", distinct: true },
    "a wrong secret is no secret",
  );
  assert.deepEqual(
    clientAddress(request("172.18.0.5", "198.51.100.77", { [header]: "203.0.113.60", ...sealed }), true, header, null),
    { address: "198.51.100.77", distinct: true },
    "no secret configured: the header is never believed",
  );
  assert.deepEqual(
    clientAddress(request("203.0.113.99", undefined, { [header]: "198.51.100.1", ...sealed }), false, header, secret),
    { address: "203.0.113.99", distinct: true },
    "a visitor connecting directly cannot name another address through the header",
  );
  assert.deepEqual(
    clientAddress(request("172.18.0.5", undefined, sealed), true, header, secret),
    { address: "172.18.0.5", distinct: false },
    "missing header: not limited",
  );
  assert.equal(clientAddress(request("172.18.0.5", undefined, { [header]: "not-an-ip", ...sealed }), true, header, secret).distinct, false);
  assert.equal(clientAddress(request("172.18.0.5", undefined, { [header]: "10.0.0.8", ...sealed }), true, header, secret).distinct, false);
});

test("the CDN's secret: long enough, a plain header name, enforcement only with a secret, and an hourly tally", () => {
  assert.equal(originSecret({ ORIGIN_SECRET: "short" }), null);
  assert.equal(originSecret({ ORIGIN_SECRET: `${SECRET} space` }), null);
  assert.equal(originSecret({ ORIGIN_SECRET: SECRET, ORIGIN_SECRET_HEADER: "bad header" }), null);
  assert.equal(originSecret({ ORIGIN_SECRET: SECRET, ORIGIN_SECRET_HEADER: " X-My-Key " })?.header, "x-my-key");
  assert.equal(
    originSecret({ ORIGIN_SECRET: SECRET, ORIGIN_SECRET_HEADER: "" })?.header,
    "x-origin-auth",
    "docker-compose passes an unset name as an empty string: the default applies (Codex review #387)",
  );
  // Behind Caddy with TRUST_PROXY=false every request has a private peer; what Caddy forwarded is still outside.
  const viaProxy = request("172.18.0.5", "203.0.113.80");
  assert.equal(fromOutside(viaProxy, clientAddress(viaProxy, false)), true, "a proxied request is outside even when the proxy is not trusted");
  const ownCheck = request("127.0.0.1");
  assert.equal(fromOutside(ownCheck, clientAddress(ownCheck, false)), false, "a direct local check is the server's own");
  assert.equal(originEnforced({ ORIGIN_ENFORCE: "on" }), false, "nothing to enforce without a secret");
  assert.equal(originEnforced({ ORIGIN_ENFORCE: "on", ORIGIN_SECRET: SECRET }), true);
  const tally = new OriginTally();
  const secret = originSecret({ ORIGIN_SECRET: SECRET });
  tally.count(request("172.18.0.5", "198.51.100.7", { "eo-connecting-ip": "203.0.113.1", ...sealed }), "eo-connecting-ip", secret, true);
  tally.count(request("172.18.0.5", "198.51.100.8"), "eo-connecting-ip", secret, true);
  tally.count(request("127.0.0.1"), "eo-connecting-ip", secret, false);
  assert.deepEqual(tally.take(), { with_secret: 1, with_client_header: 1, outside_without_secret: 1 });
  assert.deepEqual(tally.take(), { with_secret: 0, with_client_header: 0, outside_without_secret: 0 });
});

test("observe mode counts what would be refused, per bucket and visitor, and never says who (Owner 2026-11-08)", () => {
  assert.equal(rateLimitObserved({ RATE_LIMIT_OBSERVE: "on" }), true);
  assert.equal(rateLimitObserved({}), false);
  const tally = new ObserveTally();
  tally.record("203.0.113.1", "page");
  tally.record("203.0.113.1", "page");
  tally.record("203.0.113.2", "api");
  const out = tally.take();
  assert.deepEqual(out, { would_refuse_page: 2, would_refuse_api: 1, would_refuse_write: 0, visitors: 2 });
  assert.ok(!JSON.stringify(out).includes("203.0.113"), "no address is reported");
  assert.deepEqual(tally.take(), { would_refuse_page: 0, would_refuse_api: 0, would_refuse_write: 0, visitors: 0 });
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
let lastApiHeaders: Record<string, unknown> = {};
const readFailureFile = fileURLToPath(new URL("../build/public/client/assets/task0687-read-error.js", import.meta.url));
const api = createServer((req, res) => {
  apiHits += 1;
  lastApiHeaders = req.headers;
  res.setHeader("Content-Type", "application/json");
  if (req.url?.startsWith("/api/lifecycle/")) {
    api.emit("lifecycle", res);
    if (req.url.endsWith("before")) return;
    res.setHeader("Content-Type", "text/event-stream");
    res.write("data: start\n\n");
    if (req.url.endsWith("heartbeat")) {
      const beat = setInterval(() => res.write(": keepalive\n\n"), 100);
      const end = setTimeout(() => res.end("data: done\n\n"), 1500);
      res.once("close", () => {
        clearInterval(beat);
        clearTimeout(end);
      });
    }
    return;
  }
  res.end("{}");
});

before(async () => {
  await writeFile(readFailureFile, "fixture");
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const boot = `
    import assert from "node:assert/strict";
    import http from "node:http";
    import fs from "node:fs";
    import { Readable } from "node:stream";
    import { syncBuiltinESMExports } from "node:module";
    const request = http.request;
    http.request = (options, ...args) => {
      assert.equal(options.timeout, 60_000);
      return request({ ...options, timeout: options.path.startsWith("/api/lifecycle/timed-") ? 500 : options.timeout }, ...args);
    };
    const stream = fs.createReadStream;
    fs.createReadStream = (file, ...args) => String(file) === ${JSON.stringify(readFailureFile)}
      ? new Readable({ read() { this.destroy(new Error("fixture read failure")); } }) : stream(file, ...args);
    syncBuiltinESMExports();
    await import(${JSON.stringify(new URL("../server.ts", import.meta.url).href)});
  `;
  web = spawn(process.execPath, ["--input-type=module", "--eval", boot], {
    env: webEnvironment({
      ...process.env,
      WEB_PORT: "0",
      SITE_URL: "https://example.com",
      PRIVATE_HOST: "private.localhost",
      TRUST_PROXY: "true",
      CLIENT_IP_HEADER: "eo-connecting-ip",
      ORIGIN_SECRET: SECRET,
      // As docker-compose passes it when unset (Codex review #387).
      ORIGIN_SECRET_HEADER: "",
      ORIGIN_ENFORCE: "on",
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
  await unlink(readFailureFile).catch(() => {});
});

// The test connects from loopback, standing for the proxy: the CDN header names the visitor, and every request
// carries the same CDN edge node in X-Forwarded-For, which must not merge visitors.
const get = (path: string, visitor: string, init: RequestInit = {}) =>
  fetch(`${origin}${path}`, {
    ...init,
    headers: { host: "example.com", "x-forwarded-for": "198.51.100.200", "eo-connecting-ip": visitor, ...sealed, ...(init.headers ?? {}) },
    redirect: "manual",
  });

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

test("a dynamic path with an extension (a feed or sitemap) is limited like any api read", async () => {
  const answers = [];
  for (let i = 0; i < 4; i++) answers.push((await get("/sitemap.xml", "203.0.113.50")).status);
  assert.equal(answers[3], 429, `statuses ${answers.join(",")}`);
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

test("only the CDN may fetch from outside: no secret, 403; the api never sees the secret; the server's own checks pass", async () => {
  const direct = await fetch(`${origin}/api/site/news`, { headers: { host: "example.com", "x-forwarded-for": "203.0.113.70" }, redirect: "manual" });
  assert.equal(direct.status, 403, "someone reaching the origin directly");
  assert.equal(direct.headers.get("x-content-type-options"), "nosniff", "refusals carry the security headers too");
  const forged = await fetch(`${origin}/api/site/news`, {
    headers: {
      host: "example.com",
      "x-forwarded-for": "203.0.113.71",
      "eo-connecting-ip": "203.0.113.20",
      "x-origin-auth": "guess-guess-guess-guess-guess-guess",
    },
    redirect: "manual",
  });
  assert.equal(forged.status, 403, "a guessed secret is refused");
  assert.equal((await get("/api/site/news", "203.0.113.72")).status, 200);
  assert.equal(lastApiHeaders["x-origin-auth"], undefined, "the secret stays in the web process");
  assert.equal(lastApiHeaders["x-forwarded-for"], "203.0.113.72", "the api sees the visitor the CDN named");
  const own = await fetch(`${origin}/api/site/news`, { headers: { host: "example.com" }, redirect: "manual" });
  assert.equal(own.status, 200, "the server's own check from a private address");
});

test("reader departure closes the api response before and after its headers", async () => {
  for (const beforeHeaders of [true, false]) {
    const opened = once(api, "lifecycle", { signal: AbortSignal.timeout(1000) });
    const controller = new AbortController();
    const pending = get(`/api/lifecycle/cancel-${beforeHeaders ? "before" : "after"}`, beforeHeaders ? "203.0.113.80" : "203.0.113.81", {
      signal: controller.signal,
    });
    try {
      const [up] = (await opened) as [ServerResponse];
      const closed = once(up, "close", { signal: AbortSignal.timeout(1000) });
      if (!beforeHeaders) {
        const reader = (await pending).body!.getReader();
        assert.equal((await reader.read()).done, false);
        reader.releaseLock();
      }
      assert.equal(up.destroyed, false);
      controller.abort();
      if (beforeHeaders) await assert.rejects(pending);
      await closed;
    } finally {
      controller.abort();
    }
  }
});

test("idle api sockets close at either response stage while heartbeats keep a stream alive", async () => {
  for (const stage of ["before", "after", "heartbeat"]) {
    const opened = once(api, "lifecycle", { signal: AbortSignal.timeout(1000) });
    const pending = get(`/api/lifecycle/timed-${stage}`, `203.0.113.${82 + ["before", "after", "heartbeat"].indexOf(stage)}`);
    const [up] = (await opened) as [ServerResponse];
    const closed = once(up, "close", { signal: AbortSignal.timeout(3000) });
    const response = await pending;
    assert.equal(response.status, stage === "before" ? 502 : 200);
    if (stage === "after") await assert.rejects(response.text());
    else assert.match(await response.text(), stage === "before" ? /api unavailable/ : /: keepalive[\s\S]*data: done/);
    await closed;
    if (stage !== "heartbeat") assert.equal(up.destroyed, true);
  }
});

test("missing build files return plain 404 and a static read failure leaves the web process alive", async () => {
  const hits = apiHits;
  for (const [path, host, cache] of [
    ["/assets/missing.js", "example.com", "no-store"],
    ["/admin/assets/missing.js", "private.localhost", "private, no-store"],
  ]) {
    const response = await get(path!, "203.0.113.90", { headers: { host: host! } });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), cache);
    assert.equal(await response.text(), "Not found");
  }
  assert.equal(apiHits, hits);
  await assert.rejects(get("/assets/task0687-read-error.js", "203.0.113.91").then((response) => response.arrayBuffer()));
  assert.equal((await get("/api/site/news", "203.0.113.92")).status, 200);
  assert.equal(web.exitCode, null);
});
