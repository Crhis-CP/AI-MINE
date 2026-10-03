import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabaseAccess, databaseConfig, DATABASE_ROLES, PROCESS_DATABASE_ROLES, type ProcessRole, type QueryRole } from "@amp/config";

const url = "postgres://postgres@127.0.0.1:1/config_test";
const key = (role: string) => `DATABASE_URL_${role.toUpperCase()}`;

test("each process can select only its database roles, even in single-URL transition", () => {
  for (const [name, allowed] of Object.entries(PROCESS_DATABASE_ROLES)) {
    const config = databaseConfig(name as ProcessRole, allowed.length ? { DATABASE_URL: url } : {});
    for (const role of DATABASE_ROLES) {
      if ((allowed as readonly string[]).includes(role)) assert.equal(config.urlFor(role), url);
      else assert.throws(() => config.urlFor(role), /cannot use database role/);
    }
  }
});

test("split addresses must be complete for this process and must not include another process's roles", () => {
  for (const name of ["public-api", "private-api", "worker", "migrate"] as const) {
    const allowed = PROCESS_DATABASE_ROLES[name];
    const env = Object.fromEntries(allowed.map((role) => [key(role), `${url}_${role}`]));
    const config = databaseConfig(name, env);
    assert.equal(config.split, true);
    for (const role of allowed) assert.equal(config.urlFor(role), env[key(role)]);
    const forbidden = DATABASE_ROLES.find((role) => !(allowed as readonly string[]).includes(role))!;
    assert.throws(() => databaseConfig(name, { ...env, [key(forbidden)]: url }), /must not hold/);
    if (allowed.length > 1) {
      delete env[key(allowed[0])];
      assert.throws(() => databaseConfig(name, { ...env, DATABASE_URL: url }), /Missing DATABASE_URL_/);
    }
  }
});

test("invalid or empty role URLs never silently fall back, and diagnostics do not print values", () => {
  const sensitive = ["postgres://user:", "private-test-value", "@localhost/"].join("");
  assert.throws(
    () => databaseConfig("migrate", { DATABASE_URL_MIGRATE: sensitive }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes("private-test-value"));
      return true;
    },
  );
  for (const value of ["", " ", "https://localhost/example", "postgres://localhost/"]) {
    assert.throws(() => databaseConfig("migrate", { DATABASE_URL_MIGRATE: value, DATABASE_URL: url }));
  }
  assert.throws(() => databaseConfig("migrate", { DATABASE_URL_TYPO: url, DATABASE_URL: url }), /Unknown database role variable/);
  for (const name of ["web", "fetcher"] as const) {
    assert.throws(() => databaseConfig(name, { DATABASE_URL: url }), /must not hold/);
    assert.throws(() => databaseConfig(name, { DATABASE_URL_WORKER: url }), /must not hold/);
  }
  assert.throws(() => databaseConfig("test", { DATABASE_URL: "postgres://localhost/production" }), /ending in _test or _ci/);
  assert.throws(() => databaseConfig("unknown" as ProcessRole, {}), /Unknown process role/);
  for (const value of ["", "0", "-1", "2.5", "NaN", "Infinity"]) {
    assert.throws(() => databaseConfig("migrate", { DATABASE_URL: url, DATABASE_POOL_MAX: value }), /positive integer/);
  }
});

test("shared fallback reuses one pool, denies backup as a query role, and closes permanently", async () => {
  const warnings: string[] = [];
  const access = createDatabaseAccess("public-api", { DATABASE_URL: url }, (message) => warnings.push(message));
  const first = access.dbFor("public_read");
  assert.equal(access.dbFor("feedback_write"), first);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("没有按角色分登录"));
  assert.ok(!warnings[0].includes(url));
  assert.throws(() => access.dbFor("worker"), /cannot use/);
  assert.throws(() => access.backupUrl(), /cannot use/);
  assert.throws(() => access.dbFor("backup" as QueryRole), /reserved for pg_dump/);
  await access.close();
  await access.close();
  assert.throws(() => access.dbFor("public_read"), /closed/);
});

test("split roles use their assigned addresses without connecting during construction", async () => {
  const access = createDatabaseAccess("worker", { DATABASE_URL_WORKER: url, DATABASE_URL_BACKUP: `${url}_backup` }, () =>
    assert.fail("split mode must not warn"),
  );
  assert.equal(access.backupUrl(), `${url}_backup`);
  assert.equal(access.dbFor("worker"), access.dbFor("worker"));
  await access.close();
});

test("role-selected connections preserve numeric decoding and support real transactions", async (t) => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return t.skip("needs the isolated verify database");
  const access = createDatabaseAccess("test", { DATABASE_URL: databaseUrl }, () => {});
  try {
    const result = await access.dbFor("worker").begin(async (sql) => sql`SELECT 42::bigint AS integer, 1.25::numeric AS decimal`);
    assert.equal(result[0].integer, 42);
    assert.equal(result[0].decimal, 1.25);
  } finally {
    await access.close();
  }
});
