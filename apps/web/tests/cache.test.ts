// Run after `npm run build -w @amp/web`. Real production server/router, synthetic HTTP API only.
import { SITE } from "@amp/industry/site";
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
let reconciliationUnavailable = false;
let poolMode: "ok" | "busy" | "bad" | "missing" | "empty" = "ok";
let timelineMode: "empty" | "ok" | "bad" | "busy" | "missing" | "invalid" = "empty";
const timelineCalls: Array<{ path: string; accept: string | undefined; ssr: string | undefined }> = [];
const timeline = publicSchemas.TimelineResponse.parse(
  JSON.parse(readFileSync(new URL("../../../scripts/verify/tests/fixtures/timeline-response.json", import.meta.url), "utf8")),
);
const poolCalls: Array<{ path: string; accept: string | undefined; ssr: string | undefined }> = [];
/** A detail page that renders (the phone footer test reads it). */
const footerItem = {
  id: "footer-page",
  title: "合成详情页",
  summary: "合成摘要",
  reason: null,
  source: { id: "synthetic", name: "合成来源", kind: "web_list", firstParty: true },
  publishedAt: "2026-10-04T02:00:00Z",
  timelineAt: "2026-10-04T02:00:00Z",
  category: null,
  tags: [],
  score: null,
  selected: false,
  channel: "news",
  revision: 1,
  originalTitle: null,
  links: { original: "https://source.invalid/a/1" },
  discoveredAt: "2026-10-04T02:00:00Z",
  story: null,
  readingMode: "summary-only",
  author: null,
  language: "zh-CN",
  body: null,
  outline: [],
  relatedStories: [],
  indexable: false,
  group: null,
  hasTranslation: false,
  bodyLanguage: "zh",
};
let priceMode: "full" | "stale" | "partial" | "empty" | "error" = "full";
let policyMode: "full" | "empty" | "error" | "withdrawn" | "reading_error" | "revision" = "full";
const policyFixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../tests/fixtures/policy-public/${name}.json`, import.meta.url), "utf8"));
function syntheticPrices() {
  const period = { start: "2026-09-11", end: "2026-09-20", label: "合成报价期" };
  const q = (key: string, source: string, value: string | null, percent: string | null, decimals: number | null = null) => ({
    key,
    source,
    title: `合成报价 ${key} · 最后一段`,
    spec: key === "a" ? "合成规格" : null,
    footnote: key === "a" ? 1 : null,
    value,
    unit: "合成单位",
    currency: "CNY",
    decimals,
    period: value ? period : null,
    change: percent ? { percent, previous: { value: "100.0", period } } : null,
  });
  const data = publicSchemas.MetalPrices.parse({
    generatedAt: "2026-10-06T04:00:00Z",
    intro: "合成价格测试导语",
    sources: ["甲", "乙"].map((tag) => ({
      key: tag,
      name: `合成来源${tag}`,
      tag,
      status: "fresh",
      latest: { label: "合成报价期", release: { label: "合成发布", url: "https://source.invalid/release", date: null } },
    })),
    latest: [
      { tag: "甲", label: "合成新期", stale: false, extras: [{ metals: ["合成乙"], label: "合成旧期", stale: false }] },
      { tag: "乙", label: "合成新期", stale: false, extras: [] },
    ],
    metals: [
      { key: "first", name: "合成甲", quotes: [q("a", "甲", "108770.0", "1.0"), q("b", "乙", "64.599999999999994", "-1.6", 2)] },
      { key: "second", name: "合成乙", quotes: [q("c", "甲", "200.0", "0.0"), q("d", "乙", null, null)] },
    ],
    notes: [
      { ref: 1, text: "合成脚注见{link}。", link: { name: "合成许可", url: "https://source.invalid/license" } },
      { ref: null, text: "合成普通说明", link: null },
    ],
    officialLinks: ["甲", "乙"].map((name, i) => ({ name: `合成官方入口${name}`, note: `合成入口说明${name}`, url: `https://source.invalid/official-${i}` })),
  });
  if (priceMode === "stale") {
    data.sources[0]!.status = "stale";
    data.latest[0]!.stale = true;
  }
  if (priceMode === "empty" || priceMode === "partial") {
    const stopped = new Set(priceMode === "empty" ? data.sources.map((source) => source.key) : ["乙"]);
    for (const source of data.sources)
      if (stopped.has(source.key)) {
        source.status = "empty";
        source.latest = null;
      }
    for (const latest of data.latest)
      if (stopped.has(latest.tag)) {
        latest.label = null;
        latest.stale = false;
        latest.extras = [];
      }
    for (const metal of data.metals)
      for (const quote of metal.quotes)
        if (stopped.has(quote.source)) {
          quote.value = null;
          quote.period = null;
          quote.change = null;
        }
  }
  return publicSchemas.MetalPrices.parse(data);
}

const siteInformationFixture = publicSchemas.SiteInformation.parse({
  revision: 1,
  updatedAt: "2026-10-09T00:00:00Z",
  about: "合成网站资料介绍",
  contactEmail: null,
  contactPage: null,
  metalLinks: [{ name: "合成官方入口", url: "https://source.invalid/metals", note: "合成说明" }],
});
const protectedSiteFixture = {
  siteUrl: "https://public.preview.test",
  siteUrlOrigin: "runtime",
  icp: { configured: true, origin: "build", footerDisplayed: true, aboutDisplayed: false },
  publicSecurity: { configured: false, origin: "not_recorded", footerDisplayed: false, aboutDisplayed: false },
  newsLicense: { configured: false, origin: "not_recorded", footerDisplayed: false, aboutDisplayed: false },
  newsLicenseValidUntil: null,
  newsLicenseDateState: "not_recorded",
  remainingDays: null,
  warningDays: 60,
  productionFilingConfigured: false,
};

const apiCookies: Array<string | undefined> = [];
const privateCookies: Array<string | undefined> = [];
const privateCalls: Array<{ path: string; forwarded: string | undefined }> = [];
const privateApi = createServer((req, res) => {
  privateCookies.push(req.headers.cookie);
  privateCalls.push({ path: req.url!, forwarded: req.headers["x-forwarded-host"] as string | undefined });
  res.setHeader("Content-Type", "application/json");
  if (req.url!.split("?", 1)[0] === "/api/auth/options") return res.end(JSON.stringify({ password: false, feishu: true }));
  if (req.url!.startsWith("/api/admin/echo")) return res.end(JSON.stringify({ target: "private", path: req.url, forwarded: req.headers["x-forwarded-host"] }));
  if (privatePageFixtures) {
    if (req.url === "/api/admin/site") return res.end(JSON.stringify({ information: siteInformationFixture, protected: protectedSiteFixture }));
    if (req.url === "/api/admin/me") return res.end(JSON.stringify({ name: "合成管理员", csrf: "test-csrf", dev: false }));
    if (req.url === "/api/admin/nav-counts") return res.end(JSON.stringify({ sources: 888, feedback: 888, runs: 888 }));
    if (req.url?.startsWith("/api/admin/models?"))
      return res.end(
        JSON.stringify({
          days: Number(new URL(req.url, "http://fixture").searchParams.get("days") || 7),
          capabilities: [],
          choices: [],
          history: [],
          benches: [{ id: "old-bench", label: "旧对比记录" }],
        }),
      );
    if (req.url === "/api/admin/settings") return res.end(JSON.stringify({ targets: [], budgets: [] }));
    if (req.url === "/api/admin/runs") {
      if (reconciliationUnavailable) {
        res.statusCode = 503;
        return res.end(JSON.stringify({ detail: "synthetic unavailable" }));
      }
      return res.end(
        JSON.stringify({
          processes: [{ host: "NEVER_SERIALIZE_PROCESS" }],
          queues: [{ name: "NEVER_SERIALIZE_QUEUE" }],
          timeline: ["NEVER_SERIALIZE_TIMELINE"],
          receipts: {
            counts: { unknown: 1 },
            issues: [
              {
                id: 701,
                status: "unknown",
                service: "fixture",
                model: "demo",
                purpose: "score_article",
                subject: "article:synthetic@1",
                error: "结果待核实",
                attempts: 1,
                updated_at: "2026-10-04T00:00:00.000Z",
                version: `rv1:${"1".repeat(64)}`,
                request: "NEVER_SERIALIZE_RECEIPT",
              },
            ],
          },
          deliveries: [
            {
              id: 702,
              target_key: "合成通知目的地",
              status: "unknown",
              subject_kind: "selected",
              subject_id: "test-material",
              updated_at: "2026-10-04T00:00:00Z",
              response: "NEVER_SERIALIZE_DELIVERY",
            },
          ],
        }),
      );
    }
  }
  res.statusCode = 401;
  res.end(JSON.stringify({ code: "unauthorized" }));
});
const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://api.local");
  apiCookies.push(req.headers.cookie);
  res.setHeader("Content-Type", "application/json");
  if (url.pathname.startsWith("/api/site/policies")) {
    const send = (body: unknown, status = 200) => {
      res.statusCode = status;
      return res.end(JSON.stringify(body));
    };
    if (policyMode === "error") return send({ code: "temporarily_unavailable" }, 503);
    if (url.pathname.endsWith("/scope")) return send(policyFixture("scope"));
    if (url.pathname === "/api/site/policies/reports") return send(policyFixture("report-list"));
    if (url.pathname === "/api/site/policies/reports/report-fixture") return send(policyFixture("report"));
    if (url.pathname === "/api/site/policies") {
      const list = policyFixture("list");
      if (policyMode === "empty") {
        list.items = [];
        list.total = 0;
      }
      return send(list);
    }
    if (policyMode === "withdrawn") return send({ code: "not_found" }, 404);
    if (url.pathname.endsWith("/history")) return send(policyFixture("history"));
    if (url.pathname.endsWith("/reading")) {
      if (url.searchParams.get("cursor")?.startsWith("next:") && ["reading_error", "revision"].includes(policyMode))
        return send({ code: "revision_changed" }, policyMode === "revision" ? 409 : 503);
      const page = policyFixture("reading"),
        original = url.searchParams.get("expression_id") === "expression-en";
      if (original) {
        page.expression_id = "expression-en";
        page.document_revision_id = "revision-en";
        page.language = "en";
        page.mode = "original";
        page.blocks[0].text = "Synthetic original clause one";
      }
      const cursor = url.searchParams.get("cursor"),
        binding = `${page.expression_id}:${page.document_revision_id}`;
      if (cursor !== `init:${binding}` && cursor !== `next:${binding}`) return send({ code: "revision_changed" }, 409);
      const next = cursor.startsWith("next:");
      page.blocks = page.blocks.slice(next ? 1 : 0, next ? 2 : 1);
      page.next_cursor = next ? null : `next:${binding}`;
      return send(page);
    }
    const policy = policyFixture(url.pathname.endsWith("/policy-fixture") ? "basic-facts" : "complete");
    if (url.searchParams.get("expression_id") === "expression-en") {
      policy.selected_expression_id = "expression-en";
      policy.reading.expression_id = "expression-en";
      policy.reading.document_revision_id = "revision-en";
      policy.reading.language = "en";
      policy.reading.mode = "original";
    }
    if (policy.reading) policy.reading.next_cursor = `init:${policy.reading.expression_id}:${policy.reading.document_revision_id}`;
    return send(policy);
  }
  if (url.pathname === "/api/site/metal-prices") {
    if (priceMode === "error") {
      res.statusCode = 503;
      return res.end(JSON.stringify({ code: "temporarily_unavailable" }));
    }
    return res.end(JSON.stringify(syntheticPrices()));
  }
  if (url.pathname === "/api/site/information") return res.end(JSON.stringify(siteInformationFixture));
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
        items: (poolMode === "empty" ? [] : [0]).map(() => ({
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
        })),
        page: Number(url.searchParams.get("page") || 1),
        pageCount: poolMode === "empty" ? 0 : 3,
        total: poolMode === "empty" ? 0 : 81,
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
  if (url.pathname === "/api/site/items/footer-page") return res.end(JSON.stringify(footerItem));
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
      SITE_URL: process.env.SITE_URL || "http://localhost:3000",
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

test("INV-34 public, missing and private pages authorize only this response's nonce", async () => {
  for (const pathname of ["/", "/all", "/about", "/items/footer-page", "/does-not-exist", "/admin/login"]) {
    const get = (method = "GET") =>
      pathname.startsWith("/admin") ? fetchWithHost(origin + pathname, PRIVATE_HOST, { method }) : fetch(origin + pathname, { method });
    const response = await get();
    assert.equal(response.status, pathname === "/does-not-exist" ? 404 : 200, pathname);
    const policy = response.headers.get("Content-Security-Policy") ?? "";
    const scriptSource = policy.match(/(?:^|; )script-src ([^;]+)/)?.[1] ?? "";
    const nonce = scriptSource.match(/'nonce-([^']+)'/)?.[1];
    assert.ok(nonce, pathname);
    assert.equal(Buffer.from(nonce, "base64").byteLength, 16);
    assert.doesNotMatch(scriptSource, /'unsafe-inline'|'unsafe-eval'/);
    for (const directive of ["object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) assert.ok(policy.includes(directive), pathname);
    if (pathname.startsWith("/admin")) {
      const siteOrigin = new URL(process.env.SITE_URL || "http://localhost:3000").origin;
      assert.ok(policy.split("; ").includes(`form-action 'self' ${siteOrigin}`));
    }
    const scripts = [...(await response.text()).matchAll(/<script\b([^>]*)>/g)].filter((match) => !/type="application\/ld\+json"/.test(match[1]!));
    assert.ok(scripts.length > 0, pathname);
    for (const [, attributes] of scripts) assert.equal(attributes!.match(/\bnonce="([^"]+)"/)?.[1], nonce, pathname);
    const next = await get();
    const nextNonce = next.headers.get("Content-Security-Policy")?.match(/'nonce-([^']+)'/)?.[1];
    assert.ok(nextNonce, pathname);
    assert.notEqual(nextNonce, nonce, pathname);
    await next.arrayBuffer();
    const head = await get("HEAD");
    assert.match(head.headers.get("Content-Security-Policy") ?? "", /'nonce-[^']+'/);
    assert.equal(await head.text(), "");
  }
});

test("every public page carries the ICP filing number in the phone footer; the 更多 page keeps its own", async () => {
  const icp = SITE.icp!;
  assert.ok(icp, "the filing number is on file");
  const phoneFooters = (html: string) => html.match(/<footer[^>]*lg:hidden[^>]*>[\s\S]*?<\/footer>/g) ?? [];
  for (const path of ["/", "/all", "/about", "/items/footer-page"]) {
    const res = await fetch(origin + path);
    assert.equal(res.status, 200, path);
    const footers = phoneFooters(await res.text());
    assert.equal(footers.length, 1, path);
    assert.ok(footers[0]!.includes(icp), path);
  }
  // Error pages are pages too: a missing item and an address no route matches show the reader shell's 404.
  for (const path of ["/items/missing", "/does-not-exist"]) {
    const res = await fetch(origin + path);
    assert.equal(res.status, 404, path);
    assert.match(res.headers.get("Content-Type") ?? "", /text\/html/, path);
    const html = await res.text();
    assert.ok(html.includes("这里没有内容"), path);
    const footers = phoneFooters(html);
    assert.equal(footers.length, 1, path);
    assert.ok(footers[0]!.includes(icp), path);
  }
  const slash = await fetch(`${origin}/more/`, { redirect: "manual" });
  assert.equal(slash.status, 301);
  assert.equal(new URL(slash.headers.get("Location")!, origin).pathname, "/more");
  await slash.text();
  const more = await (await fetch(`${origin}/more`)).text();
  assert.equal(phoneFooters(more).length, 0, "the 更多 page has its own footer instead");
  assert.equal(more.split(icp).length - 1, 2, "once in the sidebar, once in the 更多 page's own footer");
});

test("HTML and navigation share freshness; cookies do not personalize public results", async () => {
  const html = await fetch(`${origin}/`);
  assert.equal(html.status, 200);
  assert.equal(html.headers.get("X-Accel-Expires"), `@${deadline}`);
  assert.match(await html.text(), /精选/);
  const plain = await fetch(`${origin}/about.data`);
  const signedIn = await fetch(`${origin}/about.data?_routes=root`, { headers: { cookie: "admin_session=private; amp_vid=reader" } });
  assert.equal(plain.headers.get("Cache-Control"), "no-cache", "editable about material must be revalidated after saving");
  assert.equal(plain.headers.get("X-Accel-Expires"), "0");
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
    const empty = await fetch(`${origin}/?category=${category}`);
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

/** Each 筛选 tab row on a page, as its links' attributes and visible text. */
function filterTabs(html: string) {
  return [...html.matchAll(/<nav[^>]*aria-label="筛选"[^>]*>([\s\S]*?)<\/nav>/g)].map((row) =>
    [...(row[1] ?? "").matchAll(/<a([^>]*)>([\s\S]*?)<\/a>/g)].map((link) => ({
      attrs: link[1] ?? "",
      text: (link[2] ?? "").replace(/<[^>]+>/g, "").trim(),
    })),
  );
}

test("until the first pick exists the unfiltered home page shows the newest items of 全部动态", async () => {
  const notice = /精选还没开始，先看最新动态。/;
  const noPicks = /暂时没有符合条件的精选[\s\S]*当前可在全部矿业动态中阅读已收录资讯。[\s\S]*href="\/all"/;
  const category = CATEGORY_KEYS.at(-1)!;
  try {
    timelineMode = "empty";
    let before = poolCalls.length;
    const home = await fetch(`${origin}/`);
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, notice);
    assert.match(html, /真实列表消费者/);
    assert.match(html, /href="\/all\?page=2"/);
    assert.deepEqual(poolCalls.slice(before), [{ path: "/api/site/pool", accept: "application/json", ssr: "1" }]);
    assert.equal(home.headers.get("X-Accel-Expires"), `@${deadline}`);
    // “全部” stays on the home page (the current page); the other tabs lead to 全部动态.
    const rows = filterTabs(html);
    assert.ok(rows.length > 0);
    for (const links of rows) {
      const all = links.find((link) => link.text === "全部")?.attrs ?? "";
      assert.match(all, /href="\/"/);
      assert.match(all, /aria-current="page"/);
      assert.ok(links.some((link) => link.attrs.includes(`href="/all?category=${category}"`)));
      assert.ok(!links.some((link) => link.attrs.includes('href="/?')));
    }
    // Any filter (category, tag or channel) keeps the picks feed and does not read 全部动态.
    for (const query of [`category=${category}`, "tag=%E9%93%9C", "channel=news"]) {
      before = poolCalls.length;
      const filtered = await fetch(`${origin}/?${query}`);
      assert.equal(filtered.status, 200, query);
      const body = await filtered.text();
      assert.doesNotMatch(body, notice, query);
      assert.match(body, /这个筛选下还没有精选内容/, query);
      assert.equal(poolCalls.length, before, query);
    }
    // 全部动态 empty: the picks empty state of DR-85, cached as usual.
    poolMode = "empty";
    const empty = await fetch(`${origin}/`);
    assert.equal(empty.status, 200);
    const emptyBody = await empty.text();
    assert.doesNotMatch(emptyBody, notice);
    assert.match(emptyBody, noPicks);
    assert.equal(empty.headers.get("X-Accel-Expires"), `@${deadline}`);
    // 全部动态 unreadable or unusable: the same empty state, and nothing is cached so the next request reads again.
    for (const mode of ["busy", "bad"] as const) {
      poolMode = mode;
      const failed = await fetch(`${origin}/`);
      assert.equal(failed.status, 200, mode);
      const body = await failed.text();
      assert.doesNotMatch(body, notice, mode);
      assert.match(body, noPicks, mode);
      assert.equal(failed.headers.get("Cache-Control"), "no-cache", mode);
      assert.equal(failed.headers.get("X-Accel-Expires"), "0", mode);
    }
    poolMode = "ok";
    // Once a pick exists the home page is the picks feed again.
    timelineMode = "ok";
    before = poolCalls.length;
    const picks = await (await fetch(`${origin}/`)).text();
    assert.match(picks, /真实精选消费者/);
    assert.doesNotMatch(picks, notice);
    assert.doesNotMatch(picks, /暂时没有符合条件的精选/);
    assert.equal(poolCalls.length, before);
    // …and its tabs filter the picks again.
    const pickRows = filterTabs(picks);
    assert.ok(pickRows.length > 0);
    for (const links of pickRows) {
      assert.match(links.find((link) => link.text === "全部")?.attrs ?? "", /href="\/"/);
      assert.ok(links.some((link) => link.attrs.includes(`href="/?category=${category}"`)));
    }
  } finally {
    poolMode = "ok";
    timelineMode = "empty";
  }
});

test("金属价格 renders registry-driven quotes, exact decimal text, footnotes and all five states", async () => {
  priceMode = "full";
  const res = await fetch(`${origin}/metals`),
    html = await res.text();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=300, s-maxage=300, must-revalidate");
  const table = html.slice(html.indexOf("<table"), html.indexOf("</table>"));
  const text = table.replace(/<[^>]+>/g, "");
  assert.match(text, /品种报价价格较上期规格/);
  assert.match(table, /scope="rowgroup" rowspan="2"/i);
  for (const value of ["合成甲", "合成乙", "合成报价 a", "甲", "乙", "合成规格", "108,770.0", "64.60", "+1.0%", "−1.6%", "0.0%", "暂缺"])
    assert.ok(text.includes(value), value);
  assert.match(table, /text-hot[^>]*>\+1.0%/);
  assert.match(table, /text-ok[^>]*>−1.6%/);
  assert.match(table, /text-ink-3[^>]*>0.0%/);
  assert.doesNotMatch(table, /2026-|合成报价期/);
  assert.match(html, /href="#n1"[^>]*aria-label="见说明第 1 条"/);
  assert.match(html, /id="n1"/);
  assert.match(html, /href="https:\/\/source.invalid\/license"[^>]*target="_blank"/);
  assert.ok(html.includes("合成旧期") && html.includes("合成普通说明"));
  assert.ok(!html.slice(html.indexOf("data-metals"), html.indexOf("</article>")).includes("{link}"));
  const links = [...html.matchAll(/<a href="(https:\/\/source.invalid\/official-\d+)"[^>]*>([\s\S]*?)<\/a>/g)];
  assert.equal(links.length, syntheticPrices().officialLinks.length);
  for (const [, url, label] of links) {
    const link = syntheticPrices().officialLinks.find((link) => link.url === url)!;
    assert.ok(label!.includes(link.name));
    assert.ok(!label!.includes(link.note));
  }
  try {
    for (const mode of ["stale", "partial", "empty", "error"] as const) {
      priceMode = mode;
      const response = await fetch(`${origin}/metals`),
        body = await response.text();
      assert.equal(response.status, mode === "error" ? 503 : 200);
      if (mode === "stale") {
        assert.ok(body.includes("数据已陈旧"));
        assert.ok(body.includes("108,770.0"));
      }
      if (mode === "partial") {
        assert.ok(body.includes("暂无已授权价格数据"));
        assert.ok(body.includes("暂缺"));
        assert.ok(body.includes("108,770.0"));
      }
      if (mode === "empty") {
        assert.ok(body.includes("暂无已授权价格数据"));
        assert.doesNotMatch(body, /<table|id="metals-notes"/);
        assert.ok(body.includes("合成官方入口甲"));
      }
      if (mode === "error") {
        assert.match(response.headers.get("Cache-Control") ?? "", /no-store/);
        assert.ok(body.includes("价格数据暂时无法读取"));
        assert.doesNotMatch(body, /<table|暂无已授权价格数据|合成价格测试导语|合成官方入口/);
      }
    }
  } finally {
    priceMode = "full";
  }
  // Desktop sidebar entry; on phones the bottom bar keeps “更多” highlighted.
  assert.match(html, /<aside[\s\S]*href="\/metals"[\s\S]*<\/aside>/);
  const tabbar = html.slice(html.indexOf('aria-label="底部导航"'));
  assert.match(tabbar.slice(0, tabbar.indexOf("</nav>")), /<a[^>]*aria-current="page"[^>]*href="\/more"|<a[^>]*href="\/more"[^>]*aria-current="page"/);
  // The “更多” page lists it in its own body, not only through the sidebar.
  const more = await (await fetch(`${origin}/more`)).text();
  const body = more.slice(more.indexOf('id="main"'), more.indexOf('aria-label="底部导航"'));
  assert.match(body, /href="\/metals"[^>]*>[\s\S]{0,400}金属价格/);
  // Right below 收藏, in the sidebar and on the “更多” page (Owner 2026-10-05).
  const hrefs = (s: string) => [...s.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  for (const links of [hrefs(html.slice(html.indexOf("<aside"), html.indexOf("</aside>"))), hrefs(body)]) {
    assert.ok(links.includes("/starred"), links.join(" "));
    assert.equal(links[links.indexOf("/starred") + 1], "/metals", links.join(" "));
  }
});

test("policy pages distinguish basic facts, complete interpretations, unknown dates, honest emptiness and failures", async () => {
  try {
    const list = await fetch(`${origin}/policies`);
    assert.equal(list.status, 200);
    assert.match(await list.text(), /目标国家|跨国与国际组织/);
    const basic = await fetch(`${origin}/policies/policy-fixture`);
    assert.equal(basic.status, 200);
    const html = await basic.text();
    assert.match(html, /决定性附件尚未取得，完整解读不可用/);
    assert.match(html, /来源发布日期：/);
    assert.doesNotMatch(html, /id="analysis"/);
    const report = await fetch(`${origin}/policies/reports/report-fixture`);
    assert.equal(report.status, 200);
    assert.match(await report.text(), /本期来源检查说明/);
    policyMode = "empty";
    assert.match(await (await fetch(`${origin}/policies`)).text(), /当前筛选暂无已公开法规/);
    policyMode = "error";
    const failed = await fetch(`${origin}/policies`);
    assert.equal(failed.status, 503);
    const error = await failed.text();
    assert.match(error, /暂时无法读取政策法规/);
    assert.doesNotMatch(error, /当前筛选暂无已公开法规/);
    policyMode = "withdrawn";
    assert.equal((await fetch(`${origin}/policies/policy-complete-fixture`)).status, 404);
    const invalid = await fetch(`${origin}/policies?theme=mining_rights&q=retained`);
    assert.equal(invalid.status, 400);
    assert.match(await invalid.text(), /value="retained"/);
  } finally {
    policyMode = "full";
  }
});
test("policy reading retains pages on failure, aligns original nodes and removes stale interpretation on withdrawal or revision", async () => {
  const executablePath = [
    process.env.E2E_BROWSER_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
    chromium.executablePath(),
  ].find((p) => p && existsSync(p));
  assert.ok(executablePath);
  const browser = await chromium.launch({ executablePath });
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.route("**/*", (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort("blockedbyclient")));
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/policies/policy-complete-fixture`);
    await page.getByRole("button", { name: "收藏法规", exact: true }).click();
    await expect(page.getByRole("button", { name: "已收藏法规", exact: true })).toBeVisible();
    await page.goto(`${origin}/starred`);
    await expect(page.getByRole("region", { name: "法规收藏" })).toContainText("【合成预览】融资信息报告规则");
    await page.goto(`${origin}/policies/policy-complete-fixture`);
    await expect(page.getByText(/已载入 1 \/ 2/)).toBeVisible();
    await page.getByRole("button", { name: "对照原文", exact: true }).click();
    await expect(page.getByText("Synthetic original clause one", { exact: true })).toBeVisible();
    policyMode = "reading_error";
    await page.getByRole("button", { name: "继续读取正文" }).click();
    await expect(page.getByText(/暂时无法继续读取/)).toBeVisible();
    await expect(page.getByText("【合成预览】第一条", { exact: true })).toBeVisible();
    policyMode = "full";
    await page.getByRole("button", { name: "重新读取正文" }).click();
    await expect(page.getByText("已载入全部正文节点。", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "原文 en", exact: true }).click();
    await expect(page.getByText(/原文 · en · 已载入 1 \/ 2/)).toBeVisible();
    policyMode = "withdrawn";
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByText("这篇法规当前不可查看", { exact: true })).toBeVisible();
    await expect(page.locator("[data-policy]")).toHaveCount(0);
    policyMode = "revision";
    await page.goto(`${origin}/policies/policy-complete-fixture`);
    await expect(page.getByText(/已载入 1 \/ 2/)).toBeVisible();
    await page.getByRole("button", { name: "继续读取正文" }).click();
    await expect(page.getByRole("heading", { name: "当前内容已变化或暂不可查看" })).toBeVisible();
    await expect(page.locator("#analysis")).toHaveCount(0);
  } finally {
    policyMode = "full";
    await browser.close();
  }
});

test("metal prices refresh only while visible, recover on focus and keep the last successful result on failure", async () => {
  const executablePath = [
    process.env.E2E_BROWSER_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/opt/google/chrome/chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    chromium.executablePath(),
  ].find((file) => file && existsSync(file));
  assert.ok(executablePath, "An existing Chrome/Chromium is required; no browser download");
  const browser = await chromium.launch({ executablePath, args: ["--disable-background-networking", "--disable-component-update"] });
  const context = await browser.newContext({ serviceWorkers: "block" });
  const blocked: string[] = [];
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    blocked.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  let calls = 0,
    unavailable = false,
    value = "123456.7";
  const page = await context.newPage();
  await page.route("**/api/site/metal-prices", async (route) => {
    calls++;
    assert.equal(route.request().method(), "GET");
    const next = syntheticPrices();
    next.metals[0]!.quotes[0]!.value = value;
    await route.fulfill({
      status: unavailable ? 503 : 200,
      contentType: "application/json",
      body: JSON.stringify(unavailable ? { code: "unavailable" } : next),
    });
  });
  try {
    await page.clock.install();
    await page.goto(`${origin}/metals`, { waitUntil: "networkidle" });
    await expect(page.locator("[data-metals]")).toContainText("108,770.0");
    assert.equal(calls, 0, "SSR data is reused until the first interval");
    await page.clock.fastForward(300_001);
    await expect(page.locator("[data-metals]")).toContainText("123,456.7");
    assert.equal(calls, 1);
    unavailable = true;
    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    await expect(page.getByRole("status")).toContainText("更新暂时失败");
    assert.equal(calls, 2, "focus events do not create overlapping refreshes");
    await expect(page.locator("[data-metals]")).toContainText("123,456.7");
    unavailable = false;
    value = "123999.8";
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator("[data-metals]")).toContainText("123,999.8");
    await expect(page.getByRole("status")).not.toContainText("更新暂时失败");
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const beforeHidden = calls;
    await page.clock.fastForward(600_001);
    assert.equal(calls, beforeHidden, "hidden documents stop polling");
    value = "124888.9";
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.locator("[data-metals]")).toContainText("124,888.9");
    assert.equal(calls, beforeHidden + 1, "becoming visible refreshes immediately");
    await page.getByRole("link", { name: "浏览矿业市场动态 →" }).click();
    await expect(page.locator("[data-metals]")).toHaveCount(0);
    const beforeLeaving = calls;
    await page.clock.fastForward(300_001);
    assert.equal(calls, beforeLeaving, "leaving the route removes the timer and listeners");
    assert.deepEqual(blocked, []);
  } finally {
    await browser.close();
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
  const asset = html.match(/(?:src|href)="(\/admin\/assets\/[^"<>]+\.js)"/)?.[1];
  assert.ok(asset, "built private login loads actual client JavaScript");
  const response = await fetchWithHost(origin + asset, PRIVATE_HOST);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  await response.arrayBuffer();
});

test("private asset prefix serves only the private build and never the public Host", async () => {
  const html = await (await fetchWithHost(origin + "/admin/login", PRIVATE_HOST)).text();
  assert.doesNotMatch(html, /["']\/assets\//);
  for (const suffix of ["js", "css"]) assert.match(html, new RegExp(`/admin/assets/[^"'<>]+\\.${suffix}`));
  assert.match(html, /\/admin\/assets\/manifest-/);
  const publicFiles = new Set(readdirSync(new URL("../build/public/client/assets/", import.meta.url)));
  const folder = new URL("../build/private/client/assets/", import.meta.url);
  const privateOnly = readdirSync(folder).filter((file) => !publicFiles.has(file));
  assert.ok(privateOnly.length);
  for (const file of privateOnly) {
    const pathname = "/admin/assets/" + file;
    const denied = await fetch(origin + pathname);
    assert.equal(denied.status, 404);
    assert.equal(denied.headers.get("Set-Cookie"), null);
    await denied.arrayBuffer();
    const allowed = await fetchWithHost(origin + pathname, PRIVATE_HOST);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("Cache-Control"), "private, no-store");
    assert.deepEqual(Buffer.from(await allowed.arrayBuffer()), readFileSync(new URL(file, folder)));
  }
});

test("production proxy drops administrator cookies for public APIs and keeps them for private APIs", async () => {
  const headers = { Cookie: "amp_admin=synthetic-proxy-cookie" };
  for (const pathname of ["/api/v1/items", "/api/site/feedback"]) {
    const before = apiCookies.length;
    await (await fetch(origin + pathname, { headers })).arrayBuffer();
    assert.equal(apiCookies.length, before + 1);
    assert.equal(apiCookies.at(-1), undefined);
  }
  const before = privateCookies.length;
  await (await fetchWithHost(origin + "/api/admin/me", PRIVATE_HOST, { headers })).arrayBuffer();
  assert.equal(privateCookies.length, before + 1);
  assert.equal(privateCookies.at(-1), headers.Cookie);
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
    for (const path of ["/search-busy", "/all/search-busy", "/admin/audit", "/admin/selectbench", "/admin/selectbench/example", "/admin/runs"]) {
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
    const response = await fetchWithHost(origin + "/admin/usage-models", PRIVATE_HOST);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /合成管理员/);
    assert.match(html, /模型与评测/);
    for (const path of ["content", "sources", "usage-models", "site", "feedback", "accounts", "usage-models/reconciliation", "usage-models/settings"]) {
      assert.ok(html.includes(`href="/admin/${path}"`), `existing private entry ${path} remains`);
    }
    assert.doesNotMatch(html, /\/admin\/(?:selectbench|audit|runs)|同批样本对比|888/);
    assert.ok(privateCalls.slice(before).every(({ path }) => path === "/api/admin/me" || path.startsWith("/api/admin/models?")));
    for (const group of ["public", "private"]) {
      const modules = readFileSync(new URL(`../build/${group}/modules.json`, import.meta.url), "utf8");
      assert.doesNotMatch(modules, /routes\/(?:search-busy|admin\/(?:audit|selectbench|runs))/);
    }
  } finally {
    privatePageFixtures = false;
  }
});

test("usage reconciliation renders existing controls and serializes only needed fees and delivery fields", async () => {
  privatePageFixtures = true;
  try {
    for (const suffix of ["", ".data"]) {
      const path = "/admin/usage-models/reconciliation" + suffix;
      const before = privateCalls.length;
      const denied = await fetch(origin + path);
      assert.equal(denied.status, 404);
      assert.equal(denied.headers.get("Set-Cookie"), null);
      await denied.text();
      assert.equal(privateCalls.length, before);
      const response = await fetchWithHost(origin + path, PRIVATE_HOST);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Cache-Control"), "private, no-store");
      const body = await response.text();
      assert.match(body, /合成通知目的地/);
      assert.match(body, /结果待核实/);
      assert.doesNotMatch(body, /NEVER_SERIALIZE|worker|队列积压|任务时间线|每 20 秒/);
      assert.ok(privateCalls.slice(before).some(({ path }) => path === "/api/admin/runs"));
    }
    reconciliationUnavailable = true;
    const failed = await fetchWithHost(origin + "/admin/usage-models/reconciliation", PRIVATE_HOST);
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get("Cache-Control"), "private, no-store");
    await failed.text();
  } finally {
    privatePageFixtures = false;
    reconciliationUnavailable = false;
  }
});

test("six private groups reuse existing capabilities and old bookmarks have only fixed internal targets", async () => {
  privatePageFixtures = true;
  try {
    for (const method of ["GET", "HEAD"]) {
      for (const [oldPath, expected] of [
        ["/admin/models?days=30&days=7&redirect=https://attacker.invalid", "/admin/usage-models?days=30"],
        ["/admin/settings?next=//attacker.invalid", "/admin/usage-models/settings"],
      ]) {
        const response = await fetchWithHost(origin + oldPath, PRIVATE_HOST, { method });
        assert.equal(response.status, 302);
        assert.equal(response.headers.get("Location"), expected);
        assert.equal(response.headers.get("Cache-Control"), "private, no-store");
        await response.text();
      }
    }
    for (const path of ["/admin/accounts", "/admin/site", "/admin/usage-models/settings"]) {
      const before = privateCalls.length;
      const denied = await fetch(origin + path);
      assert.equal(denied.status, 404);
      await denied.text();
      assert.equal(privateCalls.length, before);
      const response = await fetchWithHost(origin + path, PRIVATE_HOST);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Cache-Control"), "private, no-store");
      const html = await response.text();
      const main = html.match(/<main\b[\s\S]*?<\/main>/)![0];
      if (path.endsWith("accounts")) {
        assert.match(main, /合成管理员/);
        const logout = main.match(/<form\b[^>]*>/)![0];
        assert.match(logout, /method="post"/);
        assert.match(logout, /action="\/api\/auth\/logout"/);
        assert.doesNotMatch(main, /type="password"|<input/);
      } else if (path.endsWith("site")) {
        assert.match(main, /公开介绍/);
        assert.match(main, /保存网站资料/);
        assert.match(main, /受保护的展示配置/);
        assert.doesNotMatch(main, /name="(?:icp|publicSecurity|newsLicense)"/);
        assert.doesNotMatch(main, /<form|<input|<textarea|<select/);
      } else {
        assert.match(main, /通知目的地/);
        assert.match(main, /付费请求上限/);
        assert.ok(privateCalls.slice(before).some(({ path }) => path === "/api/admin/settings"));
      }
    }
  } finally {
    privatePageFixtures = false;
  }
});

test("site information page loads its real contract and keeps protected fields outside the edit form", async () => {
  privatePageFixtures = true;
  try {
    const res = await fetchWithHost(origin + "/admin/site", PRIVATE_HOST);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /合成网站资料介绍/);
    assert.match(html, /保存网站资料/);
    const form = html.match(/<form\b[^>]*class="space-y-5"[\s\S]*?<\/form>/)?.[0];
    assert.ok(form);
    assert.doesNotMatch(form, /ICP备案|公安联网备案|新闻信息服务许可证/);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  } finally {
    privatePageFixtures = false;
  }
});
