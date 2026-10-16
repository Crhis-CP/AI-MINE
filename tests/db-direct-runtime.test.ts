import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, initializeDb, closeDb } from "@amp/backend/db";

import { v1Items } from "@amp/backend/publication/v1";

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

test("the real publication query survives close and reinitialize without reimporting modules", async () => {
  await closeDb();
  const counts: number[] = [];
  for (let generation = 0; generation < 2; generation++) {
    await initializeDb("test", { DATABASE_URL: process.env.DATABASE_URL, DATABASE_POOL_MAX: "1" });
    try {
      const result = await v1Items({ mode: "all", window: "24h", by: "timeline", category: null, q: null, limit: 10, cursor: null });
      counts.push(result.page.count);
    } finally {
      await closeDb();
    }
  }
  assert.equal(counts[0], counts[1]);
});
