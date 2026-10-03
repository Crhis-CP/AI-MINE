import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { apiBaseFor, isPrivateApiPath, privateHostHeaders } from "../api-target.ts";
import { adminGet } from "../app/lib/admin.server.ts";
import { devEdge } from "../vite.config.ts";

const env = { API_BASE_URL: "http://public.test:3001", PRIVATE_API_BASE_URL: "http://private.test:3002" };

test("private path trees are distinct from lookalikes and query text; fallback never resolves the incoming host", () => {
  for (const path of ["/api/admin", "/api/admin?x=1", "/api/admin/sources?q=a%2Fb&q=", "/api/auth/options"])
    assert.equal(apiBaseFor(path, env), env.PRIVATE_API_BASE_URL);
  for (const path of [
    "/api/administrator",
    "/api/authors",
    "/api/site/items?q=/api/admin/x",
    "//evil.invalid/api/auth/options",
    "https://evil.invalid/api/admin",
    "/api/%61dmin/x",
  ]) {
    assert.equal(isPrivateApiPath(path), false);
    assert.equal(apiBaseFor(path, env), env.API_BASE_URL);
  }
  assert.equal(apiBaseFor("/api/auth/options", { API_BASE_URL: env.API_BASE_URL }), env.API_BASE_URL);
  assert.equal(apiBaseFor("/api/auth/options", { ...env, PRIVATE_API_BASE_URL: "" }), env.API_BASE_URL);
  assert.equal(apiBaseFor("/api/auth/options", {}), "http://127.0.0.1:3001");
  assert.deepEqual(privateHostHeaders("/api/auth/options", null), { "x-forwarded-host": "" });
});

test("admin loader uses inbound Host, not a spoofed forwarded header or Request URL", async () => {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = async (_input, init) => {
    seen.push(new Headers(init?.headers).get("x-forwarded-host")!);
    return Response.json({ ok: true });
  };
  try {
    for (const host of ["reader.test:8443", null]) {
      const headers = new Headers({ "x-forwarded-host": "spoofed.invalid" });
      if (host) headers.set("host", host);
      await adminGet(new Request("http://derived.invalid/admin", { headers }), "/api/admin/test");
    }
    assert.deepEqual(seen, ["reader.test:8443", ""]);
  } finally {
    globalThis.fetch = original;
  }
});

test("Vite devEdge forwards to two local APIs using the same path and Host rules", async (t) => {
  const apis = ["public", "private"].map((target) =>
    createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ target, path: req.url, forwarded: req.headers["x-forwarded-host"] ?? null }));
    }),
  );
  for (const api of apis) {
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
  }
  const local = apis.map((api) => `http://127.0.0.1:${(api.address() as AddressInfo).port}`);
  let middleware!: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
  const configure = devEdge({ API_BASE_URL: local[0], PRIVATE_API_BASE_URL: local[1] }).configureServer;
  assert.equal(typeof configure, "function");
  await (configure as (server: unknown) => void)({
    middlewares: {
      use(handler: typeof middleware) {
        middleware = handler;
      },
    },
  });
  const edge = createServer((req, res) =>
    middleware(req, res, () => {
      res.statusCode = 404;
      res.end();
    }),
  );
  t.after(async () => {
    for (const server of [edge, ...apis]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  edge.listen(0, "127.0.0.1");
  await once(edge, "listening");
  const origin = `http://127.0.0.1:${(edge.address() as AddressInfo).port}`;
  for (const path of ["/api/auth/options?a=%2F&a=", "/api/admin/sources?x=1"]) {
    const response = await fetch(origin + path, { headers: { "X-Forwarded-Host": "spoofed.invalid" } });
    assert.deepEqual(await response.json(), { target: "private", path, forwarded: new URL(origin).host });
  }
  const path = "/api/site/items?q=/api/auth/options";
  assert.deepEqual(await (await fetch(origin + path)).json(), { target: "public", path, forwarded: null });
});
