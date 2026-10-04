import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { apiBaseFor, isPrivateApiPath, privateHostHeaders } from "../api-target.ts";
import { adminGet } from "../app/lib/admin.server.ts";
import { devEdge } from "../vite.config.ts";
import { privateWebHostname } from "../host-policy.ts";
import { fetchWithHost } from "../http-probe.ts";

const PRIVATE_HOST = "private.localhost:8443";
const env = { API_BASE_URL: "http://public.test:3001", PRIVATE_API_BASE_URL: "http://private.test:3002" };

test("web dev and start commands supply the private API default and preserve an explicit target", (t) => {
  const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts as Record<string, string>;
  const bin = mkdtempSync(path.join(tmpdir(), "amp-web-command-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  // Observe the environment actually delivered by each package command, without starting a second web server.
  const probe = `#!/bin/sh\nexec "$FIXTURE_NODE" -e 'process.stdout.write(JSON.stringify({API_BASE_URL:process.env.API_BASE_URL,PRIVATE_API_BASE_URL:process.env.PRIVATE_API_BASE_URL}))'\n`;
  for (const name of ["react-router", "node"]) writeFileSync(path.join(bin, name), probe, { mode: 0o700 });
  for (const name of ["dev", "start"]) {
    for (const target of [undefined, "http://127.0.0.1:49002"]) {
      const result = spawnSync("/bin/sh", ["-c", scripts[name]!], {
        env: { PATH: bin, FIXTURE_NODE: process.execPath, API_BASE_URL: env.API_BASE_URL, ...(target ? { PRIVATE_API_BASE_URL: target } : {}) },
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      const supplied = JSON.parse(result.stdout);
      assert.equal(apiBaseFor("/api/auth/options", supplied), target ?? "http://127.0.0.1:3002");
      assert.equal(apiBaseFor("/api/site/items", supplied), env.API_BASE_URL);
    }
  }
});

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
  const configure = devEdge({ API_BASE_URL: local[0], PRIVATE_API_BASE_URL: local[1], PRIVATE_HOST: "private.localhost" }).configureServer;
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
    const response = await fetchWithHost(origin + path, PRIVATE_HOST, { headers: { "X-Forwarded-Host": "spoofed.invalid" } });
    assert.deepEqual(await response.json(), { target: "private", path, forwarded: PRIVATE_HOST });
  }
  for (const path of ["/api/auth/options", "/admin/login", "/%61dmin/login.data", "/sources/old"]) {
    const response = await fetch(origin + path, { redirect: "manual", headers: { "X-Forwarded-Host": PRIVATE_HOST } });
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get("Set-Cookie"), null);
    await response.text();
  }
  const path = "/api/site/items?q=/api/auth/options";
  assert.deepEqual(await (await fetch(origin + path)).json(), { target: "public", path, forwarded: null });
});

test("private Host configuration shares API normalization and cannot identify the public site", () => {
  assert.equal(privateWebHostname({ SITE_URL: "https://public.test", PRIVATE_HOST: "PRIVATE.test:8443" }), "private.test");
  assert.equal(privateWebHostname({ SITE_URL: "https://public.test", PRIVATE_HOST: "[::1]:8443" }), "[::1]");
  for (const value of ["public.test:8443", "private.test,public.test", "user@private.test", "https://private.test", "private%2etest"])
    assert.throws(() => privateWebHostname({ SITE_URL: "https://public.test", PRIVATE_HOST: value }), /PRIVATE_HOST/);
});
