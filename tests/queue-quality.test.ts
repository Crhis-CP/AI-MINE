import { createTestDatabase, resourcePrefix } from "./test-resources.ts";
import assert from "node:assert/strict";
import type { EventEmitter } from "node:events";
import { after, test } from "node:test";
import { createDatabaseAccess } from "@amp/config";
import { closeDb, initializeDb } from "@amp/backend/db";
import { enqueue, ensureQueue, getBoss, stopBoss } from "@amp/backend/jobs/queue";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Queue quality tests require an isolated DATABASE_URL");
const access = createDatabaseAccess("test", { DATABASE_URL: url }, () => {});
const control = access.dbFor("worker");
const expired = /root|initialized|cannot use the job queue|expired/;
const cleanup = async () => {
  await stopBoss();
  await closeDb();
};
after(async () => {
  await cleanup();
  await access.close();
});

test("retained queue, saved methods and database capabilities are revoked with their root", async () => {
  await initializeDb("worker", { DATABASE_URL: url });
  const boss = await getBoss();
  const name = `quality.capabilities-${process.pid}`;
  await boss.createQueue(name);
  const send = boss.send.bind(boss);
  const getDb = boss.getDb;
  const db = getDb();
  const execute = db.executeSql.bind(db);
  const tx = await db.beginTransaction!();
  const txExecute = tx.db.executeSql.bind(tx.db);
  const listener = await db.listen!(
    `quality_${process.pid}`,
    () => {},
    () => {},
  );
  try {
    assert.equal(await boss.start(), boss, "start cannot expose a native receiver");
    let receiver: unknown;
    assert.equal(
      boss.once("stopped", function (this: typeof boss) {
        receiver = this;
      }),
      boss,
    );
    boss.emit("stopped");
    assert.equal(receiver, boss, "event callbacks cannot expose a native receiver");
    const events = boss as unknown as EventEmitter;
    for (const mode of ["on", "once", "prependListener", "prependOnceListener"] as const) {
      for (const raw of [false, true]) {
        let calls = 0;
        const listener = () => {
          calls++;
        };
        events[mode]("listener-fixture", listener);
        assert.equal(events.listeners("listener-fixture")[0], listener);
        assert.equal(events.listenerCount("listener-fixture", listener), 1);
        const visible = (raw ? events.rawListeners("listener-fixture") : events.listeners("listener-fixture"))[0] as () => void;
        if (raw && mode.toLowerCase().includes("once")) assert.equal(Reflect.get(visible, "listener"), listener);
        if (raw) events.removeListener("listener-fixture", visible);
        else events.off("listener-fixture", visible);
        assert.equal(events.listenerCount("listener-fixture"), 0);
        events.emit("listener-fixture");
        assert.equal(calls, 0);
      }
    }
    let onceCalls = 0;
    events.once("once-manual", () => {
      onceCalls++;
    });
    const once = events.rawListeners("once-manual")[0]!;
    once();
    once();
    assert.equal(onceCalls, 1);
    assert.equal(events.listenerCount("once-manual"), 0);
    let received: unknown;
    events.on("db-payload", (payload) => {
      received = payload;
    });
    const payload = { db };
    events.emit("db-payload", payload);
    assert.equal(received, payload, "event data is opaque and retains its guarded db");
    events.emit("db-payload", db);
    assert.equal(received, db, "a direct event payload is not adapted as a work transaction");
    await closeDb();
    await initializeDb("public-api", { DATABASE_URL: url });
    for (const call of [
      () => boss.send(name, {}),
      () => send(name, {}),
      () => execute("SELECT 1"),
      () => txExecute("SELECT 1"),
      () => tx.commit(),
      () => boss.getDb(),
      () => getDb(),
      () => boss.start(),
      () => payload.db.executeSql("SELECT 23"),
    ]) {
      await assert.rejects(async () => call(), expired);
    }
    assert.equal((await control`SELECT count(*)::int AS count FROM pgboss.job WHERE name = ${name}`)[0].count, 0);
    assert.equal(Reflect.get(boss, "__defineGetter__"), undefined);
    assert.equal(Reflect.get(db, "pool"), undefined, "only the public database capability is exposed");
    assert.equal(Reflect.get(db, "config"), undefined);
    assert.equal(Reflect.get(db, "withTransaction"), undefined);
  } finally {
    await listener.close();
    await tx.rollback();
    await cleanup();
  }
});

test("an old ensure completion cannot populate the next instance's queue cache", async () => {
  const database = `${resourcePrefix(`queue_quality_${process.pid}_${Date.now()}`)}_test`;
  const next = new URL(url);
  next.pathname = `/${database}`;
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  await createTestDatabase(control, database);
  try {
    await initializeDb("worker", { DATABASE_URL: url });
    const old = await getBoss();
    const name = `quality.ensure-${process.pid}`;
    await old.createQueue(name);
    const get = old.getQueue.bind(old);
    old.getQueue = async (queue) => {
      const result = await get(queue);
      if (queue === name) {
        entered.resolve();
        await resume.promise;
      }
      return result;
    };
    const pending = ensureQueue(name);
    const rejected = assert.rejects(pending, expired);
    await entered.promise;
    await cleanup();
    await initializeDb("worker", { DATABASE_URL: next.toString() });
    const current = await getBoss();
    resume.resolve();
    await rejected;
    await ensureQueue(name);
    assert.ok(await current.getQueue(name));
    assert.ok(await current.send(name, {}));
  } finally {
    resume.resolve();
    await cleanup();
    await control`DROP DATABASE ${control(database)} WITH (FORCE)`;
  }
});

test("same-root graceful drain lets a handler settle and enqueue its follow-up", async () => {
  await initializeDb("worker", { DATABASE_URL: url });
  const boss = await getBoss();
  const name = `quality.drain-${process.pid}`;
  const follow = `${name}-follow`;
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  await ensureQueue(name);
  await ensureQueue(follow);
  let followed = false;
  await boss.work(name, { pollingIntervalSeconds: 0.5, transactional: true }, async (jobs, tx) => {
    entered.resolve();
    await resume.promise;
    assert.equal(await getBoss(), boss);
    assert.equal((await boss.getDb().executeSql("SELECT 1 AS ok")).rows[0].ok, 1);
    assert.equal((await tx.executeSql("SELECT 1 AS ok")).rows[0].ok, 1);
    await boss.complete(
      name,
      jobs.map((job) => job.id),
      { fixture: true },
      { db: tx },
    );
    followed = !!(await enqueue(follow, { fixture: true }));
  });
  try {
    const id = await boss.send(name, {});
    await entered.promise;
    const draining = stopBoss();
    assert.equal(await getBoss(), boss);
    resume.resolve();
    await draining;
    assert.equal(followed, true);
    assert.equal((await control`SELECT state FROM pgboss.job WHERE id = ${id}`)[0].state, "completed");
    assert.equal((await control`SELECT count(*)::int AS count FROM pgboss.job WHERE name = ${follow}`)[0].count, 1);
    await assert.rejects(async () => boss.send(follow, {}));
  } finally {
    resume.resolve();
    await cleanup();
  }
});
