import assert from "node:assert/strict";
import { test } from "node:test";
import { closeDb, dbOf, DB_MODULES, initializeDb } from "@amp/backend/db";

const address = (user: string) => `postgres://${user}@127.0.0.1:1/bootstrap_test`;

test("the public root assigns feedback a separate role and all other modules the read role", async () => {
  await initializeDb("public-api", { DATABASE_URL_PUBLIC_READ: address("reader"), DATABASE_URL_FEEDBACK_WRITE: address("feedback") });
  try {
    for (const module of DB_MODULES) assert.equal(dbOf(module).options.user, module === "feedback" ? "feedback" : "reader");
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
  } finally {
    await closeDb();
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
    } finally {
      await closeDb();
    }
  }
});
