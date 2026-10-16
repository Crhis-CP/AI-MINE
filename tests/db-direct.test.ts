import assert from "node:assert/strict";
import { test } from "node:test";
import { sql, identitySql, feedbackSql, initializeDb, closeDb } from "@amp/backend/db";

const address = (user: string) => `postgres://${user}@127.0.0.1:1/direct_test`;

test("direct connections require an explicit root and share one driver for one URL", async () => {
  assert.throws(() => sql`SELECT 1`, /not initialized/);
  const env = { DATABASE_URL: address("shared") };
  await initializeDb("test", env);
  const saved = sql;
  try {
    assert.equal(sql, identitySql);
    assert.equal(sql, feedbackSql);
    assert.equal(sql.options.user, "shared");
    await initializeDb("test", env);
    assert.equal(sql, saved);
    await assert.rejects(initializeDb("worker", env), /already initialized/);
    assert.equal(sql, saved, "a rejected initialization preserves the live binding");
  } finally {
    await closeDb();
  }
  assert.throws(() => sql`SELECT 1`, /not initialized/);
  await assert.rejects(async () => saved`SELECT 1`, /CONNECTION_ENDED/);
});

test("direct handles preserve the reader, feedback and identity connection boundaries", async () => {
  for (const [role, env, expected] of [
    ["public-api", { DATABASE_URL_PUBLIC_READ: address("reader"), DATABASE_URL_FEEDBACK_WRITE: address("inbox") }, ["reader", "reader", "inbox"]],
    ["private-api", { DATABASE_URL_PRIVATE_OPS: address("operations"), DATABASE_URL_AUTH: address("identity") }, ["operations", "identity", "operations"]],
  ] as const) {
    await initializeDb(role, env);
    try {
      assert.deepEqual([sql.options.user, identitySql.options.user, feedbackSql.options.user], expected);
    } finally {
      await closeDb();
    }
  }
});
