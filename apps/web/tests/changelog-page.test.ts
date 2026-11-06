// Run after `npm run build --workspace @amp/web`. The changelog page on the real production server with a synthetic
// API (TASK-0038): a date-only entry shows no time at all, never 00:00, and a major update shows its version.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { webEnvironment } from "../runtime-env.ts";

const changelog = {
  latestVersion: "2026-11-06T11:21",
  releases: [
    {
      date: "2026-11-06",
      time: "11:21",
      kind: "重大更新",
      version: "2026.11",
      title: "合成的地图版本",
      body: ["合成导语。", "合成一。", "合成二。", "合成三。", "合成四。", "合成五。", "合成六。"],
    },
    {
      date: "2026-10-06",
      time: "02:50",
      kind: "重大更新",
      version: "2.0",
      title: "合成的大版本",
      body: [
        "合成说明。",
        "- 要点：合成内容",
        "**收集 合成甲**：合成收集说明。",
        "**筛选 合成乙**：合成筛选说明。",
        "**归并 合成丙**：合成归并说明。",
        "**精选 合成丁**：合成精选说明。",
        "**发布 合成戊**：合成发布说明。",
        "出口：合成网页、合成订阅",
      ],
    },
    { date: "2026-09-15", kind: "公告", title: "合成的只有日期的条目", body: ["合成说明。"] },
  ],
};
let web: ChildProcess;
let origin: string;
let logs = "";
const api = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/site/changelog") return res.end(JSON.stringify(changelog));
  if (req.url === "/api/site/meta") return res.end(JSON.stringify({ changelogVersion: changelog.latestVersion }));
  res.statusCode = 404;
  res.end(JSON.stringify({ code: "not_found" }));
});

before(async () => {
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  web = spawn(process.execPath, [fileURLToPath(new URL("../server.ts", import.meta.url))], {
    env: webEnvironment({
      ...process.env,
      WEB_PORT: "0",
      PRIVATE_HOST: "private.localhost",
      TRUST_PROXY: "false",
      API_BASE_URL: apiBase,
      PRIVATE_API_BASE_URL: apiBase,
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
  api.closeAllConnections();
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

test("a date-only entry has no time on the page; a major update shows its version", async () => {
  const res = await fetch(`${origin}/changelog`);
  assert.equal(res.status, 200);
  const html = await res.text();
  // The page itself, without the scripts (the serialized loader data among them).
  const page = html.replace(/<script\b[\s\S]*?<\/script>/g, "");
  assert.match(page, />02:50</);
  assert.match(page, />11:21</);
  assert.match(page, />重大更新 2\.0</);
  assert.match(page, /id="d-2026-10-06"/, "a feature-only day remains the month navigation target");
  assert.match(page, /合成的只有日期的条目/);
  assert.match(page, /2026 年 9 月 15 日/);
  assert.doesNotMatch(page, /00:00|undefined/);
  // Two times on the page: the two major updates'; the date-only entry renders none.
  assert.equal(page.match(/>\d{2}:\d{2}</g)?.length, 2);
});

test("the 2026.11 major update leads with the live news map and folds its long list of changes", async () => {
  const page = (await (await fetch(`${origin}/changelog`)).text()).replace(/<script\b[\s\S]*?<\/script>/g, "");
  assert.match(page, />重大更新 2026\.11</);
  assert.match(page, /本次主角/);
  assert.match(page, /id="world-map"/, "the home page's own map is embedded");
  assert.match(page, /鼠标移到圆点上看是哪个国家，点一下去首页看该国资讯。/, "with a hint that fits this page");
  // The lead line shows; the six other lines are listed in a folded section with their count.
  assert.match(page, /合成导语。/);
  assert.match(page, /<details[^>]*>[\s\S]*本次全部 <!-- -->6<!-- --> 项变化|<details[^>]*>[\s\S]*本次全部 6 项变化/);
  for (const to of ["/all", "/hot", "/policies", "/metals", "/more"]) assert.match(page, new RegExp(`href="${to}"`), to);
  // The 2.0 notice has no showcase of its own and keeps its paragraphs, and its steps are drawn as a chain.
  assert.match(page, /合成说明。/);
  for (const step of ["收集", "筛选", "归并", "精选", "发布", "合成筛选说明。", "合成订阅"]) assert.match(page, new RegExp(step), step);
  // Five steps are threaded on one gathering line: many lines come in and close to one; each step numbered under its stretch.
  assert.match(page, /很多来源的消息进来，层层筛掉、合并，最后留下值得看的那一小部分。/);
  assert.ok((page.match(/<path d="M0 [^"]*"[^>]*stroke="url\(#[\w-]*-beam\)"/g)?.length ?? 0) >= 30, "many lines come in");
  assert.ok((page.match(/<path d="M0 [^"]*990 100"[^>]*stroke="url\(#[\w-]*-beam\)"/g)?.length ?? 0) >= 1, "and close to one line out");
  for (const n of ["01", "02", "03", "04", "05"]) assert.match(page, new RegExp(`>${n}<`), n);
  // It moves like an instrument at work, all in CSS so reduced motion keeps it still: lights race along the lines, a scan
  // sweeps the filter stretch, a reticle turns on the bright point; no SVG animation that CSS could not stop.
  for (const motion of ["flow-pulse", "flow-scan", "flow-spin", "flow-ping"]) assert.match(page, new RegExp(`class="${motion}`), motion);
  for (const code of ["INPUT", "FILTER", "MERGE", "SELECT", "OUTPUT"]) assert.match(page, new RegExp(`>${code}<`), code);
  assert.doesNotMatch(page, /<animate(?:Motion)?\b/);
});
