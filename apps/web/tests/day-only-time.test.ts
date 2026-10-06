// A source that gave only the date is kept at the start of that Beijing day, and pages show the date alone
// (Owner 2026-10-05: 只显示日期; TASK-0040): the time column shows a dash, never 00:00, and the article page
// shows the stated date with no time and no "几天前". Run after `pnpm --filter @amp/web build`.
// Real production server and router, synthetic HTTP API only.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { beijingDate } from "@amp/contracts/time";
import { isDateOnlyInstant, NO_TIME } from "../app/lib/format.ts";
import { webEnvironment } from "../runtime-env.ts";

const today = beijingDate(new Date());
const dayStart = new Date(`${today}T00:00:00+08:00`).toISOString();
const timed = new Date(`${today}T00:30:00+08:00`).toISOString();
const item = (id: string, title: string, publishedAt: string | null, timelineAt: string) => ({
  id,
  title,
  summary: "合成摘要",
  reason: null,
  source: { name: "合成来源" },
  publishedAt,
  timelineAt,
  category: null,
  tags: [],
  score: null,
  selected: false,
  channel: "news",
});
const statedDay = new Date("2026-09-24T00:00:00+08:00").toISOString();
const detail = {
  ...item("day-only", "只写日期的合成稿", statedDay, statedDay),
  revision: 1,
  originalTitle: null,
  source: { id: "synthetic", name: "合成来源", kind: "web_list", firstParty: true },
  links: { original: "https://source.invalid/a/1" },
  discoveredAt: new Date("2026-10-06T04:30:00+08:00").toISOString(),
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
const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://api.local");
  res.setHeader("Content-Type", "application/json");
  if (url.pathname === "/api/site/meta") return res.end(JSON.stringify({ changelogVersion: "2026-10-06T00:00" }));
  if (url.pathname === "/api/site/hot") return res.end(JSON.stringify({ entries: [] }));
  if (url.pathname === "/api/site/items/day-only") return res.end(JSON.stringify(detail));
  if (url.pathname === "/api/site/pool")
    return res.end(
      JSON.stringify({
        filters: { channel: "all", category: null, tag: null, topic: null, q: null, tab: "time" },
        items: [item("timed", "有时刻的合成稿", timed, timed), item("day-only", "只写日期的合成稿", dayStart, dayStart)],
        page: 1,
        pageCount: 1,
        total: 2,
        todayCount: 2,
        freshness: dayStart,
        generatedAt: dayStart,
      }),
    );
  res.statusCode = url.pathname.startsWith("/api/admin/") ? 401 : 404;
  res.end(JSON.stringify({ code: "not_found" }));
});

let web: ChildProcess;
let origin = "";
let logs = "";
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
    web.on("exit", () => reject(new Error(`web exited: ${logs}`)));
    web.stderr!.on("data", (chunk) => (logs += String(chunk)));
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

test("the start of a Beijing day stands for a date alone, not a time", () => {
  assert.equal(isDateOnlyInstant(dayStart), true);
  assert.equal(isDateOnlyInstant(timed), false);
  assert.equal(isDateOnlyInstant("2026-10-06T00:00:00Z"), false, "UTC midnight is 08:00 in Beijing, a real time");
});

test("全部动态 shows a dash for a date-only item and the time for a timed one, never 00:00", async () => {
  const res = await fetch(`${origin}/all`);
  assert.equal(res.status, 200);
  const html = await res.text();
  const slots = [...html.matchAll(/<time\b[^>]*>([^<]*)<\/time>/g)].map((m) => m[1]);
  assert.ok(slots.includes("00:30"), `the timed item keeps its time (${slots.join(", ")})`);
  assert.ok(slots.includes(NO_TIME), "the date-only item shows a dash");
  assert.ok(!slots.includes("00:00"), "no day's start is shown as a time");
  assert.match(html, new RegExp(`<time[^>]*datetime="${today}"[^>]*>${NO_TIME}</time>`, "i"), "its machine-readable value is the date alone");
});

test("an article page shows a date-only source's stated date alone, not 00:00 or the time it was found", async () => {
  const res = await fetch(`${origin}/items/day-only`);
  assert.equal(res.status, 200);
  const html = await res.text();
  // What a reader sees: the page without the serialized loader data.
  const visible = html.replace(/<script[\s\S]*?<\/script>/g, "");
  assert.match(visible, /<time[^>]*datetime="2026-09-24"[^>]*>2026-09-24<\/time>/i, "the stated date");
  assert.doesNotMatch(visible, /04:30/, "never the moment it was found");
  assert.doesNotMatch(visible, /00:00/, "never the day's start as a time");
  assert.doesNotMatch(visible, /天前|小时前/, "no relative time from the day's start");
});
