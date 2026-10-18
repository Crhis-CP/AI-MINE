import { createTestDatabase, resourcePrefix } from "./test-resources.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createDatabaseAccess } from "@amp/backend/db";
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

test("native queue connections stop before the process database closes", async () => {
  await initializeDb("worker", { DATABASE_URL: url });
  const boss = await getBoss();
  const name = `quality.native-${process.pid}`;
  await boss.createQueue(name);
  const db = boss.getDb();
  const tx = await db.beginTransaction!();
  await tx.db.executeSql("SELECT 1");
  await tx.rollback();
  await stopBoss();
  await closeDb();
  await assert.rejects(() => db.executeSql("SELECT 1"));
  await assert.rejects(() => boss.send(name, {}));
  assert.equal((await control`SELECT count(*)::int AS count FROM pgboss.job WHERE name = ${name}`)[0].count, 0);
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
