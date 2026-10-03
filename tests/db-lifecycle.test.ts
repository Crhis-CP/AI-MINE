import "./setup.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test, type TestContext } from "node:test";
import { createDatabaseAccess } from "@amp/config";
import { closeDb, dbOf, initializeDb, injectDb } from "@amp/backend/db";
import { v1Items } from "@amp/backend/publication/v1";

after(closeDb);
const environment = () => ({ DATABASE_URL: process.env.DATABASE_URL, DATABASE_POOL_MAX: "1" });
function fixture(t: TestContext, name: string) {
  const access = createDatabaseAccess("test", environment(), () => {});
  const raw = access.dbFor("worker");
  const sql = dbOf(name);
  const dispose = injectDb({ [name]: raw });
  t.after(async () => {
    dispose();
    await access.close();
  });
  return { raw, sql, dispose };
}

test("pure SQL fragments and builders compose in new roots while old pending queries stay revoked", async () => {
  const sql = dbOf("reusable-fragments");
  const field = sql("answer");
  const json = sql.json({ nested: true });
  const fields = sql`42::int AS ${field}, ${json}::jsonb AS payload`;
  const unsafe = sql.unsafe("42::int");
  let previous: PromiseLike<unknown> | undefined;
  for (let generation = 0; generation < 2; generation++) {
    const access = createDatabaseAccess("test", environment(), () => {});
    const dispose = injectDb({ "reusable-fragments": access.dbFor("worker") });
    try {
      if (previous) await assert.rejects(async () => previous, /binding changed/);
      assert.deepEqual((await sql`SELECT ${fields}`)[0], { answer: 42, payload: { nested: true } });
      assert.equal((await sql`SELECT ${unsafe} AS answer`)[0].answer, 42);
      previous = sql`SELECT 7 AS answer`;
    } finally {
      dispose();
      await access.close();
    }
  }
});

test("the real publication query survives close and reinitialize without reimporting its SQL constants", async () => {
  await closeDb();
  const counts: number[] = [];
  for (let generation = 0; generation < 2; generation++) {
    await initializeDb("test", environment());
    try {
      const result = await v1Items({ mode: "all", window: "24h", by: "timeline", category: null, q: null, limit: 10, cursor: null });
      counts.push(result.page.count);
    } finally {
      await closeDb();
    }
  }
  assert.equal(counts[0], counts[1]);
});

test("file queries and saved file factories are revoked; an existing query can still be cancelled", async (t) => {
  const { sql, dispose } = fixture(t, "file-lifecycle");
  const directory = mkdtempSync(path.join(tmpdir(), "amp-file-query-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "query.sql");
  writeFileSync(filename, "SELECT 7::int AS answer");
  assert.equal((await sql.file(filename))[0].answer, 7);
  const query = sql.file(filename).simple();
  const savedCancel = sql.file(filename).cancel;
  const file = sql.file;
  dispose();
  await assert.rejects(async () => query, /not injected/);
  await assert.rejects(async () => file(filename), /not injected/);
  query.cancel();
  savedCancel();
});

test("reserved connections and saved methods are revoked while release remains safe and idempotent", async (t) => {
  const { raw, sql, dispose } = fixture(t, "reserve-lifecycle");
  const reserved = await sql.reserve();
  t.after(() => reserved.release());
  assert.equal((await reserved`SELECT 7::int AS answer`)[0].answer, 7);
  const query = reserved`SELECT 8::int AS answer`;
  const unsafe = reserved.unsafe;
  const release = reserved.release;
  dispose();
  await assert.rejects(async () => reserved`SELECT 9`, /not injected/);
  await assert.rejects(async () => query, /not injected/);
  await assert.rejects(async () => unsafe("SELECT 10"), /not injected/);
  release();
  release();
  assert.equal((await raw`SELECT 11::int AS answer`)[0].answer, 11, "cleanup returned the only pool connection");
});

test("release also revokes a reserved handle while the module remains live", async (t) => {
  const { sql } = fixture(t, "released-handle");
  const reserved = await sql.reserve();
  const pending = reserved`SELECT 1`;
  reserved.release();
  await assert.rejects(async () => pending, /connection released/);
  await assert.rejects(async () => reserved`SELECT 1`, /connection released/);
  assert.equal((await sql`SELECT 2::int AS answer`)[0].answer, 2);
});

test("a reservation finishing after disposal releases its connection instead of leaking a capability", async (t) => {
  const { raw, sql, dispose } = fixture(t, "late-reservation");
  const occupied = await raw.reserve();
  const pending = sql.reserve();
  dispose();
  occupied.release();
  await assert.rejects(pending, /not injected/);
  assert.equal((await raw`SELECT 3::int AS answer`)[0].answer, 3);
});

test("cursor iterators and saved next methods cannot start or continue after disposal; return cleans up", async (t) => {
  for (const started of [false, true]) {
    const { raw, sql, dispose } = fixture(t, `cursor-lifecycle-${started}`);
    const iterable = sql`SELECT generate_series(1, 2) AS answer`.cursor(1);
    const iterator = iterable[Symbol.asyncIterator]();
    const next = iterator.next;
    const finish = iterator.return!;
    t.after(() => {
      finish();
    });
    if (started) assert.equal((await next()).value[0].answer, 1);
    dispose();
    assert.throws(() => iterable[Symbol.asyncIterator](), /not injected/);
    await assert.rejects(async () => next(), /not injected/);
    await finish();
    assert.equal((await raw`SELECT 4::int AS answer`)[0].answer, 4);
  }
});
