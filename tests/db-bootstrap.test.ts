import assert from "node:assert/strict";
import { test } from "node:test";
import { closeDb, sql, identitySql, feedbackSql, initializeDb } from "@amp/backend/db";
import { backupDatabaseUrl, queueConnection } from "../packages/backend/src/db-bootstrap.ts";

const address = (user: string) => `postgres://${user}@127.0.0.1:1/bootstrap_test`;

test("the public root assigns feedback a separate role and all other modules the read role", async () => {
  await initializeDb("public-api", { DATABASE_URL_PUBLIC_READ: address("reader"), DATABASE_URL_FEEDBACK_WRITE: address("feedback") });
  try {
    assert.deepEqual(
      [sql, identitySql, feedbackSql].map((db) => db.options.user),
      ["reader", "reader", "feedback"],
    );
    assert.throws(() => queueConnection(), /cannot use the job queue/);
    assert.throws(() => backupDatabaseUrl(), /cannot use database role backup/);
    await assert.rejects(initializeDb("test", { DATABASE_URL: address("other") }), /already initialized/);
  } finally {
    await Promise.all([closeDb(), closeDb()]);
  }
  assert.throws(() => sql`SELECT 1`, /not initialized/);
});

for (const role of ["private-api", "api"] as const)
  test(`${role} keeps identity separate and only produces jobs in existing queues`, async () => {
    await initializeDb(role, { DATABASE_URL_PRIVATE_OPS: address("operations"), DATABASE_URL_AUTH: address("identity") });
    try {
      assert.deepEqual(
        [sql, identitySql, feedbackSql].map((db) => db.options.user),
        ["operations", "identity", "operations"],
      );
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
  await assert.rejects(initializeDb("unknown-api" as never, {}), /cannot initialize/);
  await assert.rejects(initializeDb("public-api", { DATABASE_URL_PUBLIC_READ: address("reader") }), /Missing/);
  for (const [role, env, user] of [
    ["worker", { DATABASE_URL_WORKER: address("worker"), DATABASE_URL_BACKUP: address("backup") }, "worker"],
    ["migrate", { DATABASE_URL_MIGRATE: address("migrator") }, "migrator"],
    ["test", { DATABASE_URL: address("fixture") }, "fixture"],
  ] as const) {
    await initializeDb(role, env);
    try {
      assert.deepEqual(
        [sql, identitySql, feedbackSql].map((db) => db.options.user),
        [user, user, user],
      );
      if (role === "migrate") assert.throws(() => queueConnection(), /cannot use the job queue/);
      if (role === "test") assert.deepEqual(queueConnection(), { connectionString: address(user) });
    } finally {
      await closeDb();
    }
  }
});
