import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { Db, Sql } from "@amp/backend/db";

let serial = 0;
/** No imports of backend configuration, environment changes, connections or child processes until called. */
export async function privateProducerFixture(t: TestContext) {
  const url = new URL(process.env.DATABASE_URL ?? "postgres://unset/unset");
  assert.match(url.pathname, /_(test|ci)$/, "Private producer tests require an isolated DATABASE_URL");
  process.env.AMP_CREDENTIALS_DIR = "/nonexistent-test-credentials";
  process.env.SESSION_SECRET = "test-session-secret-0123456789";
  const { createDatabaseAccess } = await import("@amp/config");
  const { config } = await import("@amp/backend/config");
  const { closeDb, dbOf, initializeDb } = await import("@amp/backend/db");
  const { enqueue, stopBoss } = await import("@amp/backend/jobs/queue");
  const { buildApp } = await import("../apps/api/src/app.ts");
  const { adminHandler } = await import("../apps/api/src/routes/admin-auth.ts");
  assert.equal(config.credentialsDir, "/nonexistent-test-credentials");
  const password = "test-private-password-012345";
  config.adminPassword = password;
  config.devAdmin = { displayName: "Private producer fixture" };
  const access = createDatabaseAccess("test", { DATABASE_URL: url.toString() }, () => {});
  const control = access.dbFor("worker");
  const database = `private_producer_${process.pid}_${++serial}_test`;
  const queue = `fixture.private-${serial}`;
  let created = false;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let dbAccess: ReturnType<typeof createDatabaseAccess> | undefined;
  t.after(async () => {
    const errors: unknown[] = [];
    for (const cleanup of [
      () => app?.close(),
      stopBoss,
      closeDb,
      () => dbAccess?.close(),
      () => created && control`DROP DATABASE ${control(database)} WITH (FORCE)`,
      () => access.close(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Private producer fixture cleanup failed");
  });
  await control`CREATE DATABASE ${control(database)}`;
  created = true;
  url.pathname = `/${database}`;
  const env = {
    PATH: process.env.PATH,
    DATABASE_URL: url.toString(),
    NODE_ENV: "test",
    MODEL_CALLS_ENABLED: "false",
    COLLECT_ENABLED: "false",
    FEISHU_CONTENT_PUSH_ENABLED: "false",
    INDEXNOW_SUBMIT_ENABLED: "false",
    AMP_CREDENTIALS_DIR: "/nonexistent-test-credentials",
  };
  const run = promisify(execFile);
  dbAccess = createDatabaseAccess("test", { DATABASE_URL: url.toString() }, () => {});
  const db = dbAccess.dbFor("worker");
  await run(process.execPath, ["scripts/migrate.ts"], { env, timeout: 30_000 });
  await stopBoss();
  await closeDb();
  await initializeDb("private-api", { DATABASE_URL: url.toString(), DATABASE_POOL_MAX: "1" });
  app = await buildApp();
  let lastError: unknown;
  app.post(
    "/api/admin/private-producer-fixture",
    adminHandler(async (req) => {
      try {
        const { key, transaction, name = queue } = req.body as { key?: string; transaction?: boolean; name?: string };
        const send = (tx?: Db) => enqueue(name, { fixture: true }, key ? { singletonKey: key } : {}, tx);
        return { id: transaction ? await dbOf("queue").begin(send) : await send() };
      } catch (error) {
        lastError = error;
        throw error;
      }
    }),
  );
  const install = (withQueue: boolean | "delete" = true, partition = false, name = queue) =>
    run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { initializeDb, closeDb } from '@amp/backend/db';
    import { getBoss, stopBoss } from '@amp/backend/jobs/queue';
    await initializeDb('worker');
    try {
      const boss = await getBoss();
      if (process.env.FIXTURE_REMOVE) await boss.deleteQueue(process.env.FIXTURE_QUEUE);
      else if (process.env.FIXTURE_QUEUE) await boss.createQueue(process.env.FIXTURE_QUEUE, { policy: "short", partition: process.env.FIXTURE_PARTITION === "true" });
    } finally { await stopBoss(); await closeDb(); }
  `,
      ],
      {
        env: {
          ...env,
          ...(withQueue ? { FIXTURE_QUEUE: name } : {}),
          ...(withQueue === "delete" ? { FIXTURE_REMOVE: "true" } : {}),
          FIXTURE_PARTITION: String(partition),
        },
        timeout: 30_000,
      },
    );
  return {
    app,
    db,
    database,
    queue,
    install,
    password,
    error: () => lastError,
    request: (key?: string, transaction = false, name = queue) =>
      app!.inject({ method: "POST", url: "/api/admin/private-producer-fixture", headers: { "x-csrf-token": "dev" }, payload: { key, transaction, name } }),
  };
}

export async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 120; i++) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail("fixture did not reach the expected state");
}

/** Hold one real producer connection so tests can observe a cleanup barrier before releasing it. */
export async function holdProducerConnection(db: Sql, database: string, producer: Awaited<ReturnType<typeof import("@amp/backend/jobs/queue").getBoss>>) {
  const lock = await db.reserve();
  const key = process.pid;
  let blocked: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  const release = () =>
    (closing ??= (async () => {
      try {
        await lock`SELECT pg_advisory_unlock(${key})`;
        await blocked;
      } finally {
        lock.release();
      }
    })());
  try {
    await lock`SELECT pg_advisory_lock(${key})`;
    blocked = producer.getDb().executeSql("SELECT pg_advisory_xact_lock($1)", [key]);
    await until(
      async () =>
        (await db`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=${database} AND application_name='amp-jobs' AND wait_event='advisory'`)[0].n >
        0,
    );
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}
