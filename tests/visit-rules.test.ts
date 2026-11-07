// First-party visit statistics rules (TASK-0571): what counts as a reader page view, how a page is grouped, the
// referring host, the device class and the anonymous visitor key. No database.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ModulePage } from "@amp/contracts/modules";
import { MODULES } from "@amp/site/modules";
import { deviceClass, isBot, isPrefetch, monthOf, readerPage, referrerHost, visitorKey } from "../modules/site-admin/backend/visit-rules.ts";

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const ANDROID_TABLET = "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const WECHAT = `${IPHONE} MicroMessenger/8.0.50(0x18003231) NetType/WIFI Language/zh_CN`;

test("crawlers, scripts and headless browsers are not readers; real browsers are", () => {
  for (const ua of [
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)",
    "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    "Mozilla/5.0 (compatible; Yahoo! Slurp; http://help.yahoo.com/help/us/ysearch/slurp)",
    "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)",
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
    "Mozilla/5.0 (compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)",
    "Site24x7 monitor",
    "Mozilla/5.0 (Windows NT 10.0) Chrome-Lighthouse",
    "curl/8.5.0",
    "Wget/1.21",
    "python-requests/2.32.3",
    "Go-http-client/2.0",
    "Java/17.0.2",
    "okhttp/4.12.0",
    "axios/1.7.2",
    "node-fetch/1.0",
    "",
    "   ",
  ])
    assert.equal(isBot(ua), true, ua);
  for (const ua of [CHROME, IPHONE, ANDROID, ANDROID_TABLET, IPAD, WECHAT]) assert.equal(isBot(ua), false, ua);
});

test("prefetched and prerendered fetches are not page views", () => {
  assert.equal(isPrefetch({ "sec-purpose": "prefetch" }), true);
  assert.equal(isPrefetch({ "sec-purpose": "prefetch;prerender" }), true);
  assert.equal(isPrefetch({ purpose: "prefetch" }), true);
  assert.equal(isPrefetch({ "x-moz": "prefetch" }), true);
  assert.equal(isPrefetch({}), false);
  assert.equal(isPrefetch({ "sec-purpose": "" }), false);
});

test("reader routes are grouped by pattern; content pages keep their own address; the rest is not a reader page", () => {
  assert.deepEqual(readerPage("/"), { route: "/", path: "/", english: false });
  assert.deepEqual(readerPage("/en"), { route: "/", path: "/", english: true });
  assert.deepEqual(readerPage("/all?q=lithium&jurisdiction=AR#top"), { route: "/all", path: "/all", english: false });
  assert.deepEqual(readerPage("/en/all/"), { route: "/all", path: "/all", english: true });
  assert.deepEqual(readerPage("/items/abc_123"), { route: "/items/:id", path: "/items/abc_123", english: false });
  assert.deepEqual(readerPage("/en/items/abc_123?ref=x"), { route: "/items/:id", path: "/items/abc_123", english: true });
  assert.deepEqual(readerPage("/items/abc_123/original"), { route: "/items/:id/original", path: "/items/:id/original", english: false });
  assert.deepEqual(readerPage("/story/s-42"), { route: "/story/:id", path: "/story/s-42", english: false });
  assert.deepEqual(readerPage("/daily/archive"), { route: "/daily/archive", path: "/daily/archive", english: false });
  assert.deepEqual(readerPage("/daily/2026-11-06"), { route: "/daily/:key", path: "/daily/2026-11-06", english: false });
  assert.deepEqual(readerPage("/topics/lithium/page/3"), { route: "/topics/:slug/page/:page", path: "/topics/:slug/page/:page", english: false });
  assert.deepEqual(readerPage("/topics/%E9%94%82"), { route: "/topics/:slug", path: "/topics/锂", english: false });
  assert.deepEqual(readerPage("/policies/reports"), { route: "/policies/reports", path: "/policies/reports", english: false });
  assert.deepEqual(readerPage("/policies/reports/w-2026-45"), { route: "/policies/reports/:id", path: "/policies/reports/w-2026-45", english: false });
  assert.deepEqual(readerPage("/policies/p-1/history"), { route: "/policies/:id/history", path: "/policies/:id/history", english: false });
  assert.deepEqual(readerPage("/policy-threads/t-9"), { route: "/policy-threads/:id", path: "/policy-threads/t-9", english: false });
  for (const path of [
    "/admin",
    "/admin/visits",
    "/ADMIN/sources",
    "/en/admin",
    "/api/site/meta",
    "/api/health",
    "/assets/app-1a2b.js",
    "/favicon.ico",
    "/robots.txt",
    "/feed.xml",
    "/og/pages/privacy.png",
    "/no-such-page",
    "/items",
    "/items/a/b/c",
    "/items/<script>",
    "/items/%E0%A4%A",
    "//evil.example/items/x",
    "items/x",
    `/items/${"x".repeat(121)}`,
    "",
  ])
    assert.equal(readerPage(path), null, path);
});

test("every public reader route, Chinese and English, is counted under its own pattern; no private page is", () => {
  const routes = readFileSync(new URL("../apps/web/app/routes.ts", import.meta.url), "utf8");
  const publicPart = routes.slice(routes.indexOf("const publicRoutes"), routes.indexOf("const privateRoutes"));
  const core = [...publicPart.matchAll(/route\(en\("([^"]+)"\)/g)].map((m) => m[1]!);
  const modulePages = MODULES.flatMap((m) => (m.pages ?? []).flatMap((p) => ("layout" in p ? p.pages : [p as ModulePage]))).map((p) => p.path);
  const adminPages = MODULES.flatMap((m) => m.adminPages ?? []).map((p) => p.path);
  assert.ok(core.length >= 20 && modulePages.length >= 6, "route list read");
  const sample = (path: string) => `/${path.replace(/:page/g, "2").replace(/:[A-Za-z]+/g, "x-1")}`;
  for (const path of ["", ...core, ...modulePages]) {
    for (const address of [sample(path), `/en${sample(path) === "/" ? "" : sample(path)}`]) {
      const page = readerPage(address);
      assert.ok(page, `not counted: ${address}`);
      assert.equal(page.route, `/${path}`.replace(/:publicId/, ":id").replace(/^\/$/, "/"), address);
      assert.equal(page.english, address.startsWith("/en"));
    }
  }
  for (const path of [...adminPages, ...[...routes.slice(routes.indexOf("const privateRoutes")).matchAll(/route\("([^"]+)"/g)].map((m) => m[1]!)])
    assert.equal(readerPage(sample(path)), null, path);
});

test("referring sites are kept as a bare host, never this site's own, never a path or query", () => {
  const own = ["aimine.example", "www.aimine.example:443"];
  assert.equal(referrerHost("https://www.baidu.com/s?wd=%E9%94%82", own), "baidu.com");
  assert.equal(referrerHost("https://News.Example.ORG/a/b?c=d#e", own), "news.example.org");
  assert.equal(referrerHost("http://t.co/abc", own), "t.co");
  assert.equal(referrerHost("https://aimine.example/items/x", own), null);
  assert.equal(referrerHost("https://www.aimine.example/", own), null);
  for (const value of [null, undefined, "", "not a url", "android-app://com.tencent.mm/", "javascript:alert(1)", "file:///etc/passwd"])
    assert.equal(referrerHost(value, own), null, String(value));
});

test("device class: phones, tablets and desktops", () => {
  assert.equal(deviceClass(IPHONE), "phone");
  assert.equal(deviceClass(ANDROID), "phone");
  assert.equal(deviceClass(WECHAT), "phone");
  assert.equal(deviceClass(IPAD), "tablet");
  assert.equal(deviceClass(ANDROID_TABLET), "tablet");
  assert.equal(deviceClass(CHROME), "desktop");
  assert.equal(deviceClass("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15"), "desktop");
});

test("a visitor key is the same for one address and browser under one salt, and unrelated under another", () => {
  const day1 = Buffer.alloc(32, 1),
    day2 = Buffer.alloc(32, 2);
  const a = visitorKey(day1, "203.0.113.7", CHROME);
  assert.match(a, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(visitorKey(day1, "203.0.113.7", CHROME), a);
  assert.notEqual(visitorKey(day1, "203.0.113.7", IPHONE), a);
  assert.notEqual(visitorKey(day1, "203.0.113.8", CHROME), a);
  assert.notEqual(visitorKey(day2, "203.0.113.7", CHROME), a);
  assert.equal(monthOf("2026-11-30"), "2026-11-01");
});
