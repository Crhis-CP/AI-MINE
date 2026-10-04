import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@amp/backend/config";
import { closeDb } from "@amp/backend/db";
import { buildApp } from "../apps/api/src/app.ts";

const HOST = "private.example.test";
const savedHost = config.privateHost;
const savedPassword = config.adminPassword;
const savedDevAdmin = config.devAdmin;
config.adminPassword = "route-test-password-123456";
config.devAdmin = null;
delete process.env.FEISHU_LOGIN_APP_ID;
delete process.env.FEISHU_LOGIN_APP_SECRET;
config.privateHost = HOST;
const publicApp = await buildApp("public-api");
const privateApp = await buildApp("private-api");
config.privateHost = savedHost;
const forwarded = { host: "private-api:3001", "x-forwarded-host": HOST };
after(async () => {
  config.privateHost = savedHost;
  config.adminPassword = savedPassword;
  config.devAdmin = savedDevAdmin;
  await Promise.all([publicApp.close(), privateApp.close()]);
  await closeDb();
});

test("public route families and feedback belong only to the public root", async () => {
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
    const found = await publicApp.inject({ ...request, headers: { host: "localhost" } });
    assert.equal(found.statusCode, status, `${example.url}: ${found.body.slice(0, 300)}`);
    const absent = await privateApp.inject({ ...request, headers: forwarded });
    assert.equal(absent.statusCode, 404, example.url);
  }
  assert.equal(publicApp.hasRoute({ method: "GET", url: "/api/mcp" }), true);
  assert.equal(privateApp.hasRoute({ method: "GET", url: "/api/mcp" }), false);
  const fallback = await publicApp.inject("/api/v1/missing");
  assert.equal(fallback.statusCode, 404);
  assert.equal(fallback.headers["access-control-allow-origin"], "*");
  const privateFallback = await privateApp.inject({ url: "/api/v1/missing", headers: forwarded });
  assert.equal(privateFallback.headers["access-control-allow-origin"], undefined);
});

test("auth and admin are private and an explicit role is mandatory", async () => {
  for (const [url, status] of [
    ["/api/auth/options", 200],
    ["/api/auth/login", 302],
    ["/api/admin/me", 401],
    ["/api/admin/sources", 401],
  ] as const) {
    assert.equal((await publicApp.inject({ url, headers: forwarded })).statusCode, 404, url);
    assert.equal((await privateApp.inject({ url, headers: forwarded })).statusCode, status, url);
  }
  for (const app of [publicApp, privateApp]) {
    assert.equal((await app.inject({ method: "POST", url: "/api/ingest/items", headers: forwarded })).statusCode, 404);
    assert.equal((await app.inject({ url: "/api/img-proxy", headers: forwarded })).statusCode, 404);
  }
  await assert.rejects(buildApp(undefined as never), /Invalid API role/);
  await assert.rejects(buildApp("other" as never), /Invalid API role/);
});

test("private root accepts one matching forwarded hostname, with case and optional port normalization", async () => {
  for (const value of [HOST, "PRIVATE.EXAMPLE.TEST", `${HOST}:8443`]) {
    const result = await privateApp.inject({ url: "/api/auth/options", headers: { host: "internal:3001", "x-forwarded-host": value } });
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
    for (const url of ["/api/auth/login?return=/admin", "/api/admin/me", "/sources"]) {
      const result = await privateApp.inject({ url, headers });
      assert.equal(result.statusCode, 404, `${String(value)} ${url}`);
      assert.equal(result.headers.location, undefined);
      assert.equal(result.headers["set-cookie"], undefined);
    }
    const password = await privateApp.inject({ method: "POST", url: "/api/auth/password", headers, payload: { password: config.adminPassword } });
    assert.equal(password.statusCode, 404);
    assert.equal(password.headers.location, undefined);
    assert.equal(password.headers["set-cookie"], undefined);
  }
});

test("health works on both roots regardless of forwarded hostname; public redirects remain public", async () => {
  for (const app of [publicApp, privateApp]) {
    for (const headers of [{}, { "x-forwarded-host": "wrong.test, wrong.test" }]) {
      const result = await app.inject({ url: "/api/health?probe=1", headers });
      assert.equal(result.statusCode, 200);
      assert.equal(result.json().db, "ok");
    }
  }
  for (const app of [publicApp]) {
    const result = await app.inject("/rss?reader=test");
    assert.equal(result.statusCode, 301);
    assert.equal(result.headers.location, "/feed.xml?reader=test");
  }
  const privateRedirect = await privateApp.inject({ url: "/rss?reader=test", headers: forwarded });
  assert.equal(privateRedirect.statusCode, 404);
  assert.equal(privateRedirect.headers.location, undefined);
});

test("a matching private host reaches the real password/session guard without bypassing login", async () => {
  assert.equal((await privateApp.inject({ url: "/api/admin/me", headers: forwarded })).statusCode, 401);
  const login = await privateApp.inject({
    method: "POST",
    url: "/api/auth/password",
    headers: { ...forwarded, "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ password: config.adminPassword!, return: "/admin" }).toString(),
  });
  assert.equal(login.statusCode, 303);
  assert.equal(login.headers.location, "/admin");
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  assert.match(cookie, /^amp_admin=/);
  const me = await privateApp.inject({ url: "/api/admin/me", headers: { ...forwarded, cookie } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().dev, false);
  assert.equal((await privateApp.inject({ url: "/api/admin/me", headers: { host: HOST, cookie } })).statusCode, 404);
  const csrf = await privateApp.inject({ method: "POST", url: "/api/admin/sources", headers: { ...forwarded, cookie }, payload: {} });
  assert.equal(csrf.statusCode, 403, "host matching must not bypass CSRF");
});

test("an unset private host keeps local development usable; a malformed configured authority fails closed", async () => {
  for (const [host, expected] of [
    [null, 200],
    [`https://${HOST}`, 404],
    ["   ", 404],
  ] as const) {
    config.privateHost = host;
    const app = await buildApp("private-api");
    config.privateHost = savedHost;
    try {
      assert.equal((await app.inject({ url: "/api/auth/options", headers: host === null ? {} : forwarded })).statusCode, expected);
    } finally {
      await app.close();
    }
  }
});
