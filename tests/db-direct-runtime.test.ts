import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, initializeDb, closeDb } from "@amp/backend/db";

after(closeDb);

test("direct transactions roll back and reinitialization never reroutes an old pending query", async () => {
  await closeDb();
  await initializeDb("test", { ...process.env, DATABASE_POOL_MAX: "1" });
  await sql`CREATE TEMP TABLE direct_connection_fixture(value integer)`;
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`INSERT INTO direct_connection_fixture VALUES(7)`;
      throw new Error("rollback fixture");
    }),
    /rollback fixture/,
  );
  assert.equal((await sql`SELECT count(*)::int AS n FROM direct_connection_fixture`)[0]!.n, 0);
  const old = sql;
  const pending = sql`SELECT 7::int AS answer`;
  await closeDb();
  await initializeDb("test");
  assert.notEqual(sql, old);
  await assert.rejects(async () => pending, /CONNECTION_ENDED/);
  assert.equal((await sql`SELECT 42::int AS answer`)[0]!.answer, 42);
});
