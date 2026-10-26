import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@amp/backend/config";
import { closeDb } from "@amp/backend/db";
import { buildApp } from "./site-app.ts";

const HOST = "private.example.test";
const savedHost = config.privateHost;
const savedPassword = config.adminPassword;
const savedDevAdmin = config.devAdmin;
config.adminPassword = "route-test-password-123456";
config.devAdmin = null;
delete process.env.FEISHU_LOGIN_APP_ID;
delete process.env.FEISHU_LOGIN_APP_SECRET;
config.privateHost = HOST;
const api = await buildApp();
config.privateHost = savedHost;
const forwarded = { host: "api:3001", "x-forwarded-host": HOST };
after(async () => {
  config.privateHost = savedHost;
  config.adminPassword = savedPassword;
  config.devAdmin = savedDevAdmin;
  await api.close();
  await closeDb();
});

test("the unified root serves public route families and feedback on reader or admin hosts", async () => {
  const examples = [
    { method: "GET", url: "/api/site/meta", status: 200 },
    { method: "GET", url: "/og/site.png", status: 200 },
    { method: "GET", url: "/feed.xml", status: 200 },
    { method: "GET", url: "/robots.txt", status: 200 },
    { method: "OPTIONS", url: "/api/mcp", status: 204 },
    { method: "GET", url: "/api/v1/items?limit=1", status: 200 },
    { method: "POST", url: "/api/site/feedback", status: 400, payload: { content: "" } },
  ] as const;
  for (const example of examples) {
    const { status, ...request } = example;
    const found = await api.inject({ ...request, headers: { host: "localhost" } });
    assert.equal(found.statusCode, status, `${example.url}: ${found.body.slice(0, 300)}`);
    const onAdminHost = await api.inject({ ...request, headers: forwarded });
    assert.equal(onAdminHost.statusCode, status, example.url);
  }
  assert.equal(api.hasRoute({ method: "GET", url: "/api/mcp" }), true);

  const fallback = await api.inject("/api/v1/missing");
  assert.equal(fallback.statusCode, 404);
  assert.equal(fallback.headers["access-control-allow-origin"], "*");
  const privateFallback = await api.inject({ url: "/api/v1/missing", headers: forwarded });
  assert.equal(privateFallback.headers["access-control-allow-origin"], "*");
});

test("auth and administration remain protected within the unified API", async () => {
  for (const [url, status] of [
    ["/api/auth/options", 200],
    ["/api/auth/login", 302],
    ["/api/admin/me", 401],
    ["/api/admin/sources", 401],
  ] as const) {
    assert.equal((await api.inject({ url, headers: { host: "reader.example.test" } })).statusCode, 404, url);
    assert.equal((await api.inject({ url, headers: forwarded })).statusCode, status, url);
  }
  for (const app of [api]) {
    assert.equal((await app.inject({ method: "POST", url: "/api/ingest/items", headers: forwarded })).statusCode, 404);
    assert.equal((await app.inject({ url: "/api/img-proxy", headers: forwarded })).statusCode, 404);
  }
});

test("protected routes accept one matching forwarded hostname, with case and optional port normalization", async () => {
  for (const value of [HOST, "PRIVATE.EXAMPLE.TEST", `${HOST}:8443`]) {
    const result = await api.inject({ url: "/api/auth/options", headers: { host: "internal:3001", "x-forwarded-host": value } });
    assert.equal(result.statusCode, 200, value);
    assert.deepEqual(result.json(), { password: true, feishu: false });
  }
});

test("missing, forged, multiple and malformed forwarded authorities fail before redirects or authentication", async () => {
  const invalid = [
    undefined,
    "public.example.test",
    `${HOST}.evil.test`,
    `${HOST}, public.example.test`,
    `${HOST}, ${HOST}`,
    [HOST, HOST],
    [HOST, "public.example.test"],
    `https://${HOST}`,
    `user@${HOST}`,
    `${HOST}/path`,
    `${HOST}?query`,
    `${HOST}#fragment`,
    `${HOST}\\path`,
    `${HOST}:bad`,
    `${HOST}:65536`,
    "private.%65xample.test",
  ];
  for (const value of invalid) {
    const headers = { host: HOST, forwarded: `host=${HOST}`, ...(value === undefined ? {} : { "x-forwarded-host": value }) };
    for (const url of ["/api/auth/login?return=/admin", "/api/admin/me"]) {
      const result = await api.inject({ url, headers });
      assert.equal(result.statusCode, 404, `${String(value)} ${url}`);
      assert.equal(result.headers.location, undefined);
      assert.equal(result.headers["set-cookie"], undefined);
    }
    const password = await api.inject({ method: "POST", url: "/api/auth/password", headers, payload: { password: config.adminPassword } });
    assert.equal(password.statusCode, 404);
    assert.equal(password.headers.location, undefined);
    assert.equal(password.headers["set-cookie"], undefined);
  }
});

test("health is independent of the admin Host and public redirects remain public", async () => {
  for (const app of [api]) {
    for (const headers of [{}, { "x-forwarded-host": "wrong.test, wrong.test" }]) {
      const result = await app.inject({ url: "/api/health?probe=1", headers });
      assert.equal(result.statusCode, 200);
      assert.equal(result.json().db, "ok");
    }
  }
  for (const app of [api]) {
    const result = await app.inject("/rss?reader=test");
    assert.equal(result.statusCode, 301);
    assert.equal(result.headers.location, "/feed.xml?reader=test");
  }
  const privateRedirect = await api.inject({ url: "/rss?reader=test", headers: forwarded });
  assert.equal(privateRedirect.statusCode, 301);
  assert.equal(privateRedirect.headers.location, "/feed.xml?reader=test");
});

test("a matching private host reaches the real password/session guard without bypassing login", async () => {
  assert.equal((await api.inject({ url: "/api/admin/me", headers: forwarded })).statusCode, 401);
  const nonce = await api.inject({ url: "/api/auth/password-nonce", headers: forwarded });
  const login = await api.inject({
    method: "POST",
    url: "/api/auth/password",
    headers: { ...forwarded, cookie: String(nonce.headers["set-cookie"]).split(";")[0]!, "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ login_name: "admin@local", login_nonce: nonce.json().token, password: config.adminPassword!, return: "/admin" }).toString(),
  });
  assert.equal(login.statusCode, 303);
  assert.equal(login.headers.location, "/admin");
  const passwordOnlyNonce = await api.inject({ url: "/api/auth/password-nonce", headers: forwarded });
  const passwordOnly = await api.inject({
    method: "POST",
    url: "/api/auth/password",
    headers: {
      ...forwarded,
      cookie: String(passwordOnlyNonce.headers["set-cookie"]).split(";")[0]!,
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: new URLSearchParams({ login_nonce: passwordOnlyNonce.json().token, password: config.adminPassword!, return: "/admin" }).toString(),
  });
  assert.equal(passwordOnly.statusCode, 303);
  assert.equal(passwordOnly.headers.location, "/admin");
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  assert.match(cookie, /^amp_admin=/);
  const me = await api.inject({ url: "/api/admin/me", headers: { ...forwarded, cookie } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().dev, false);
  assert.equal((await api.inject({ url: "/api/admin/me", headers: { host: HOST, cookie } })).statusCode, 404);
  const csrf = await api.inject({ method: "POST", url: "/api/admin/sources", headers: { ...forwarded, cookie }, payload: {} });
  assert.equal(csrf.statusCode, 403, "host matching must not bypass CSRF");
});

test("an unset private host keeps local development usable; a malformed configured authority fails closed", async () => {
  for (const [host, expected] of [
    [null, 200],
    [`https://${HOST}`, 404],
    ["   ", 404],
  ] as const) {
    config.privateHost = host;
    const app = await buildApp();
    config.privateHost = savedHost;
    try {
      assert.equal((await app.inject({ url: "/api/auth/options", headers: host === null ? {} : forwarded })).statusCode, expected);
    } finally {
      await app.close();
    }
  }
});

test("one API serves public reads and guarded administration without applying the private host gate to readers", async () => {
  config.privateHost = HOST;
  const app = await buildApp();
  config.privateHost = savedHost;
  try {
    assert.equal((await app.inject({ url: "/api/site/meta", headers: { host: "reader.example.test" } })).statusCode, 200);
    const reader = await app.inject({ url: "/api/site/meta", headers: { host: "reader.example.test", cookie: "__Host-amp_admin=invalid" } });
    assert.equal(reader.statusCode, 200);
    assert.equal(reader.headers["set-cookie"], undefined);
    for (const url of ["/api/auth/options", "/api/admin/me", "/mcp-ops"]) {
      const method = url === "/mcp-ops" ? "POST" : "GET";
      assert.equal((await app.inject({ method, url, headers: { host: "reader.example.test" } })).statusCode, 404, url);
    }
    assert.equal((await app.inject({ url: "/api/auth/options", headers: forwarded })).statusCode, 200);
    assert.equal((await app.inject({ url: "/api/admin/me", headers: forwarded })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/mcp-ops", headers: forwarded, payload: {} })).statusCode, 401);
    assert.equal((await app.inject({ url: "/api/admin/me", headers: { ...forwarded, "x-forwarded-host": `${HOST}, other.test` } })).statusCode, 404);
    assert.ok(app.hasRoute({ method: "GET", url: "/api/site/metal-prices" }));
    assert.ok(!app.hasRoute({ method: "POST", url: "/api/ingest/items" }));
  } finally {
    await app.close();
    config.privateHost = savedHost;
  }
});
