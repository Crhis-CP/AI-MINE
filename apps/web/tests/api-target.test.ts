import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { apiBaseFor, apiForwardHeaders, isPrivateApiPath, privateHostHeaders } from "../api-target.ts";
import { adminGet } from "../app/lib/admin.server.ts";
import { devEdge } from "../vite.config.ts";
import { privateWebHostname, webHostPolicy } from "../host-policy.ts";
import { fetchWithHost } from "../http-probe.ts";

const PRIVATE_HOST = "private.localhost:8443";
const env = { API_BASE_URL: "http://public.test:3001", PRIVATE_API_BASE_URL: "http://private.test:3002" };

test("web dev and start commands supply the private API default and preserve an explicit target", (t) => {
  const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts as Record<string, string>;
  const bin = mkdtempSync(path.join(tmpdir(), "amp-web-command-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  // Observe the environment actually delivered by each package command, without starting a second web server.
  const probe = `#!/bin/sh\nexec "$FIXTURE_NODE" -e 'process.stdout.write(JSON.stringify({API_BASE_URL:process.env.API_BASE_URL,PRIVATE_API_BASE_URL:process.env.PRIVATE_API_BASE_URL,WEB_ROUTE_GROUP:process.env.WEB_ROUTE_GROUP}))'\n`;
  for (const name of ["react-router", "node"]) writeFileSync(path.join(bin, name), probe, { mode: 0o700 });
  for (const name of ["dev", "dev:private", "start"]) {
    for (const target of [undefined, "http://127.0.0.1:49002"]) {
      const result = spawnSync("/bin/sh", ["-c", scripts[name]!], {
        env: { PATH: bin, FIXTURE_NODE: process.execPath, API_BASE_URL: env.API_BASE_URL, ...(target ? { PRIVATE_API_BASE_URL: target } : {}) },
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      const supplied = JSON.parse(result.stdout);
      assert.equal(supplied.WEB_ROUTE_GROUP, name === "start" ? undefined : name === "dev" ? "public" : "private");
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

test("private Host configuration shares API normalization and permits the public site", () => {
  assert.equal(privateWebHostname({ SITE_URL: "https://public.test", PRIVATE_HOST: "PRIVATE.test:8443" }), "private.test");
  assert.equal(privateWebHostname({ SITE_URL: "https://public.test", PRIVATE_HOST: "[::1]:8443" }), "[::1]");
  assert.equal(privateWebHostname({ SITE_URL: "https://public.test", PRIVATE_HOST: "public.test:8443" }), "public.test");
  for (const value of ["private.test,public.test", "user@private.test", "https://private.test", "private%2etest"])
    assert.throws(() => privateWebHostname({ SITE_URL: "https://public.test", PRIVATE_HOST: value }), /PRIVATE_HOST/);
});

test("same-origin private paths require one authoritative Host and remain uncacheable", () => {
  const policy = webHostPolicy({ SITE_URL: "https://site.test", PRIVATE_HOST: "site.test" });
  const probe = (url: string, host = "site.test", duplicate = false) => {
    const headers: Record<string, unknown> = {};
    let status = 200;
    const res = {
      setHeader: (key: string, value: unknown) => {
        headers[key] = value;
      },
      removeHeader: (key: string) => {
        delete headers[key];
      },
      writeHead: (code: number, values: object = {}) => {
        status = code;
        Object.assign(headers, values);
      },
      end: () => {},
    } as unknown as ServerResponse;
    const req = {
      url,
      headers: { host, "x-forwarded-host": "site.test" },
      rawHeaders: ["Host", host, ...(duplicate ? ["Host", host] : [])],
    } as unknown as IncomingMessage;
    const group = policy(req, res);
    if (group) res.writeHead(200, { "Cache-Control": "public, max-age=60", Expires: "tomorrow" });
    return { group, status, headers };
  };
  for (const pathname of [
    "/admin/login",
    "/admin/sources.data",
    "/ADMIN",
    "/%61dmin/login",
    "/api/admin/me",
    "/api/auth/options",
    "/admin/assets/x.js",
    "/sources",
  ]) {
    const found = probe(pathname);
    assert.equal(found.group, "private", pathname);
    assert.equal(found.headers["Cache-Control"], "private, no-store");
    assert.equal(found.headers["X-Accel-Expires"], "0");
    assert.equal(found.headers.Expires, undefined);
    for (const denied of [probe(pathname, "other.test"), probe(pathname, "site.test", true)]) {
      assert.equal(denied.group, null);
      assert.equal(denied.status, 404);
      assert.equal(denied.headers["Cache-Control"], "private, no-store");
      assert.equal(denied.headers["Set-Cookie"], undefined);
    }
  }
  for (const pathname of ["/", "/all", "/api/v1/items", "/assets/x.js", "/administrator"]) {
    const found = probe(pathname);
    assert.equal(found.group, "public", pathname);
    assert.equal(found.headers["Cache-Control"], "public, max-age=60");
  }
});

test("proxy headers remove cookies only from public API traffic without changing the input", () => {
  const input = {
    host: "site.test",
    cookie: "amp_admin=synthetic",
    Cookie: "second-synthetic",
    accept: "application/json",
    "x-forwarded-host": "spoofed.test",
  };
  for (const pathname of ["/api/v1/items", "/api/site/feedback", "/feed.xml"]) {
    const headers = apiForwardHeaders(pathname, input);
    assert.equal(headers.cookie, undefined);
    assert.equal(headers.Cookie, undefined);
    assert.equal(headers.accept, input.accept);
  }
  for (const pathname of ["/api/admin/me", "/api/auth/password"]) {
    const headers = apiForwardHeaders(pathname, input);
    assert.equal(headers.cookie, input.cookie);
    assert.equal(headers["x-forwarded-host"], input.host);
  }
  assert.equal(input.cookie, "amp_admin=synthetic");
});
