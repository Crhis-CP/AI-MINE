// Run after `npm run build --workspace @amp/web`. The changelog page on the real production server with a synthetic
// API (TASK-0038): a date-only entry shows no time at all, never 00:00, and a major update shows its version.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
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
/** What the synthetic API serves; one test swaps in the real hand-written file. */
let served: { latestVersion: string; releases: Array<{ date: string; time?: string; title: string }> } = changelog;
let origin: string;
let logs = "";
const api = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/site/changelog") return res.end(JSON.stringify(served));
  if (req.url === "/api/site/meta") return res.end(JSON.stringify({ changelogVersion: served.latestVersion }));
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

test("the 2026.11 notice shows each change as the old and the new screen of the same page", async () => {
  // Owner 2026-11-06: “这些应该用图片说，以前 logo 什么样子现在什么样子”.
  const page = (await (await fetch(`${origin}/changelog`)).text()).replace(/<script\b[\s\S]*?<\/script>/g, "");
  const section = page.match(/<section[^>]*aria-label="改版前后"[\s\S]*?<\/ol>/)?.[0] ?? "";
  assert.ok(section, "the before/after section is on the page");
  assert.equal(section.match(/<li\b/g)?.length, 8, "one row per change");
  // Page screens are stacked with a handle (a range input); the mark and the phone screens stand side by side.
  assert.equal(section.match(/type="range"/g)?.length, 6);
  for (const label of ["新标识“五臂星系”", "事件脉络", "法规政策动态", "金属价格卡片", "手机上的“我的”"]) assert.match(section, new RegExp(label), label);
  const sources = [...section.matchAll(/<img[^>]*src="([^"]+)"/g)].map((m) => m[1]!);
  assert.equal(sources.length, 16, "a before and an after picture for every change");
  for (const src of new Set(sources)) {
    const res = await fetch(new URL(src, origin));
    assert.equal(res.status, 200, src);
    assert.match(res.headers.get("content-type") ?? "", /image\/webp/, src);
  }
  assert.match(section, /alt="改版前：新标识“五臂星系”"/);
  const english = (await (await fetch(`${origin}/en/changelog`)).text()).replace(/<script\b[\s\S]*?<\/script>/g, "");
  assert.match(english, /aria-label="Before and after"/);
  assert.match(english, />Before</);
});

test("the published 2026.11 copy names no company as an example", async () => {
  // Owner 2026-11-06: “不要说必和必拓这些举例”.
  const edits = await readFile(new URL("../../../industry/changelog-copy-edits.json", import.meta.url), "utf8");
  assert.doesNotMatch(edits, /必和必拓|BHP/);
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
  assert.match(page, /鼠标移到圆点上看是哪个国家，点一下看该国这段时间的全部资讯。/, "with a hint that fits this page");
  // The lead line shows; the six other lines are listed in a folded section with their count.
  assert.match(page, /合成导语。/);
  assert.match(page, /<details[^>]*>[\s\S]*本次全部 <!-- -->6<!-- --> 项变化|<details[^>]*>[\s\S]*本次全部 6 项变化/);
  for (const to of ["/all", "/hot", "/policies", "/metals", "/more"]) assert.match(page, new RegExp(`href="${to}"`), to);
  // The 2.0 notice has no showcase of its own and keeps its paragraphs, and its steps are drawn as a chain.
  assert.match(page, /合成说明。/);
  for (const step of ["收集", "筛选", "归并", "精选", "发布", "合成筛选说明。", "合成订阅"]) assert.match(page, new RegExp(step), step);
  // Five steps on a dark pipeline screen: labelled sources feed glass step cards, lanes thin from card to card, what
  // 筛选 lets go turns off into a bin; the words for each step sit under the screen, numbered with their codes.
  assert.match(page, /很多来源的消息进来，层层筛掉、合并，最后留下值得看的那一小部分。/);
  for (const source of ["部委", "协会", "矿企", "媒体", "交易所", "海外", "无关 · 重复", "PIPELINE"]) assert.match(page, new RegExp(source), source);
  for (const code of ["INPUT", "FILTER", "MERGE", "SELECT", "OUTPUT"]) assert.match(page, new RegExp(`>${code}<`), code);
  for (const n of ["01", "02", "03", "04", "05"]) assert.match(page, new RegExp(`>${n}<`), n);
  // It moves like a running console, all in CSS so reduced motion keeps it still; no SVG animation CSS could not stop.
  for (const motion of ["flow-comet", "flow-node", "flow-scan-card", "flow-spin", "flow-sweep"]) assert.match(page, new RegExp(`class="${motion}`), motion);
  assert.doesNotMatch(page, /<animate(?:Motion)?\b/);
});

test("the real hand-written entries show the time they went live; the rest show none, never 00:00", async () => {
  // Owner 2026-11-07: every update should show its time. TASK-0568 backfilled the entries the repository has a time for.
  served = JSON.parse(await readFile(new URL("../../../industry/changelog.json", import.meta.url), "utf8"));
  try {
    const page = (await (await fetch(`${origin}/changelog`)).text()).replace(/<script\b[\s\S]*?<\/script>/g, "");
    // The list row of an entry (notices such as the launch and the beta notice are drawn apart, with their own time).
    const row = (title: string) => {
      const at = page.indexOf(title);
      assert.ok(at > 0, title);
      const start = page.lastIndexOf("<li", at);
      return start >= 0 && !page.slice(start, at).includes("</li>") ? page.slice(start, at) : null;
    };
    const timed = served.releases.filter((r) => r.time);
    assert.ok(timed.length >= 9, "the backfilled entries carry a time");
    for (const r of timed) {
      const shown = row(r.title);
      if (shown !== null) assert.match(shown, new RegExp(`>${r.time}<`), `${r.title} shows ${r.time}`);
    }
    for (const r of served.releases.filter((r) => !r.time)) {
      const shown = row(r.title);
      if (shown !== null) assert.doesNotMatch(shown, />\d{2}:\d{2}</, `${r.title} has no time on record`);
    }
    assert.doesNotMatch(page, />00:00</);
  } finally {
    served = changelog;
  }
});
