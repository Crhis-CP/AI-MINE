import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { alias: { "@amp/site/modules/web": "\0fixture-marks" } },
  plugins: [
    {
      name: "fixture-marks",
      resolveId: (id) => (id === "\0fixture-marks" ? id : null),
      load: (id) => (id === "\0fixture-marks" ? `export const WEB_MODULES=[{name:'fixture',darkMarks:['/assets/owned-dark.svg']}];` : null),
    },
  ],
});
after(() => server.close());
const directory = await server.ssrLoadModule(fileURLToPath(new URL("../app/routes/topics.tsx", import.meta.url)));
const detail = await server.ssrLoadModule(fileURLToPath(new URL("../app/routes/topic.tsx", import.meta.url)));
const { BrandMark } = await server.ssrLoadModule(fileURLToPath(new URL("../app/components/BrandMark.tsx", import.meta.url)));
const topic = {
  slug: "fixture",
  name: "合成矿企",
  group: "company",
  definition: "说明",
  total: 1,
  recent: 1,
  indexable: false,
  latestAt: null,
  basis: "all",
  brand: { src: null, monogram: "合", raster: false },
};
function render(route: typeof directory, data: unknown) {
  const router = createMemoryRouter([{ id: "page", path: "*", element: createElement(route.default) }], {
    initialEntries: ["/topics/fixture"],
    hydrationData: { loaderData: { page: data } },
  });
  try {
    return renderToStaticMarkup(createElement(RouterProvider, { router }));
  } finally {
    router.dispose();
  }
}

test("actual directory and topic routes render decorative text marks without requesting images", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    assert.equal(init?.method ?? "GET", "GET");
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/api/site/topics") return Response.json({ topics: [topic] });
    if (pathname === "/api/site/topics/fixture") return Response.json({ topic: { ...topic, related: [] }, items: [], page: 1, pageCount: 1 });
    assert.equal(pathname, "/api/site/pool");
    return Response.json({
      filters: { channel: "all", category: null, tag: null, q: null, tab: "time" },
      items: [],
      page: 1,
      pageCount: 1,
      total: 1,
      todayCount: 0,
      freshness: "2026-10-25T00:00:00Z",
      generatedAt: "2026-10-25T00:00:00Z",
      facets: { sources: [], minerals: [] },
    });
  });
  const request = new Request("https://reader.invalid/topics/fixture");
  for (const html of [render(directory, await directory.loader({ request })), render(detail, await detail.loader({ request, params: { slug: "fixture" } }))]) {
    assert.match(html, /aria-hidden="true"[^>]*>合<\/span>/);
    assert.match(html, /合成矿企/);
    assert.doesNotMatch(html, /<img/);
  }
  const { brand: _, ...oldTopic } = topic;
  assert.doesNotMatch(render(directory, { topics: [oldTopic] }), /aria-hidden="true"[^>]*>合<\/span>/);
});

test("local artwork follows installed dark and raster styling; directory rejects remote marks", async (t) => {
  const mark = (src: string, raster = false) => renderToStaticMarkup(createElement(BrandMark, { brand: { src, monogram: "合", raster } }));
  assert.match(mark("/assets/owned-dark.svg"), /bg-\[#111\]/);
  assert.match(mark("/assets/owned-light.svg"), /dark:bg-white\/95/);
  assert.doesNotMatch(mark("/assets/owned-photo.png", true), /dark:bg-white\/95/);
  assert.match(mark("/assets/owned-dark.svg"), /alt="" loading="lazy" decoding="async"/);
  t.mock.method(globalThis, "fetch", async () => Response.json({ topics: [{ ...topic, brand: { ...topic.brand, src: "https://outside.invalid/logo.svg" } }] }));
  await assert.rejects(directory.loader({ request: new Request("https://reader.invalid/topics") }));
});
