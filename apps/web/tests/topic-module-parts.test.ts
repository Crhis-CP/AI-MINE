import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { alias: { "@amp/site/modules/web": "\0fixture-topic-parts" } },
  plugins: [
    {
      name: "fixture-topic-parts",
      resolveId: (id) => (id === "\0fixture-topic-parts" ? id : null),
      load: (id) =>
        id === "\0fixture-topic-parts"
          ? `import {createElement} from 'react';
      export const WEB_MODULES=[{name:'fixture',topicPage:async()=>({default:{name:'补充信息',shows:d=>d.show,
        Block:({data})=>createElement('p',null,'扩展第'+data.page+'页'),entries:()=>[{title:'部件条目',href:'/topics/fixture#part'}],news:()=>['部件新闻']}})}];`
          : null,
    },
  ],
});
after(() => server.close());
const route = await server.ssrLoadModule(fileURLToPath(new URL("../app/routes/topic.tsx", import.meta.url)));
const topic = {
  slug: "fixture",
  name: "合成主题",
  group: "field",
  definition: "主题原说明",
  total: 21,
  recent: 1,
  indexable: true,
  latestAt: null,
  basis: "all",
  related: [],
};
function mockApi(t: TestContext, stale = false, part = true) {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    assert.equal(init?.method ?? "GET", "GET");
    const page = Number(url.searchParams.get("page") ?? 1);
    if (url.pathname.startsWith("/api/site/topics/")) {
      if (stale && page > 1) return Response.json({ code: "not_found" }, { status: 404 });
      return Response.json({ topic, items: [], page, pageCount: 2, ...(part ? { parts: { fixture: { show: true, page } } } : {}) });
    }
    assert.equal(url.pathname, "/api/site/pool");
    return Response.json({
      filters: { channel: "all", category: null, tag: null, q: url.searchParams.get("q"), tab: "time" },
      items: [],
      page,
      pageCount: 2,
      total: 21,
      todayCount: 0,
      freshness: "2026-10-25T00:00:00Z",
      generatedAt: "2026-10-25T00:00:00Z",
      facets: { sources: [], minerals: [] },
    });
  });
  return calls;
}
const load = (search = "") => route.loader({ params: { slug: "fixture" }, request: new Request(`https://reader.invalid/topics/fixture${search}`) });
function render(data: unknown, search = "") {
  const router = createMemoryRouter([{ id: "topic", path: "*", element: createElement(route.default) }], {
    initialEntries: [`/topics/fixture${search}`],
    hydrationData: { loaderData: { topic: data } },
  });
  try {
    return renderToStaticMarkup(createElement(RouterProvider, { router }));
  } finally {
    router.dispose();
  }
}

test("actual topic route consumes installed parts, their current page, news and entries", async (t) => {
  const calls = mockApi(t);
  const page = await load("?page=2");
  assert.equal(page.data.parts.fixture.page, 2);
  assert.ok(calls.includes("/api/site/topics/fixture?page=2"));
  assert.match(render(page, "?page=2"), /扩展第2页/);
  const first = await load();
  const meta = route.meta({ loaderData: first });
  assert.ok(meta.some((m: { name?: string; content?: string }) => m.name === "description" && m.content?.includes("部件新闻")));
  assert.match(JSON.stringify(meta), /部件条目/);
});

test("filtered results and lagging page counts never display unfiltered or first-page parts", async (t) => {
  mockApi(t, true);
  const filtered = await load("?q=铜&page=2");
  assert.equal(filtered.data.parts, undefined);
  assert.ok(!render(filtered, "?q=铜&page=2").includes("扩展第"));
  const current = await load("?page=2");
  assert.equal(current.data.page, 2);
  assert.equal(current.data.parts, undefined);
  assert.ok(!render(current, "?page=2").includes("扩展第1页"));
});

test("absent or hidden topic parts preserve the old description and omit extra blocks", async (t) => {
  mockApi(t, false, false);
  const data = await load();
  const description = route.meta({ loaderData: data }).find((m: { name?: string }) => m.name === "description").content;
  assert.equal(description, topic.definition);
  assert.equal(Array.isArray(route.meta({ loaderData: data }).find((m: object) => "script:ld+json" in m)["script:ld+json"]), false);
  assert.ok(!render(data).includes("扩展第"));
  data.data.parts = { fixture: { show: false, page: 1 } };
  assert.ok(!render(data).includes("扩展第"));
});
