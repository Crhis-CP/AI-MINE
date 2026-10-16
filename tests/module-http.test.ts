import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { dbOf, closeDb } from "@amp/backend/db";
import { installModules } from "@amp/backend/modules";
import { SERVER_MODULES } from "../site/modules/server.ts";
import { buildApp } from "../apps/api/src/app.ts";
import { MetalPrices } from "@amp/contracts/http/public";
const sql = dbOf("publication");
after(async () => {
  installModules([]);
  await closeDb();
});
test("price HTTP belongs to the installed extension and remains a read-only public route", async () => {
  installModules([]);
  const core = await buildApp("public-api");
  try {
    assert.equal((await core.inject("/api/site/metal-prices")).statusCode, 404);
  } finally {
    await core.close();
  }
  installModules(SERVER_MODULES);
  const site = await buildApp("public-api");
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

test("site management routes follow installation and stay absent from the legacy public API", async () => {
  for (const role of ["api", "private-api"] as const) {
    installModules([]);
    const core = await buildApp(role);
    try {
      assert.equal(core.hasRoute({ method: "GET", url: "/api/admin/site" }), false);
      assert.equal(core.hasRoute({ method: "GET", url: "/api/admin/source-targets" }), false);
    } finally {
      await core.close();
    }
    installModules(SERVER_MODULES);
    const site = await buildApp(role);
    try {
      assert.equal(site.hasRoute({ method: "GET", url: "/api/admin/site" }), true);
      assert.equal(site.hasRoute({ method: "GET", url: "/api/admin/source-targets" }), true);
    } finally {
      await site.close();
    }
  }
  const reader = await buildApp("public-api");
  try {
    assert.equal(reader.hasRoute({ method: "GET", url: "/api/admin/site" }), false);
    assert.equal(reader.hasRoute({ method: "GET", url: "/api/admin/source-targets" }), false);
  } finally {
    await reader.close();
  }
});
