// The run-time switch between the old reader and its rewrite (DEC-79, apps/web/reader-impl.ts). Everything server.ts
// decides around a build (security headers, limits, the private host, the final cache rule) must be the same under
// both values; what a build decides inside itself (the page policy, the cache declaration, the page-view beacon) is
// checked for the rewrite. Real production server and builds, a synthetic API on a local port, one Chromium page.
// Run after `npm run build --workspace @amp/web`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { schemas as publicSchemas } from "@amp/contracts/http/public";
import { fetchWithHost } from "../http-probe.ts";
import { securityHeaders } from "../request-guard.ts";
import { webEnvironment } from "../runtime-env.ts";
import { browserExecutable, isolateBrowser } from "./browser.ts";

const BUILD = (group: string) => fileURLToPath(new URL(`../build/${group}`, import.meta.url));
const SITE_URL = "https://example.com";
const PRIVATE_HOST = "private.localhost:8443";
const SECRET = "s3cret-origin-value-for-tests-0123456789";
const FILINGS = { icp: "京ICP备00000000号-1", publicSecurity: { text: "京公网安备00000000000000号", code: "00000000000000" }, newsLicense: null };
const TIMELINE = publicSchemas.ReportGroupedTimelineResponse.parse(
  JSON.parse(readFileSync(new URL("../../../scripts/verify/tests/fixtures/timeline-response.json", import.meta.url), "utf8")),
);

/** What the synthetic API answers; each test sets what it needs and puts it back. */
const fixture = { metaFails: false, timelineFails: false, cards: true, refreshAt: null as string | null };
const beacons: Array<{ path: string; referrer: string | null }> = [];
const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://fixture");
  if (req.method === "POST" && url.pathname === "/api/site/visit") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      beacons.push(JSON.parse(raw));
      res.statusCode = 204;
      res.end();
    });
    return;
  }
  // No cache headers: an API answer marked no-store would keep every page out of shared caches (readerPageHeaders).
  res.setHeader("content-type", "application/json");
  const fail = () => {
    res.statusCode = 500;
    res.end(JSON.stringify({ code: "internal" }));
  };
  if (url.pathname === "/api/site/meta") return fixture.metaFails ? fail() : res.end(JSON.stringify({ changelogVersion: null, filings: FILINGS }));
  if (url.pathname === "/api/site/content-version") return res.end(JSON.stringify({ version: "1", withdrawalVersion: "1" }));
  if (url.pathname === "/api/site/stats") return res.end(JSON.stringify({ selected: 1 }));
  if (url.pathname === "/api/auth/options") return res.end(JSON.stringify({ password: false, feishu: true }));
  if (url.pathname === "/api/site/timeline") {
    if (fixture.timelineFails) return fail();
    return res.end(JSON.stringify({ ...TIMELINE, cards: fixture.cards ? TIMELINE.cards : [], refreshAt: fixture.refreshAt }));
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ code: "not_found" }));
});

type Web = { origin: string; logs: () => string; stop: () => Promise<void> };
const running: Web[] = [];
async function startWeb(extra: Record<string, string>): Promise<Web> {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../server.ts", import.meta.url))], {
    env: webEnvironment({
      PATH: process.env.PATH,
      NODE_ENV: "production",
      AMP_RELEASE: "reader-impl-test",
      WEB_PORT: "0",
      WEB_HOST: "127.0.0.1",
      SITE_URL,
      PRIVATE_HOST: "private.localhost",
      // Limits apply only to a visitor the CDN names with its secret; the test's own loopback requests pass.
      TRUST_PROXY: "true",
      CLIENT_IP_HEADER: "eo-connecting-ip",
      ORIGIN_SECRET: SECRET,
      RATE_LIMIT_PAGE: "2",
      API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
      ...extra,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  const origin = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`web did not start: ${logs}`)), 15_000);
    const read = (chunk: Buffer) => {
      logs += chunk;
      const match = logs.match(/"msg":"web started","port":(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    };
    child.stdout!.on("data", read);
    child.stderr!.on("data", read);
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`web exited: ${logs}`));
    });
  });
  const web = {
    origin,
    logs: () => logs,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await once(child, "exit");
    },
  };
  running.push(web);
  return web;
}

let impls: Record<"old" | "new", Web>;
before(async () => {
  for (const group of ["public", "private", "reader"])
    assert.ok(existsSync(`${BUILD(group)}/server/index.js`), `apps/web/build/${group} is missing: run npm run build --workspace @amp/web first`);
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  impls = { old: await startWeb({}), new: await startWeb({ READER_IMPL: "new" }) };
});
after(async () => {
  for (const web of running) await web.stop();
  api.closeAllConnections();
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

const both = () => Object.entries(impls) as Array<["old" | "new", Web]>;

test("READER_IMPL picks the build; unset, empty and unreadable values serve the old reader, the last with a warning", async () => {
  const empty = await startWeb({ READER_IMPL: "" });
  const wrong = await startWeb({ READER_IMPL: "newest" });
  for (const [web, reader] of [
    [impls.old, "old"],
    [empty, "old"],
    [wrong, "old"],
    [impls.new, "new"],
  ] as const) {
    assert.match(web.logs(), new RegExp(`"msg":"web started","port":\\d+,"pid":\\d+,"reader":"${reader}"`));
    const html = await (await fetch(`${web.origin}/`)).text();
    assert.equal(html.includes('<meta name="amp-reader" content="new"/>'), reader === "new", reader);
  }
  assert.match(wrong.logs(), /READER_IMPL must be old or new; using old/);
  assert.doesNotMatch(empty.logs(), /READER_IMPL must be/);
  await empty.stop();
  await wrong.stop();
});

test("every response carries the same security headers under both values: a page, a 404 and a refusal", async () => {
  const expected = Object.entries(securityHeaders(SITE_URL));
  for (const [reader, web] of both())
    for (const [path, status] of [
      ["/", 200],
      ["/no-such-page", 404],
      [`/?q=${"a".repeat(9000)}`, 414],
    ] as const) {
      const response = await fetch(web.origin + path);
      assert.equal(response.status, status, `${reader} ${path.slice(0, 20)}`);
      for (const [name, value] of expected) assert.equal(response.headers.get(name), value, `${reader} ${path.slice(0, 20)} ${name}`);
      await response.arrayBuffer();
    }
});

test("the rewrite's pages allow exactly their inline scripts by hash, and HEAD names the policy GET does", async () => {
  for (const path of ["/", "/en", "/no-such-page"]) {
    const response = await fetch(impls.new.origin + path);
    const policy = response.headers.get("content-security-policy") ?? "";
    const html = await response.text();
    const scriptSource = policy.match(/(?:^|; )script-src ([^;]+)/)?.[1] ?? "";
    assert.doesNotMatch(policy, /'nonce-/, path);
    assert.doesNotMatch(scriptSource, /'unsafe-inline'|'unsafe-eval'|'strict-dynamic'/, path);
    for (const directive of ["object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", `form-action 'self' ${SITE_URL}`])
      assert.ok(policy.split("; ").includes(directive), `${path} ${directive}`);
    const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
      .filter(([, attributes]) => !/\bsrc=|type="application\/ld\+json"/.test(attributes!))
      .map(([, , text]) => `'sha256-${createHash("sha256").update(text!, "utf8").digest("base64")}'`);
    assert.ok(inline.length >= 2, `${path}: the theme script and the router's own`);
    assert.deepEqual(new Set(scriptSource.split(" ").filter((source) => source !== "'self'")), new Set(inline), path);
    const head = await fetch(impls.new.origin + path, { method: "HEAD" });
    assert.equal(head.headers.get("content-security-policy"), policy, path);
  }
});

test("the rewrite's home page may be shared briefly; its data, searches, errors and fallbacks never are", async () => {
  const origin = impls.new.origin;
  const cache = async (path: string) => {
    const response = await fetch(origin + path);
    await response.arrayBuffer();
    assert.equal(response.headers.get("x-amp-reader-page"), null, `${path}: the mark never leaves the server`);
    return { status: response.status, cc: response.headers.get("cache-control"), expires: response.headers.get("x-accel-expires") };
  };
  const home = await cache("/");
  assert.equal(home.status, 200);
  assert.equal(home.cc, "public, max-age=0, s-maxage=30");
  assert.match(home.expires ?? "", /^@\d+$/);
  for (const path of ["/_root.data", "/?q=lithium", "/no-such-page"]) assert.equal((await cache(path)).cc, "private, no-store", path);
  fixture.metaFails = true;
  const withoutFilings = await cache("/");
  fixture.metaFails = false;
  assert.deepEqual([withoutFilings.status, withoutFilings.cc], [200, "private, no-store"], "a footer without its numbers is not shared");
  fixture.timelineFails = true;
  const failed = await cache("/");
  fixture.timelineFails = false;
  assert.deepEqual([failed.status, failed.cc], [503, "private, no-store"]);
  // The next scheduled release in the page's scope ends the shared period early.
  fixture.refreshAt = new Date(Date.now() + 10_000).toISOString();
  const bounded = await cache("/");
  fixture.refreshAt = null;
  const seconds = Number(bounded.cc?.match(/s-maxage=(\d+)/)?.[1]);
  assert.ok(seconds > 0 && seconds <= 10, bounded.cc ?? "");
  const off = await startWeb({ READER_IMPL: "new", PAGE_CACHE_SECONDS: "0" });
  const unshared = await fetch(`${off.origin}/`);
  await unshared.arrayBuffer();
  assert.equal(unshared.headers.get("cache-control"), "private, no-store", "PAGE_CACHE_SECONDS=0 turns sharing off");
  await off.stop();
});

test("the rewrite's home page lists the featured reports as text, and says so plainly when there are none", async () => {
  const card = TIMELINE.cards[0]!;
  const html = await (await fetch(`${impls.new.origin}/`)).text();
  assert.ok(html.includes(card.item.title) && html.includes(card.item.source.name), "card title and source");
  assert.ok(html.includes(FILINGS.icp) && html.includes("https://beian.miit.gov.cn/"), "footer filing number and its official link");
  assert.doesNotMatch(html, /href="\/items\//, "no link to an item page the rewrite does not have yet");
  fixture.cards = false;
  const empty = await (await fetch(`${impls.new.origin}/`)).text();
  const english = await (await fetch(`${impls.new.origin}/en`)).text();
  fixture.cards = true;
  assert.ok(empty.includes("还没有精选内容。") && !empty.includes(card.item.title));
  assert.ok(english.includes("Nothing has been featured yet.") && english.includes('<html lang="en"'));
});

test("the private host and its policy are the same under both values; the public host has no admin", async () => {
  for (const [reader, web] of both()) {
    const login = await fetchWithHost(`${web.origin}/admin/login`, PRIVATE_HOST);
    const html = await login.text();
    assert.equal(login.status, 200, reader);
    const nonce = login.headers.get("content-security-policy")?.match(/'nonce-([^']+)'/)?.[1];
    assert.ok(nonce, reader);
    assert.match(html, new RegExp(`<script[^>]*nonce="${nonce.replace(/[+/=]/g, "\\$&")}"`), reader);
    const admin = await fetch(`${web.origin}/admin`);
    await admin.arrayBuffer();
    assert.equal(admin.status, 404, reader);
  }
});

test("a visitor over the page limit gets 429 under both values; another visitor still passes", async () => {
  for (const [reader, web] of both()) {
    const visit = async (visitor: string) => {
      const response = await fetch(`${web.origin}/`, { headers: { "eo-connecting-ip": visitor, "x-origin-auth": SECRET } });
      await response.arrayBuffer();
      return response.status;
    };
    const visitor = reader === "old" ? "203.0.113.10" : "203.0.113.11";
    assert.deepEqual([await visit(visitor), await visit(visitor), await visit(visitor)], [200, 200, 429], reader);
    assert.equal(await visit("203.0.113.99"), 200, reader);
  }
});

test("each build's hashed files are served whichever reader is chosen; private-only files never are", async () => {
  const assets = (group: string) => readdirSync(`${BUILD(group)}/client/assets`);
  const oldOnly = assets("public").find((file) => !assets("reader").includes(file) && file.endsWith(".js"))!;
  const newOnly = assets("reader").find((file) => !assets("public").includes(file) && file.endsWith(".js"))!;
  const privateOnly = assets("private").find((file) => !assets("public").includes(file) && !assets("reader").includes(file))!;
  for (const [reader, web] of both())
    for (const [file, status] of [
      [oldOnly, 200],
      [newOnly, 200],
      [privateOnly, 404],
    ] as const) {
      const response = await fetch(`${web.origin}/assets/${file}`);
      await response.arrayBuffer();
      assert.equal(response.status, status, `${reader} ${file}`);
      if (status === 200) assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
    }
});

test("in a browser the rewrite hydrates without errors, sets the theme and counts one page view; a 404 counts none", { timeout: 60_000 }, async (t) => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: browserExecutable(),
    args: ["--disable-background-networking", "--disable-component-update"],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
  const blocked = await isolateBrowser(context, [impls.new.origin]);
  const page = await context.newPage();
  const problems: string[] = [];
  const missing = new Set<string>();
  page.on("pageerror", (error) => problems.push(error.message));
  // A refused script or a failed hydration is reported as a console error; a missing file only as a failed load,
  // which is checked by address below (the synthetic API has no icons).
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) problems.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) missing.add(new URL(response.url()).pathname);
  });
  const start = beacons.length;
  await page.goto(`${impls.new.origin}/`, { waitUntil: "networkidle" });
  await expect.poll(() => beacons.length).toBe(start + 1);
  assert.deepEqual(beacons.at(-1), { path: "/", referrer: null });
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "dark");
  await page.goto(`${impls.new.origin}/no-such-page`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "这里没有内容" })).toBeVisible();
  // A page view would have been sent by now: the beacon goes out as soon as the page has hydrated.
  await page.waitForTimeout(500);
  assert.equal(beacons.length, start + 1, "a 404 is not a page view");
  assert.deepEqual(problems, []);
  assert.deepEqual(blocked, []);
  // Only the page that does not exist and the icons the API serves in production; every built file loaded.
  for (const path of missing) assert.match(path, /^\/(?:no-such-page|favicon\.ico|icon-\d+\.png|apple-icon\.png|manifest\.webmanifest)$/);
});
