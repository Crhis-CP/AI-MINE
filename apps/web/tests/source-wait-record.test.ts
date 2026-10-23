import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom" });
after(() => server.close());
const { SourceWaitRecord } = await server.ssrLoadModule(fileURLToPath(new URL("../app/routes/admin/source.tsx", import.meta.url)));
const render = (detail: Record<string, unknown> | null) => renderToStaticMarkup(createElement(SourceWaitRecord, { detail }));

test("source waiting records explain the historical reason and planned time without claiming current recovery", () => {
  const html = render({ state: "deferred", reason: "robots_unavailable", retryAt: "2026-10-22T12:34:00Z" });
  assert.match(html, /等待取得源站访问规则/);
  assert.match(html, /该次计划于 2026-10-22 20:34 重试/);
  assert.match(html, /历史记录，不代表当前采集状态/);
  assert.match(render({ state: "deferred", reason: "host_pacing", retryAt: "invalid" }), /等待正常访问间隔；该次重试时间未记录/);
  assert.equal(render(null), "");
  assert.equal(render({ state: "ok" }), "");
  const unknown = render({ state: "deferred", reason: "https://private.invalid/?secret=unsafe", retryAt: 123 });
  assert.match(unknown, /等待后续采集/);
  assert.ok(!unknown.includes("unsafe"));
  for (const reason of ["__proto__", "constructor", "toString"]) assert.match(render({ state: "deferred", reason }), /等待后续采集/);
});
