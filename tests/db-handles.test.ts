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
  const plain = sql`SELECT 1`;
  const unsafe = sql.unsafe;
  const transaction = sql.begin;
  dispose();
  await assert.rejects(Promise.resolve(query), /not injected/);
  await assert.rejects(Promise.resolve(plain), /not injected/);
  await assert.rejects(Promise.resolve(unsafe("SELECT 1")), /not injected/);
  assert.throws(() => transaction(async () => 1), /not injected/);
  const removeReplacement = injectDb({ "handle-disposed": replacement.dbFor("worker") });
  try {
    await assert.rejects(Promise.resolve(query), /binding changed/);
    await assert.rejects(Promise.resolve(plain), /binding changed/);
    await assert.rejects(Promise.resolve(unsafe("SELECT 1")), /binding changed/);
    assert.throws(() => transaction(async () => 1), /binding changed/);
  } finally {
    removeReplacement();
    await access.close();
    await replacement.close();
  }
});

test("a transaction or savepoint waiting at a gate rolls back when its root registration expires", async (t) => {
  if (!process.env.DATABASE_URL) return t.skip("needs the isolated verify database");
  for (const nested of [false, true]) {
    for (const rebind of [false, true]) {
      const access = createDatabaseAccess("test", { DATABASE_URL: process.env.DATABASE_URL, DATABASE_POOL_MAX: "1" }, () => {});
      const raw = access.dbFor("worker");
      const module = `handle-gate-${nested}-${rebind}`;
      const sql = dbOf(module);
      const dispose = injectDb({ [module]: raw });
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      let removeReplacement = () => {};
      try {
        const pending = sql.begin(async (tx) => {
          await tx`CREATE TEMP TABLE handle_gate (value int)`;
          const work = async (connection: typeof tx) => {
            const held = connection`INSERT INTO handle_gate VALUES (1)`;
            entered.resolve();
            await resume.promise;
            await held;
          };
          if (nested) await tx.savepoint(work);
          else await work(tx);
        });
        await Promise.race([entered.promise, pending.then(() => assert.fail("transaction finished before its gate"))]);
        dispose();
        // Same connection object, new registration: pointer equality alone must not keep the lease valid.
        if (rebind) removeReplacement = injectDb({ [module]: raw });
        resume.resolve();
        await assert.rejects(pending, /not injected|binding changed/);
        assert.equal((await raw`SELECT to_regclass('pg_temp.handle_gate') AS relation`)[0].relation, null);
      } finally {
        resume.resolve();
        dispose();
        removeReplacement();
        await access.close();
      }
    }
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
