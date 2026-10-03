import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabaseAccess } from "@amp/config";
import { dbOf, injectDb } from "@amp/backend/db";

test("module queries and transactions fail closed without injection, even with a global database configured", async () => {
  const sql = dbOf("handle-unbound");
  const columns = sql`42 AS answer`;
  assert.equal(dbOf("handle-unbound"), sql);
  await assert.rejects(Promise.resolve(sql`SELECT ${columns}`), /not injected for module handle-unbound/);
  assert.throws(() => sql.begin(async () => 1), /not injected/);
  assert.throws(() => dbOf(" invalid "), /Invalid database module/);
});

test("registration is atomic and cannot silently replace an existing binding", async () => {
  const access = createDatabaseAccess("test", { DATABASE_URL: "postgres://postgres@127.0.0.1:1/handle_test" }, () => {});
  const sql = access.dbFor("worker");
  const dispose = injectDb({ "handle-existing": sql });
  try {
    assert.throws(() => injectDb({ "handle-not-registered": sql, "handle-existing": sql }), /already injected/);
    await assert.rejects(Promise.resolve(dbOf("handle-not-registered")`SELECT 1`), /not injected/);
    assert.throws(() => injectDb({ "": sql }), /Invalid database binding/);
  } finally {
    dispose();
    dispose();
    await access.close();
  }
  await assert.rejects(Promise.resolve(dbOf("handle-existing")`SELECT 1`), /not injected/);
});

test("import-time fragments, builders and JSON work after injection, including inside transactions", async (t) => {
  if (!process.env.DATABASE_URL) return t.skip("needs the isolated verify database");
  const sql = dbOf("handle-fragments");
  const identifier = sql("answer");
  const fields = sql`42::bigint AS ${identifier}`;
  const access = createDatabaseAccess("test", { DATABASE_URL: process.env.DATABASE_URL }, () => {});
  const dispose = injectDb({ "handle-fragments": access.dbFor("worker") });
  try {
    assert.equal((await sql`SELECT ${fields}`)[0].answer, 42);
    assert.equal((await sql.unsafe("SELECT $1::int AS answer", [7]))[0].answer, 7);
    const rows = await sql.begin(async (tx) => {
      await tx`CREATE TEMP TABLE handle_values (answer int, payload jsonb) ON COMMIT DROP`;
      const values = { answer: 9, payload: sql.json({ nested: true }) };
      await tx`INSERT INTO handle_values ${sql(values)}`;
      const selected = await tx`SELECT ${fields}, payload FROM handle_values`;
      assert.deepEqual(selected[0].payload, { nested: true });
      await tx.savepoint(async (nested) => {
        assert.equal((await nested`SELECT ${fields}`)[0].answer, 42);
      });
      return selected;
    });
    assert.equal(rows[0].answer, 42);
    const query = sql`SELECT 1 AS answer`;
    assert.equal(await query, await query, "awaiting one query again reuses the driver's result");
  } finally {
    dispose();
    await access.close();
  }
});

test("a prepared or chained query cannot outlive its injection or switch to another connection", async () => {
  const access = createDatabaseAccess("test", { DATABASE_URL: "postgres://postgres@127.0.0.1:1/handle_test" }, () => {});
  const replacement = createDatabaseAccess("test", { DATABASE_URL: "postgres://postgres@127.0.0.1:1/replacement_test" }, () => {});
  const sql = dbOf("handle-disposed");
  const dispose = injectDb({ "handle-disposed": access.dbFor("worker") });
  const query = sql`SELECT 1`.simple(); // A driver query now exists, but has not executed.
  const transaction = sql.begin;
  dispose();
  await assert.rejects(Promise.resolve(query), /not injected/);
  assert.throws(() => transaction(async () => 1), /not injected/);
  const removeReplacement = injectDb({ "handle-disposed": replacement.dbFor("worker") });
  try {
    await assert.rejects(Promise.resolve(query), /binding changed/);
    assert.throws(() => transaction(async () => 1), /binding changed/);
  } finally {
    removeReplacement();
    await access.close();
    await replacement.close();
  }
});

test("wrapped transactions roll back failed work", async (t) => {
  if (!process.env.DATABASE_URL) return t.skip("needs the isolated verify database");
  const access = createDatabaseAccess("test", { DATABASE_URL: process.env.DATABASE_URL }, () => {});
  const sql = dbOf("handle-rollback");
  const dispose = injectDb({ "handle-rollback": access.dbFor("worker") });
  try {
    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`CREATE TEMP TABLE handle_rolled_back (value int)`;
        await tx`INSERT INTO handle_rolled_back VALUES (1)`;
        throw new Error("rollback fixture");
      }),
      /rollback fixture/,
    );
    assert.equal((await sql`SELECT to_regclass('pg_temp.handle_rolled_back') AS relation`)[0].relation, null);
  } finally {
    dispose();
    await access.close();
  }
});
