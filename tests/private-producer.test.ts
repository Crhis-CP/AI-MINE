import "./setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { createDatabaseAccess } from "@amp/config";
import { config } from "@amp/backend/config";
import { closeDb, initializeDb } from "@amp/backend/db";
import { enqueue, getBoss, QueueUnavailableError, stopBoss } from "@amp/backend/jobs/queue";
import { queueConnection } from "../packages/backend/src/db-bootstrap.ts";
import { buildApp } from "../apps/api/src/app.ts";
import { adminHandler } from "../apps/api/src/routes/admin-auth.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Private producer tests require an isolated DATABASE_URL");
const access = createDatabaseAccess("test", { DATABASE_URL: url }, () => {});
const control = access.dbFor("worker");
const run = promisify(execFile);
process.env.SESSION_SECRET = "test-session-secret-0123456789";
config.adminPassword = "test-private-password-012345";
config.devAdmin = { displayName: "Private producer fixture" };
after(async () => {
  await stopBoss();
  await closeDb();
  await access.close();
});
let serial = 0;
async function fixture(t: TestContext) {
  const database = `private_producer_${process.pid}_${++serial}_test`;
  const address = new URL(url!);
  address.pathname = `/${database}`;
  const env = {
    PATH: process.env.PATH,
    DATABASE_URL: address.toString(),
    NODE_ENV: "test",
    MODEL_CALLS_ENABLED: "false",
    COLLECT_ENABLED: "false",
    AMP_CREDENTIALS_DIR: "/nonexistent-test-credentials",
  };
  await control`CREATE DATABASE ${control(database)}`;
  const dbAccess = createDatabaseAccess("test", { DATABASE_URL: address.toString() }, () => {});
  const db = dbAccess.dbFor("worker");
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  t.after(async () => {
    await app?.close();
    await stopBoss();
    await closeDb();
    await dbAccess.close();
    await control`DROP DATABASE ${control(database)} WITH (FORCE)`;
  });
  await run(process.execPath, ["scripts/migrate.ts"], { env, timeout: 30_000 });
  assert.equal(config.credentialsDir, "/nonexistent-test-credentials");
  await closeDb();
  await initializeDb("private-api", { DATABASE_URL: address.toString() });
  app = await buildApp();
  const queue = `fixture.private-${serial}`;
  let lastError: unknown;
  app.post(
    "/api/admin/private-producer-fixture",
    adminHandler(async () => {
      try {
        return { id: await enqueue(queue, { fixture: true }) };
      } catch (error) {
        lastError = error;
        throw error;
      }
    }),
  );
  const install = (withQueue: boolean | "delete" = true) =>
    run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { initializeDb, closeDb } from '@amp/backend/db';
    import { getBoss, stopBoss } from '@amp/backend/jobs/queue';
    await initializeDb('worker');
    try { const boss = await getBoss(); if (process.env.FIXTURE_REMOVE) await boss.deleteQueue(process.env.FIXTURE_QUEUE); else if (process.env.FIXTURE_QUEUE) await boss.createQueue(process.env.FIXTURE_QUEUE); }
    finally { await stopBoss(); await closeDb(); }
  `,
      ],
      { env: { ...env, ...(withQueue ? { FIXTURE_QUEUE: queue } : {}), ...(withQueue === "delete" ? { FIXTURE_REMOVE: "true" } : {}) }, timeout: 30_000 },
    );
  return {
    app,
    db,
    database,
    queue,
    install,
    error: () => lastError,
    request: () => app!.inject({ method: "POST", url: "/api/admin/private-producer-fixture", headers: { "x-csrf-token": "dev" }, payload: {} }),
  };
}

for (const reason of ["not_installed", "schema_mismatch", "queue_missing"] as const)
  test(`private producer reports ${reason} as 503 and recovers in the same process`, async (t) => {
    const f = await fixture(t);
    const connection = queueConnection();
    if (reason !== "not_installed") await f.install(reason !== "queue_missing");
    const [version] = reason === "schema_mismatch" ? await f.db`SELECT version FROM pgboss.version` : [];
    if (version) await f.db`UPDATE pgboss.version SET version = version - 1`;
    assert.equal((await f.app.inject({ url: "/api/health" })).statusCode, 200);
    assert.equal((await f.app.inject({ url: "/api/auth/options" })).statusCode, 200);
    const login = await f.app.inject({ method: "POST", url: "/api/auth/password", payload: { password: config.adminPassword, return: "/admin" } });
    assert.equal(login.statusCode, 303);
    assert.ok(login.headers["set-cookie"]);
    if (reason === "not_installed") assert.equal((await f.db`SELECT to_regnamespace('pgboss') AS schema`)[0].schema, null);
    const responses = await Promise.all([f.request(), f.request()]);
    for (const response of responses) {
      assert.equal(response.statusCode, 503, response.body);
      assert.equal(response.headers["retry-after"], "30");
      assert.equal(response.json().code, "temporarily_unavailable");
      assert.equal(response.json().retryAfter, 30);
      assert.equal(response.json().detail, new QueueUnavailableError(reason).message);
    }
    const error = f.error();
    assert.ok(error instanceof QueueUnavailableError);
    assert.equal(error.reason, reason);
    assert.equal(error.cause, undefined);
    if (reason === "not_installed") assert.equal((await f.db`SELECT to_regnamespace('pgboss') AS schema`)[0].schema, null);
    if (version) assert.equal((await f.db`SELECT version FROM pgboss.version`)[0].version, version.version - 1);
    if (reason === "queue_missing") assert.equal((await f.db`SELECT count(*)::int AS count FROM pgboss.queue WHERE name = ${f.queue}`)[0].count, 0);
    else {
      let clients = 1;
      for (let i = 0; i < 20 && clients; i++) {
        clients = (await control`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = ${f.database} AND application_name = 'amp-jobs'`)[0].count;
        if (clients) await delay(25);
      }
      assert.equal(clients, 0, "failed startup must close its pool before a retry");
    }
    if (version) await f.db`UPDATE pgboss.version SET version = ${version.version}`;
    else await f.install();
    if (reason === "queue_missing") {
      const producer = await getBoss();
      const get = producer.getQueue.bind(producer);
      producer.getQueue = async (name) => {
        const row = await get(name);
        await f.install("delete");
        return row;
      };
      try {
        const raced = await f.request();
        assert.equal(raced.statusCode, 503, raced.body);
        assert.equal(raced.json().detail, new QueueUnavailableError("queue_missing").message);
      } finally {
        producer.getQueue = get;
      }
      await f.install();
    }
    const response = await f.request();
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(response.json().id);
    assert.equal(queueConnection(), connection, "recovery does not replace the private root");
    const producer = await getBoss();
    assert.deepEqual(producer.getWipData({ includeInternal: true }), []);
    assert.equal(producer.isMaintaining(), false);
    assert.equal(producer.isBamWorking(), false);
    assert.equal(producer.isCheckingSkew(), false);
    assert.equal((await f.db`SELECT state FROM pgboss.job WHERE id = ${response.json().id}`)[0].state, "created");
  });
