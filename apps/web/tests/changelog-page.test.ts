// Run after `pnpm --filter @amp/web build`. The changelog page on the real production server with a synthetic
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
  latestVersion: "2026-10-06T02:50",
  releases: [
    { date: "2026-10-06", time: "02:50", kind: "重大更新", version: "2.0", title: "合成的大版本", body: ["合成说明。", "- 要点：合成内容"] },
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
  assert.match(page, />重大更新 2\.0</);
  assert.match(page, /合成的只有日期的条目/);
  assert.match(page, /2026 年 9 月 15 日/);
  assert.doesNotMatch(page, /00:00|undefined/);
  // One time on the page: the major update's; the date-only entry renders none.
  assert.equal(page.match(/>\d{2}:\d{2}</g)?.length, 1);
});
