import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { createServer } from "vite";
import { LOGO_PATH } from "../app/lib/icons.ts";

const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: "custom" });
after(() => server.close());
const route = await server.ssrLoadModule(fileURLToPath(new URL("../app/routes/home.tsx", import.meta.url)));
const filters = { channel: "all", category: null, tag: null, topic: null };
const timeline = { filters, cards: [], nextCursor: null, refreshAt: null, hot: null, dayCounts: {}, generatedAt: "2026-10-26T00:00:00Z" };

test("the real home loader distinguishes failed observations from confirmed empty data", async (t) => {
  let mode: "stats-failed" | "pool-failed" | "empty" | "started" = "stats-failed";
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/site/timeline") return Response.json(timeline);
    if (path === "/api/site/stats")
      return mode === "stats-failed"
        ? Response.json({}, { status: 503 })
        : Response.json({
            sources: 1,
            sourceKinds: {},
            heatOnlySources: 0,
            items: 0,
            selected: mode === "started" ? 1 : 0,
            dailies: 0,
            day: { collected: 0, selected: 0 },
          });
    assert.equal(path, "/api/site/pool");
    return mode === "pool-failed"
      ? Response.json({}, { status: 503 })
      : Response.json({
          filters: { ...filters, q: null, tab: "time" },
          items: [],
          page: 1,
          pageCount: 0,
          total: 0,
          todayCount: 0,
          freshness: "2026-10-26T00:00:00Z",
          generatedAt: "2026-10-26T00:00:00Z",
        });
  });
  for (const state of ["stats-failed", "pool-failed", "empty", "started"] as const) {
    mode = state;
    const response = await route.loader({ request: new Request("https://reader.invalid/") });
    const unavailable = state.endsWith("failed");
    assert.equal(response.data.unavailable, unavailable, state);
    const router = createMemoryRouter([{ id: "home", path: "/", element: createElement(route.default) }], {
      hydrationData: { loaderData: { home: response.data } },
    });
    try {
      const html = renderToStaticMarkup(createElement(RouterProvider, { router }));
      assert.equal(html.includes("精选暂时无法读取"), unavailable);
      assert.ok(!html.includes("精选还没开始"));
      if (state === "empty") assert.ok(html.includes("暂时没有符合条件的精选"));
    } finally {
      router.dispose();
    }
  }
});

test("only the unfiltered home page carries the Organization and WebSite data that name the site in search results", () => {
  const structured = (f: object) =>
    route.meta({ loaderData: { filters: f } }).find((m: object) => "script:ld+json" in m)?.["script:ld+json"] as Array<Record<string, string>> | undefined;
  const [organization, website, ...rest] = structured(filters) ?? [];
  assert.equal(rest.length, 0);
  assert.equal(organization?.["@type"], "Organization");
  assert.ok(organization?.logo?.endsWith(LOGO_PATH), "the logo is the icon tests/site-icons.test.ts checks");
  assert.equal(website?.["@type"], "WebSite");
  assert.equal(website?.name, organization?.name);
  assert.equal(website?.name, "AI-MINE", "search results name the site AI-MINE (Owner 2026-11-06)");
  assert.equal(website?.alternateName, "AI矿策");
  assert.equal(website?.url, `${organization?.url}/`);
  assert.equal(structured({ ...filters, tag: "铜" }), undefined);
});
