import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom" });
after(() => server.close());
const { ModuleRunPanels } = await server.ssrLoadModule(fileURLToPath(new URL("../app/features/admin/module-runs.tsx", import.meta.url)));
const parts = [{ name: "fixture", part: ({ data }: { data: unknown }) => createElement("p", null, `待处理：${(data as { waiting: number }).waiting}`) }];
const render = (modules: unknown) => renderToStaticMarkup(createElement(ModuleRunPanels, { parts, modules }));

test("installed run panels receive only ready data and distinguish unavailable from absent", () => {
  assert.match(render({ fixture: { status: "ready", data: { waiting: 7 } } }), /待处理：7/);
  const unavailable = render({ fixture: { status: "unavailable" } });
  assert.match(unavailable, /暂时无法读取/);
  assert.ok(!unavailable.includes("待处理：0"));
  assert.equal(render(undefined), "");
  assert.equal(render({ other: { status: "ready", data: { waiting: 8 } } }), "");
  assert.equal(renderToStaticMarkup(createElement(ModuleRunPanels, { parts: [{ ...parts[0], name: "constructor" }], modules: {} })), "");
});

test("the actual dashboard loader preserves module results after checking the private response", async (t) => {
  const modules = { fixture: { status: "ready", data: { waiting: 7 } }, failed: { status: "unavailable" } };
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      checkedAt: "2026-10-24T12:00:00Z",
      processes: [],
      jobs: [],
      timeline: [],
      queues: [],
      failedJobs: [],
      lagging: [],
      receipts: { counts: {}, issues: [] },
      deliveries: [],
      errors: [],
      retrying: { count: 0, next: null },
      ingest: [],
      modules,
    }),
  );
  const { loader } = await server.ssrLoadModule(fileURLToPath(new URL("../app/routes/admin/runs.tsx", import.meta.url)));
  const result = await loader({ request: new Request("https://private.invalid/admin/runs") });
  assert.deepEqual(result.modules, modules);
});

test("navigation count failure remains unknown in the actual loader and badges instead of appearing empty", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: unknown) =>
    String(url).endsWith("/api/admin/me") ? Response.json({ mustChangePassword: false }) : Response.json({ detail: "private-fixture-error" }, { status: 503 }),
  );
  const { loader, NavCount } = await server.ssrLoadModule(fileURLToPath(new URL("../app/routes/admin/layout.tsx", import.meta.url)));
  const result = await loader({ request: new Request("https://private.invalid/admin/runs") });
  assert.equal(await result.counts, null);
  const badge = (value: unknown) => renderToStaticMarkup(createElement(NavCount, { value }));
  assert.match(badge(null), /待处理数量暂时无法读取/);
  assert.match(badge(null), /\?/);
  assert.equal(badge(0), "");
  assert.equal(badge(undefined), "");
  assert.match(badge(3), />3</);
  assert.ok(!badge(null).includes("private-fixture-error"));
});
