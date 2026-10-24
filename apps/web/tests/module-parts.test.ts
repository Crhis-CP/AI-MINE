import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { createServer } from "vite";

const file = (value: string) => fileURLToPath(new URL(value, import.meta.url));
const server = await createServer({
  configFile: false,
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { alias: { "./group.css": file("../app/public.css") } },
});
after(() => server.close());
const { WEB_MODULES } = await server.ssrLoadModule(file("../../../site/modules/web.ts"));
WEB_MODULES.push({
  name: "fixture-reader",
  root: { documentHeaders: (request: Request) => ({ "X-Module-Path": new URL(request.url).pathname }) },
  sidebar: { section: "合成扩展导航", items: [{ to: "/fixture-side", label: "合成侧栏入口", icon: () => null }] },
  tools: [{ to: "/fixture-tool", label: "合成工具入口", icon: null }],
  starredImports: [{ label: "合成收藏导入", run: async () => ({ ok: false, text: "未完成" }) }],
});
after(() => WEB_MODULES.pop());

test("installed reader additions reach their existing page consumers without replacing core entries", async (t) => {
  const { loader } = await server.ssrLoadModule(file("../app/root.tsx"));
  assert.deepEqual(Object.keys(loader()), ["release"], "module request context must not leak into response headers or loader data");
  const seen: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(new URL(String(input)).pathname, "/api/site/meta");
    seen.push(new Headers(init?.headers).get("X-Module-Path") ?? "");
    return Response.json({ changelogVersion: "fixture-version" });
  });
  const { loader: metaLoader } = await server.ssrLoadModule(file("../app/routes/public-layout.tsx"));
  assert.deepEqual(await metaLoader({ request: new Request("https://example.invalid/more") }), { changelogVersion: "fixture-version" });
  assert.deepEqual(seen, ["/more"], "metadata request receives the module's document context");
  const { SIDEBAR, MORE_PATHS } = await server.ssrLoadModule(file("../app/components/shell/nav.ts"));
  assert.ok(SIDEBAR.some((group: { title: string }) => group.title === "合成扩展导航"));
  assert.ok(SIDEBAR.some((group: { items: { to: string }[] }) => group.items.some((item) => item.to === "/all")));
  assert.ok(MORE_PATHS.includes("/fixture-tool"));
  const { default: More } = await server.ssrLoadModule(file("../app/routes/more.tsx"));
  const render = (Component: typeof More) => {
    const router = createMemoryRouter([{ path: "/", element: createElement(Component) }]);
    try {
      return renderToStaticMarkup(createElement(RouterProvider, { router }));
    } finally {
      router.dispose();
    }
  };
  const more = render(More);
  assert.match(more, /合成工具入口/);
  assert.match(more, /href="\/fixture-tool"/);
  assert.equal((more.match(/href="\/metals"/g) ?? []).length, 1, "personal page has one metal-price entry, including its legacy navigation mapping");
  const { default: Starred } = await server.ssrLoadModule(file("../app/routes/starred.tsx"));
  const starred = render(Starred);
  assert.match(starred, /合成收藏导入/);
  assert.match(starred, /导出收藏与已读记录/);
});
