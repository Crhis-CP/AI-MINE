import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { Db, Sql } from "@amp/backend/db";

import { createTestDatabase, resourcePrefix } from "./test-resources.ts";

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
  const database = `${resourcePrefix(`private_producer_${process.pid}_${++serial}`)}_test`;
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
  await createTestDatabase(control, database);
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
  app = await buildApp("private-api");
  let lastError: unknown;
  app.post(
    "/api/admin/private-producer-fixture",
    adminHandler(async (req) => {
      try {
        const { key, transaction, name = queue } = req.body as { key?: string; transaction?: boolean | "options.db"; name?: string };
        const send = (tx?: Db) => {
          const db =
            transaction === "options.db" && tx
              ? { executeSql: async (text: string, values?: unknown[]) => ({ rows: await tx.unsafe(text, (values ?? []) as never[]) }) }
              : undefined;
          return enqueue(name, { fixture: true }, { ...(key ? { singletonKey: key } : {}), ...(db ? { db } : {}) }, db ? undefined : tx);
        };
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
    request: (key?: string, transaction: boolean | "options.db" = false, name = queue) =>
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

/** Pause one real metadata read at its return boundary; the caller controls when it can finish. */
export function pauseQueueRead(producer: Awaited<ReturnType<typeof import("@amp/backend/jobs/queue").getBoss>>, name: string) {
  const read = producer.getQueue.bind(producer);
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  producer.getQueue = async (queue) => {
    const row = await read(queue);
    if (queue === name) {
      entered.resolve();
      await proceed.promise;
    }
    return row;
  };
  return {
    entered: entered.promise,
    release: () => proceed.resolve(),
    restore: () => {
      producer.getQueue = read;
    },
  };
}

/** Invoke the original HTTP handler inside a caller transaction that blocks one producer connection. */
export async function prepareLockedTransaction(f: Awaited<ReturnType<typeof privateProducerFixture>>, run: (tx: Db) => Promise<unknown>) {
  const { dbOf } = await import("@amp/backend/db");
  const { getBoss } = await import("@amp/backend/jobs/queue");
  const { adminHandler } = await import("../apps/api/src/routes/admin-auth.ts");
  const producer = await getBoss();
  const key = process.pid + 1;
  let blocked: Promise<unknown> | undefined;
  f.app.post(
    "/api/admin/locked-transaction-fixture",
    adminHandler(async () =>
      dbOf("queue").begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${key})`;
        blocked = producer
          .getDb()
          .executeSql("SELECT pg_advisory_xact_lock($1)", [key])
          .catch((error) => {
            if (error.code !== "57014") throw error;
          });
        await until(
          async () =>
            (
              await f.db`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=${f.database} AND application_name='amp-jobs' AND wait_event='advisory'`
            )[0].n > 0,
        );
        return run(tx);
      }),
    ),
  );
  return async () => {
    const pending = f.app.inject({ method: "POST", url: "/api/admin/locked-transaction-fixture", headers: { "x-csrf-token": "dev" }, payload: {} });
    const response = await Promise.race([pending, delay(1000).then(() => null)]);
    if (!response)
      await f.db`SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE datname=${f.database} AND application_name='amp-jobs' AND wait_event='advisory'`;
    const final = response ?? (await pending);
    await blocked;
    return { selfWait: response === null, response: final };
  };
}

/** Force one unrelated SQL failure through the original handler and count actual execution attempts. */
export async function installSqlFailure(f: Awaited<ReturnType<typeof privateProducerFixture>>) {
  const { enqueue } = await import("@amp/backend/jobs/queue");
  const { adminHandler } = await import("../apps/api/src/routes/admin-auth.ts");
  let attempts = 0;
  f.app.post(
    "/api/admin/unrelated-sql-fixture",
    adminHandler(async () =>
      f.db.begin(async (tx) => {
        const broken = new Proxy(tx, {
          get(target, key) {
            if (key === "unsafe")
              return () => {
                attempts++;
                return target.unsafe("SELECT * FROM unrelated_missing_fixture");
              };
            return Reflect.get(target, key, target);
          },
        });
        return enqueue(f.queue, {}, {}, broken);
      }),
    ),
  );
  return {
    attempts: () => attempts,
    request: () => f.app.inject({ method: "POST", url: "/api/admin/unrelated-sql-fixture", headers: { "x-csrf-token": "dev" }, payload: {} }),
  };
}

export function queueExpired(producer: Awaited<ReturnType<typeof import("@amp/backend/jobs/queue").getBoss>>) {
  try {
    producer.getDb();
    return false;
  } catch (error) {
    assert.match((error as Error).message, /instance expired/);
    return true;
  }
}

/** Shared HTTP contract assertion; no dependency on a not-yet-merged queue exception type. */
export function assertUnavailable(
  response: { statusCode: number; headers: Record<string, unknown>; body: string; json(): { code: string; retryAfter: number; detail: string } },
  detail: string,
) {
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(response.headers["retry-after"], "30");
  assert.equal(response.json().code, "temporarily_unavailable");
  assert.equal(response.json().retryAfter, 30);
  assert.equal(response.json().detail, detail);
  assert.doesNotMatch(response.body, /pgboss|42P01|23514/);
}
