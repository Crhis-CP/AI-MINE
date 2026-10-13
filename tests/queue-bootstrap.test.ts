import { createTestDatabase, resourcePrefix } from "./test-resources.ts";
import "./setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { closeDb, dbOf, initializeDb } from "@amp/backend/db";
import { ensureQueue, getBoss, stopBoss } from "@amp/backend/jobs/queue";

const sql = dbOf("queue");
const run = promisify(execFile);
after(closeDb);

test("epoch migration inserts once, preserves an existing value and permits the first read on a read-only connection", async () => {
  const migration = readFileSync(new URL("../database/migrations/0037_selected_ledger_epoch.sql", import.meta.url), "utf8");
  const rollback = new Error("rollback epoch fixture");
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`DELETE FROM settings WHERE key = 'selected_ledger_epoch'`;
      await tx.unsafe(migration);
      const [initial] = await tx`SELECT value, updated_at FROM settings WHERE key = 'selected_ledger_epoch'`;
      assert.match(initial!.value.epoch, /^[A-Za-z0-9_-]{8}$/);
      await tx.unsafe(migration);
      assert.deepEqual((await tx`SELECT value, updated_at FROM settings WHERE key = 'selected_ledger_epoch'`)[0], initial);
      await tx`UPDATE settings SET value = '{"epoch":"existing-epoch"}', updated_at = '2020-01-01T00:00:00+00' WHERE key = 'selected_ledger_epoch'`;
      await tx.unsafe(migration);
      const [kept] = await tx`SELECT value, updated_at FROM settings WHERE key = 'selected_ledger_epoch'`;
      assert.equal(kept!.value.epoch, "existing-epoch");
      assert.equal(kept!.updated_at.toISOString(), "2020-01-01T00:00:00.000Z");
      throw rollback;
    }),
    (error) => error === rollback,
  );
  await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { initializeDb, dbOf, closeDb } from '@amp/backend/db';
    import { ledgerEpoch } from '@amp/backend/publication/v1';
    await initializeDb('test');
    await dbOf('publication')\`SET default_transaction_read_only = on\`;
    assert.ok(await ledgerEpoch());
    await closeDb();
  `,
    ],
    { env: { ...process.env, DATABASE_POOL_MAX: "1" }, timeout: 15_000 },
  );
});

test("the real worker creates every application queue with collection disabled and leaves source jobs unhandled", async () => {
  const database = `${resourcePrefix(`queue_bootstrap_${process.pid}_${Date.now()}`)}_test`;
  const address = new URL(process.env.DATABASE_URL!);
  address.pathname = `/${database}`;
  const env = {
    PATH: process.env.PATH,
    DATABASE_URL: address.toString(),
    COLLECT_ENABLED: "false",
    MODEL_CALLS_ENABLED: "false",
    FEISHU_CONTENT_PUSH_ENABLED: "false",
    INDEXNOW_SUBMIT_ENABLED: "false",
    AMP_CREDENTIALS_DIR: "/nonexistent-test-credentials",
    LOG_LEVEL: "error",
    NODE_ENV: "test",
  };
  await createTestDatabase(sql, database);
  try {
    await run(process.execPath, ["scripts/migrate.ts"], { env, timeout: 30_000 });
    const { stdout } = await run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      import { setTimeout as delay } from 'node:timers/promises';
      await import('./apps/worker/src/main.ts');
      const { getBoss, QUEUES } = await import('@amp/backend/jobs/queue');
      const { SOURCE_QUEUES } = await import('@amp/backend/jobs/sources');
      const boss = await getBoss();
      for (const name of Object.values(QUEUES)) assert.ok(await boss.getQueue(name), name);
      const pending = [];
      for (const name of [QUEUES.fetchSource, SOURCE_QUEUES.news, SOURCE_QUEUES.policy, QUEUES.mpCheck, QUEUES.extractBody]) {
        const id = await boss.send(name, {});
        assert.ok(id);
        pending.push([name, id]);
      }
      await delay(2500);
      for (const [name, id] of pending) assert.equal((await boss.getJobById(name, id)).state, 'created');
      console.log('QUEUE_BOOTSTRAP_PASSED');
      process.kill(process.pid, 'SIGTERM');
    `,
      ],
      { env, timeout: 30_000 },
    );
    assert.ok(stdout.includes("QUEUE_BOOTSTRAP_PASSED"));
  } finally {
    await sql`DROP DATABASE ${sql(database)} WITH (FORCE)`;
  }
});

test("cached and starting queues cannot survive a closed or replaced database root", async () => {
  const address = process.env.DATABASE_URL!;
  const name = `test.root-lifecycle-${process.pid}`;
  try {
    const first = await getBoss();
    await ensureQueue(name);
    await closeDb();
    await assert.rejects(getBoss(), /not initialized or closing/);
    await assert.rejects(ensureQueue(name), /not initialized or closing/);
    await initializeDb("public-api", { DATABASE_URL: address });
    await assert.rejects(getBoss(), /cannot use the job queue/);
    await assert.rejects(ensureQueue(name), /cannot use the job queue/);
    await closeDb();
    await initializeDb("worker", { DATABASE_URL: address });
    await assert.rejects(getBoss(), /different database root/);
    await stopBoss();
    const second = await getBoss();
    assert.notEqual(second, first);
    await second.deleteQueue(name);
    await ensureQueue(name);
    assert.ok(await second.getQueue(name), "stop must also clear the queue existence cache");
    await stopBoss();
    const starting = getBoss();
    const rejected = assert.rejects(starting, /not initialized or closing|changed during startup/);
    await closeDb();
    await rejected;
  } finally {
    await stopBoss();
    await closeDb();
  }
});
