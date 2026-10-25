import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { config } from "@amp/backend/config";
import { getBoss, stopBoss } from "@amp/backend/jobs/queue";
import { installModules, serverModules } from "@amp/backend/modules";
import { buildApp } from "../apps/api/src/app.ts";

const original = { modules: serverModules(), admin: config.devAdmin, host: config.privateHost };
config.privateHost = "module-admin.private.test";
config.devAdmin = null;
await getBoss();
const app = await buildApp("private-api"),
  reader = await buildApp("public-api");
const read = (url: string) => app.inject({ url, headers: { "x-forwarded-host": config.privateHost! } });
after(async () => {
  installModules(original.modules);
  config.devAdmin = original.admin;
  config.privateHost = original.host;
  await app.close();
  await reader.close();
  await stopBoss();
  await closeDb();
});

test("administrative module reads require authentication and stay absent from the public API", async () => {
  let calls = 0;
  installModules([
    {
      name: "fixture",
      admin: {
        counts: {
          fixture: async () => {
            calls++;
            return 2;
          },
        },
        runs: async () => {
          calls++;
          return { waiting: 3 };
        },
      },
    },
  ]);
  for (const url of ["/api/admin/nav-counts", "/api/admin/runs"]) {
    assert.equal((await read(url)).statusCode, 401);
    assert.equal((await reader.inject(url)).statusCode, 404);
  }
  assert.equal(calls, 0);
  config.devAdmin = { displayName: "Synthetic operator" };
  const counts = await read("/api/admin/nav-counts");
  assert.equal(counts.statusCode, 200, counts.body);
  assert.equal(counts.json().fixture, 2);
  assert.equal(typeof counts.json().feedback, "number");
  const runs = await read("/api/admin/runs");
  assert.equal(runs.statusCode, 200, runs.body);
  assert.deepEqual(runs.json().modules, { fixture: { status: "ready", data: { waiting: 3 } } });
  assert.equal(calls, 2);
});

test("invalid or conflicting module counts fail visibly without replacing core counts or exposing errors", async () => {
  config.devAdmin = { displayName: "Synthetic operator" };
  const bad = [
    async () => -1,
    async () => 1.5,
    async () => Infinity,
    async () => {
      throw Error("private-fixture-secret");
    },
  ];
  for (const count of bad) {
    installModules([{ name: "invalid", admin: { counts: { fixture: count } } }]);
    const result = await read("/api/admin/nav-counts");
    assert.equal(result.statusCode, 503, result.body);
    assert.ok(!result.body.includes("private-fixture-secret"));
  }
  for (const key of ["runs", "same"]) {
    let called = false;
    installModules([
      { name: "first", admin: { counts: { same: async () => 3 } } },
      {
        name: "second",
        admin: {
          counts: {
            [key]: async () => {
              called = true;
              return 99;
            },
          },
        },
      },
    ]);
    assert.equal((await read("/api/admin/nav-counts")).statusCode, 503);
    assert.equal(called, false, "a conflicting callback is not run");
  }
});

test("module run failures and non-JSON values stay isolated from other module and core diagnostics", async () => {
  config.devAdmin = { displayName: "Synthetic operator" };
  const before = (await sql`SELECT count(*)::int AS n FROM receipts`)[0].n;
  installModules([
    { name: "ready", admin: { runs: async () => ({ waiting: 4 }) } },
    {
      name: "failed",
      admin: {
        runs: async () => {
          throw Error("private-fixture-secret");
        },
      },
    },
    { name: "invalid", admin: { runs: async () => ({ value: 1n }) } },
  ]);
  const result = await read("/api/admin/runs");
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json().modules, {
    ready: { status: "ready", data: { waiting: 4 } },
    failed: { status: "unavailable" },
    invalid: { status: "unavailable" },
  });
  assert.ok(Array.isArray(result.json().jobs));
  assert.ok(!result.body.includes("private-fixture-secret"));
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts`)[0].n, before);
  installModules([]);
  assert.equal(Object.hasOwn((await read("/api/admin/runs")).json(), "modules"), false);
});
