import assert from "node:assert/strict";
import { test } from "node:test";
import { closeDb, dbOf, DB_MODULES, initializeDb } from "@amp/backend/db";
import { backupDatabaseUrl, queueConnection } from "../packages/backend/src/db-bootstrap.ts";

const address = (user: string) => `postgres://${user}@127.0.0.1:1/bootstrap_test`;

test("the public root assigns feedback a separate role and all other modules the read role", async () => {
  await initializeDb("public-api", { DATABASE_URL_PUBLIC_READ: address("reader"), DATABASE_URL_FEEDBACK_WRITE: address("feedback") });
  try {
    for (const module of DB_MODULES) assert.equal(dbOf(module).options.user, module === "feedback" ? "feedback" : "reader");
    assert.throws(() => queueConnection(), /cannot use the job queue/);
    assert.throws(() => backupDatabaseUrl(), /cannot use database role backup/);
    await assert.rejects(initializeDb("test", { DATABASE_URL: address("other") }), /already initialized/);
  } finally {
    await Promise.all([closeDb(), closeDb()]);
  }
  await assert.rejects(Promise.resolve(dbOf("publication")`SELECT 1`), /not injected/);
});

test("the private root assigns identity its own login and leaves business modules on private_ops", async () => {
  await initializeDb("private-api", { DATABASE_URL_PRIVATE_OPS: address("operations"), DATABASE_URL_AUTH: address("identity") });
  try {
    for (const module of DB_MODULES) assert.equal(dbOf(module).options.user, module === "identity" ? "identity" : "operations");
    assert.deepEqual(queueConnection(), { connectionString: address("operations"), createSchema: false, migrate: false, supervise: false, schedule: false });
    assert.throws(() => backupDatabaseUrl(), /cannot use database role backup/);
  } finally {
    await closeDb();
  }
});

test("queue and backup capabilities use the active root and are revoked when closing starts", async () => {
  assert.throws(() => queueConnection(), /not initialized or closing/);
  assert.throws(() => backupDatabaseUrl(), /not initialized or closing/);
  for (const split of [false, true]) {
    const env = split ? { DATABASE_URL_WORKER: address("worker"), DATABASE_URL_BACKUP: address("backup") } : { DATABASE_URL: address("shared") };
    await initializeDb("worker", env);
    try {
      assert.deepEqual(queueConnection(), split ? { connectionString: address("worker"), createSchema: false } : { connectionString: address("shared") });
      assert.equal(backupDatabaseUrl(), address(split ? "backup" : "shared"));
    } finally {
      const closing = closeDb();
      assert.throws(() => queueConnection(), /not initialized or closing/);
      assert.throws(() => backupDatabaseUrl(), /not initialized or closing/);
      await closing;
    }
    assert.throws(() => queueConnection(), /not initialized or closing/);
    assert.throws(() => backupDatabaseUrl(), /not initialized or closing/);
  }
});

test("worker, migration and test roots use their declared roles; invalid setup can be retried", async () => {
  await assert.rejects(initializeDb("public-api", { DATABASE_URL_PUBLIC_READ: address("reader") }), /Missing/);
  for (const [role, env, user] of [
    ["worker", { DATABASE_URL_WORKER: address("worker"), DATABASE_URL_BACKUP: address("backup") }, "worker"],
    ["migrate", { DATABASE_URL_MIGRATE: address("migrator") }, "migrator"],
    ["test", { DATABASE_URL: address("fixture") }, "fixture"],
    ["api", { DATABASE_URL: address("transitional") }, "transitional"],
  ] as const) {
    await initializeDb(role, env);
    try {
      for (const module of DB_MODULES) assert.equal(dbOf(module).options.user, user);
      if (role === "migrate") assert.throws(() => queueConnection(), /cannot use the job queue/);
      if (role === "api" || role === "test") assert.deepEqual(queueConnection(), { connectionString: address(user) });
    } finally {
      await closeDb();
    }
  }
});
