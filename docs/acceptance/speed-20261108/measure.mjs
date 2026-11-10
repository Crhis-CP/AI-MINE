// 页面打开与站内切换速度的测量脚本（TASK-0593）。本地与线上用同一套方法，便于前后对照。
//
// 线上：  node docs/acceptance/speed-20261108/measure.mjs --base https://<站点域名> --item /items/<一篇文章的编号>
// 本地：  npm run build --workspace @amp/web && node docs/acceptance/speed-20261108/measure.mjs --local
//         本地模式启动生产构建的 web 进程和演示接口（e2e/demo-api.ts，合成数据，不连数据库、不调模型），
//         前面再加一层与 Caddy `encode zstd gzip` 相当的 gzip 压缩，让传输字节数接近线上。
// 其他参数：--runs 5（每项取中位数的次数）、--json <文件>（另存原始结果）、--only <文字>（只测名字含这段文字的场景，如 --only nav）、
//         --serve（只启动本地站点并打印地址）。
//
// 测量项（每次都用全新的浏览器上下文，即“第一次打开、没有缓存”）：
//   TTFB  收到页面第一个字节的时间；FCP 首次出现内容；LCP 最大内容出现；可交互 页面脚本接管完成（主栏链接可由站内切换打开）；
//   JS/CSS/全部 字节 实际传输的脚本、样式与全部字节（压缩后，含响应头）；请求数 打开页面直到网络空闲的请求总数；
//   站内切换 在已打开的页面上点链接，到新页面地址生效并完成绘制的时间（`/`→`/all`，`/all`→文章）。
// 电脑：1440×900，不限速。手机：iPhone 13 模拟，限速 1.6 Mbps 下行 / 750 kbps 上行 / 150 ms 往返。
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const RUNS = Number(arg("runs", "5"));
const LOCAL = args.includes("--local");
/** Only the scenarios whose name contains this text, e.g. `--only nav` (all by default). */
const ONLY = arg("only", "");
const ROOT = path.resolve(import.meta.dirname, "../../..");

let playwright;
try {
  playwright = await import("@playwright/test");
} catch {
  playwright = await import("playwright");
}
const { chromium, devices } = playwright;

const PROFILES = {
  desktop: { context: { viewport: { width: 1440, height: 900 }, locale: "zh-CN" }, network: null },
  mobile: {
    context: { ...devices["iPhone 13"], locale: "zh-CN" },
    network: { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
  },
};

/** Emulates the Caddy `encode` step in front of web: text answers are gzip-compressed, streamed pages stay streamed. */
function gzipProxy(target) {
  const server = createServer((req, res) => {
    const up = httpRequest({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (answer) => {
      const type = String(answer.headers["content-type"] ?? "");
      const compress =
        /gzip/.test(String(req.headers["accept-encoding"] ?? "")) &&
        !answer.headers["content-encoding"] &&
        /^(text\/|application\/(json|javascript|manifest\+json|xml|rss\+xml)|image\/svg\+xml)/.test(type);
      if (!compress) {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        return answer.pipe(res);
      }
      const headers = { ...answer.headers, "content-encoding": "gzip", vary: "Accept-Encoding" };
      delete headers["content-length"];
      res.writeHead(answer.statusCode ?? 502, headers);
      answer.pipe(zlib.createGzip({ flush: zlib.constants.Z_SYNC_FLUSH })).pipe(res);
    });
    up.on("error", () => {
      res.statusCode = 502;
      res.end();
    });
    req.pipe(up);
  });
  server.listen(0, "127.0.0.1");
  return server;
}

/** Eight real WebP pictures from the repository (the changelog comparison shots, 25–42 KB each). */
const PICTURES = ["home-after", "all-after", "item-after", "storyline-after", "metals-after", "policies-after", "more-after", "home-before"];

/**
 * The demo API plus one illustrated article (`/items/demo-illustrated`): the demo article's text with eight
 * pictures spread through the body, the way a full-text article with photos and charts arrives in production.
 */
async function startLocalApi() {
  const { demoReaderApi } = await import(path.join(ROOT, "e2e/demo-api.ts"));
  const { demoItemDetail } = await import(path.join(ROOT, "e2e/demo-reader.ts"));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://measure.invalid");
    const picture = url.pathname.match(/^\/api\/measure-picture\/(\d)$/);
    if (picture) {
      res.writeHead(200, { "content-type": "image/webp", "cache-control": "public, max-age=3600" });
      return res.end(readFileSync(path.join(ROOT, `apps/web/app/features/changelog/compare-202611/${PICTURES[Number(picture[1])]}.webp`)));
    }
    if (url.pathname === "/api/site/items/demo-illustrated") {
      const item = demoItemDetail("demo-guidance");
      const figure = (i) => `<p><img src="/api/measure-picture/${i}" alt="合成配图 ${i + 1}" width="1440" height="1000"></p>`;
      // One picture after each paragraph, the rest at the end.
      let n = 0;
      const inline = item.body.zh.replace(/<\/p>/g, (end) => (n < PICTURES.length ? end + figure(n++) : end));
      const zh = inline + PICTURES.slice(n).map((_, k) => figure(n + k)).join("");
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      return res.end(JSON.stringify({ ...item, id: "demo-illustrated", body: { ...item.body, zh } }));
    }
    return demoReaderApi(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(() => done())) };
}

async function startLocal() {
  const api = await startLocalApi();
  const web = spawn(process.execPath, ["--import", path.join(ROOT, "e2e/web-clock.ts"), "apps/web/server.ts"], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      WEB_HOST: "127.0.0.1",
      WEB_PORT: "0",
      PRIVATE_HOST: "private.localhost",
      TRUST_PROXY: "false",
      RATE_LIMIT: "off",
      API_BASE_URL: api.url,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise((resolve, reject) => {
    let log = "";
    const timer = setTimeout(() => reject(new Error(log)), 20000);
    const read = (chunk) => {
      log += chunk;
      const match = log.match(/"msg":"web started","port":(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    };
    web.stdout.on("data", read);
    web.stderr.on("data", read);
    web.once("exit", () => reject(new Error(log)));
  });
  const proxy = gzipProxy({ hostname: "127.0.0.1", port });
  await once(proxy, "listening");
  return {
    base: `http://127.0.0.1:${proxy.address().port}`,
    item: "/items/demo-guidance",
    illustrated: "/items/demo-illustrated",
    stop: async () => {
      proxy.close();
      web.kill("SIGTERM");
      await once(web, "exit");
      await api.close();
    },
  };
}

/**
 * Largest contentful paint is read from a buffered observer installed before any page script. "Interactive" is
 * when React has taken over the server-rendered page: the links in the main column carry React's event props.
 */
const LCP_PROBE = `
  window.__lcp = 0;
  window.__lcpTag = "";
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) { window.__lcp = e.startTime; window.__lcpTag = e.element ? e.element.tagName + "." + String(e.element.className).slice(0, 40) : ""; }
  }).observe({ type: "largest-contentful-paint", buffered: true });
  window.__hydrated = 0;
  const probe = () => {
    const link = document.querySelector("#main a[href]");
    if (link && Object.keys(link).some((key) => key.startsWith("__reactProps"))) window.__hydrated = performance.now();
    else requestAnimationFrame(probe);
  };
  requestAnimationFrame(probe);
`;

async function openContext(browser, profile) {
  const context = await browser.newContext({ ...PROFILES[profile].context, serviceWorkers: "block" });
  await context.addInitScript(LCP_PROBE);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
  if (PROFILES[profile].network) await cdp.send("Network.emulateNetworkConditions", PROFILES[profile].network);
  const types = new Map();
  const bytes = { Script: 0, Stylesheet: 0, Document: 0, Font: 0, Image: 0, Fetch: 0, Other: 0 };
  let requests = 0;
  // Time to first byte from the browser's own record of the page request: under emulated throttling the
  // page's Navigation Timing leaves the added latency out, this record includes it.
  const firstByte = { ms: 0 };
  cdp.on("Network.requestWillBeSent", () => requests++);
  cdp.on("Network.responseReceived", (e) => {
    types.set(e.requestId, e.type);
    if (e.type === "Document" && !firstByte.ms) firstByte.ms = e.response.timing?.receiveHeadersEnd ?? 0;
  });
  cdp.on("Network.loadingFinished", (e) => {
    const type = types.get(e.requestId) ?? "Other";
    bytes[type in bytes ? type : "Other"] += e.encodedDataLength;
  });
  return { context, page, bytes, firstByte, count: () => requests };
}

async function loadMetrics(browser, profile, url) {
  const { context, page, bytes, firstByte, count } = await openContext(browser, profile);
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });
    await page.waitForTimeout(300);
    const timing = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      const fcp = performance.getEntriesByName("first-contentful-paint")[0];
      return { fcp: fcp?.startTime ?? 0, lcp: window.__lcp || fcp?.startTime || 0, interactive: window.__hydrated, load: nav.loadEventEnd, lcpTag: window.__lcpTag };
    });
    const total = Object.values(bytes).reduce((sum, value) => sum + value, 0);
    return { ttfb: firstByte.ms, ...timing, js: bytes.Script, css: bytes.Stylesheet, html: bytes.Document, font: bytes.Font, image: bytes.Image, total, requests: count() };
  } finally {
    await context.close();
  }
}

/** Click a link on an opened page; time until the router has committed the new address and painted it. */
async function navigationTime(browser, profile, url, selector, target) {
  const { context, page } = await openContext(browser, profile);
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      document.addEventListener("click", () => (window.__clickAt = performance.now()), { capture: true, once: true });
    });
    const link = page.locator(selector).first();
    await link.scrollIntoViewIfNeeded();
    await link.click();
    return await page.evaluate(
      (want) =>
        new Promise((resolve, reject) => {
          const deadline = performance.now() + 60000;
          const tick = () => {
            if (new RegExp(want).test(location.pathname)) requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - window.__clickAt)));
            else if (performance.now() > deadline) reject(new Error(`no navigation to ${want}`));
            else requestAnimationFrame(tick);
          };
          tick();
        }),
      target,
    );
  } finally {
    await context.close();
  }
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const local = LOCAL || args.includes("--serve") ? await startLocal() : null;
if (args.includes("--serve")) {
  // Only start the local site (for looking at it by hand); Ctrl+C stops it.
  console.log(local.base);
  process.on("SIGINT", () => local.stop().then(() => process.exit(0)));
  process.on("SIGTERM", () => local.stop().then(() => process.exit(0)));
  await new Promise(() => {});
}
const BASE = (local?.base ?? arg("base", "")).replace(/\/$/, "");
const ITEM = local?.item ?? arg("item", "");
// An article with several pictures in its body (optional on production: --illustrated /items/<编号>).
const ILLUSTRATED = local?.illustrated ?? arg("illustrated", "");
if (!BASE || !ITEM) throw new Error("usage: --local, or --base <站点地址> --item /items/<编号>");

const browser = await chromium.launch(process.env.E2E_BROWSER_PATH ? { executablePath: process.env.E2E_BROWSER_PATH } : {});
const results = {};
try {
  for (const profile of Object.keys(PROFILES)) {
    for (const [name, pathname] of [
      ["home", "/"],
      ["all", "/all"],
      ["item", ITEM],
      ...(ILLUSTRATED ? [["item+pictures", ILLUSTRATED]] : []),
    ]) {
      if (!`${profile} ${name}`.includes(ONLY)) continue;
      const runs = [];
      // One discarded warm-up so server-side caches and lazy module loading do not land in run 1.
      await loadMetrics(browser, profile, BASE + pathname);
      for (let i = 0; i < RUNS; i++) runs.push(await loadMetrics(browser, profile, BASE + pathname));
      results[`${profile} ${name}`] = Object.fromEntries(
        Object.keys(runs[0]).map((key) => [key, typeof runs[0][key] === "number" ? median(runs.map((run) => run[key])) : runs[0][key]]),
      );
    }
    // The header link on a computer, the tab bar on a phone; then the first article of the list.
    const nav = [
      ["nav home→all", "/", 'a[href="/all"]:visible', "^/all$"],
      ["nav all→item", "/all", 'a.feed-title[href^="/items/"]:visible', "^/items/"],
    ];
    for (const [name, from, selector, target] of nav) {
      if (!`${profile} ${name}`.includes(ONLY)) continue;
      const runs = [];
      await navigationTime(browser, profile, BASE + from, selector, target);
      for (let i = 0; i < RUNS; i++) runs.push(await navigationTime(browser, profile, BASE + from, selector, target));
      results[`${profile} ${name}`] = { ms: median(runs) };
    }
  }
} finally {
  await browser.close();
  await local?.stop();
}

const round = (value) => (Number.isFinite(value) ? Math.round(value) : value);
console.log(`base ${BASE}  runs ${RUNS} (median)`);
console.log("| 场景 | TTFB ms | FCP ms | LCP ms | 可交互 ms | JS KB | CSS KB | 全部 KB | 请求数 | 切换 ms |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
const kb = (bytes) => (bytes / 1024).toFixed(1);
for (const [name, r] of Object.entries(results)) {
  if ("ms" in r) console.log(`| ${name} | | | | | | | | | ${round(r.ms)} |`);
  else
    console.log(
      `| ${name} | ${round(r.ttfb)} | ${round(r.fcp)} | ${round(r.lcp)} | ${round(r.interactive)} | ${kb(r.js)} | ${kb(r.css)} | ${kb(r.total)} | ${r.requests} | |`,
    );
}
const out = arg("json", "");
if (out) writeFileSync(out, JSON.stringify({ base: BASE, runs: RUNS, at: new Date().toISOString(), results }, null, 2));
