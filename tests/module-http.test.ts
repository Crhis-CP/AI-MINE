import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { installModules } from "@amp/backend/modules";
import { SERVER_MODULES } from "../site/modules/server.ts";
import { buildApp } from "../apps/api/src/app.ts";
import { MetalPrices } from "@amp/contracts/http/public";

after(async () => {
  installModules([]);
  await closeDb();
});
test("price HTTP belongs to the installed extension and remains a read-only public route", async () => {
  installModules([]);
  const core = await buildApp();
  try {
    assert.equal((await core.inject("/api/site/metal-prices")).statusCode, 404);
  } finally {
    await core.close();
  }
  installModules(SERVER_MODULES);
  const site = await buildApp();
  try {
    const [before] = await sql`SELECT (SELECT count(*) FROM receipts)::int AS receipts,(SELECT count(*) FROM publication.metal_prices)::int AS prices`;
    const result = await site.inject("/api/site/metal-prices");
    assert.equal(result.statusCode, 200, result.body);
    assert.ok(MetalPrices.safeParse(result.json()).success);
    const unchanged = await site.inject({ url: "/api/site/metal-prices", headers: { "if-none-match": String(result.headers.etag) } });
    assert.equal(unchanged.statusCode, 304);
    assert.equal(unchanged.body, "");
    const [afterRead] = await sql`SELECT (SELECT count(*) FROM receipts)::int AS receipts,(SELECT count(*) FROM publication.metal_prices)::int AS prices`;
    assert.deepEqual(afterRead, before);
  } finally {
    await site.close();
  }
});

test("module administration follows installation and retains authentication", async () => {
  installModules([]);
  const core = await buildApp();
  try {
    assert.equal(core.hasRoute({ method: "GET", url: "/api/admin/site" }), false);
    assert.equal(core.hasRoute({ method: "GET", url: "/api/admin/source-targets" }), false);
  } finally {
    await core.close();
  }
  installModules(SERVER_MODULES);
  const site = await buildApp();
  try {
    for (const url of ["/api/admin/site", "/api/admin/source-targets"]) {
      assert.equal(site.hasRoute({ method: "GET", url }), true);
      assert.equal((await site.inject(url)).statusCode, 401, "installation does not authorize anonymous users");
    }
  } finally {
    await site.close();
  }
});

test("policy reading endpoints are provided by the installed module without requiring policy processing", async () => {
  installModules([]);
  const core = await buildApp();
  try {
    assert.equal((await core.inject("/api/site/policies/scope")).statusCode, 404);
    assert.equal((await core.inject("/api/site/jurisdictions")).statusCode, 200);
  } finally {
    await core.close();
  }
  installModules(SERVER_MODULES);
  const site = await buildApp();
  try {
    assert.equal((await site.inject("/api/site/policies/scope")).statusCode, 200);
    assert.ok(site.hasRoute({ method: "GET", url: "/api/site/policies/:id" }));
    assert.ok(site.hasRoute({ method: "GET", url: "/api/v1/policies/:id" }));
  } finally {
    await site.close();
  }
});
