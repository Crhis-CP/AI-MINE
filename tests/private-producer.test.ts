import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { enqueue, getBoss, QueueUnavailableError } from "@amp/backend/jobs/queue";
import { queueConnection } from "../packages/backend/src/db-bootstrap.ts";
import {
  privateProducerFixture as fixture,
  assertUnavailable,
  queueExpired,
  holdProducerConnection,
  installSqlFailure,
  pauseQueueRead,
  prepareLockedTransaction,
  until,
} from "./private-producer-fixture.ts";

for (const reason of ["not_installed", "schema_mismatch", "queue_missing"] as const)
  test(`private producer reports ${reason} as 503 and recovers in the same process`, async (t) => {
    const f = await fixture(t);
    const connection = queueConnection();
    if (reason !== "not_installed") await f.install(reason !== "queue_missing");
    const [version] = reason === "schema_mismatch" ? await f.db`SELECT version FROM pgboss.version` : [];
    if (version) await f.db`UPDATE pgboss.version SET version = version - 1`;
    assert.equal((await f.app.inject({ url: "/api/health" })).statusCode, 200);
    assert.equal((await f.app.inject({ url: "/api/auth/options" })).statusCode, 200);
    const nonce = await f.app.inject({ url: "/api/auth/password-nonce" });
    const login = await f.app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: { cookie: String(nonce.headers["set-cookie"]).split(";")[0]! },
      payload: { login_name: "admin@local", login_nonce: nonce.json().token, password: f.password, return: "/admin" },
    });
    assert.equal(login.statusCode, 303);
    assert.ok(login.headers["set-cookie"]);
    if (reason === "not_installed") assert.equal((await f.db`SELECT to_regnamespace('pgboss') AS schema`)[0].schema, null);
    const responses = await Promise.all([f.request(), f.request()]);
    for (const response of responses) assertUnavailable(response, new QueueUnavailableError(reason).message);
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
        clients = (await f.db`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = ${f.database} AND application_name = 'amp-jobs'`)[0].count;
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
        assertUnavailable(raced, new QueueUnavailableError("queue_missing").message);
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

for (const partition of [false, true])
  test(`warm ${partition ? "partition" : "shared"} deletion is 503 and a different rebuilt shape recovers`, async (t) => {
    const f = await fixture(t);
    await f.install(true, partition);
    assert.ok((await f.request("warm")).json().id);
    const producer = await getBoss();
    const get = producer.getQueue.bind(producer);
    producer.getQueue = async (name) => {
      const row = await get(name);
      await f.install("delete");
      return row;
    };
    const release = await holdProducerConnection(f.db, f.database, producer);
    try {
      const pending = f.request("new-job", partition);
      await until(() => queueExpired(producer));
      let ready = false;
      const next = Promise.all([getBoss(), getBoss()]).then((clients) => {
        ready = true;
        return clients;
      });
      await delay(25);
      assert.equal(ready, false, "new clients wait for the old pool to finish cleanup");
      if (partition) {
        const timeout = delay(2000).then(() => assert.fail("transaction waited for producer cleanup instead of rolling back"));
        assert.equal((await Promise.race([pending, timeout])).statusCode, 503);
        assert.equal((await Promise.race([f.request("new-job", true), timeout])).statusCode, 503);
      }
      await release();
      const response = await pending;
      assertUnavailable(response, new QueueUnavailableError("queue_missing").message);
      const [a, b] = await next;
      assert.equal(a, b);
      assert.notEqual(a, producer);
      await assert.rejects(async () => producer.send(f.queue, {}), /expired/);
    } finally {
      producer.getQueue = get;
      await release();
    }
    await f.install(true, !partition);
    assert.equal((await f.db`SELECT count(*)::int AS n FROM pgboss.job WHERE name=${f.queue}`)[0].n, 0, "failed jobs are never automatically resent");
    assert.ok((await f.request("new-job")).json().id);
    const duplicate = await f.request("new-job");
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.json().id, null);
    const rebuilt = await getBoss();
    const read = rebuilt.getQueue.bind(rebuilt);
    rebuilt.getQueue = async (name) => {
      const row = await read(name);
      await f.install("delete");
      await f.install(true, partition);
      return row;
    };
    try {
      const changed = await f.request("during-rebuild");
      assertUnavailable(changed, new QueueUnavailableError("queue_missing").message);
    } finally {
      rebuilt.getQueue = read;
    }
    assert.ok((await f.request("during-rebuild")).json().id);
    await f.install("delete");
    await f.install(true, !partition);
    assert.equal((await f.request("between-requests")).statusCode, 503);
    assert.ok((await f.request("between-requests")).json().id);
  });

test("stable singleton dedupe stays 200/null and unrelated SQL errors are not reclassified or retried", async (t) => {
  const f = await fixture(t);
  await f.install();
  const failure = await installSqlFailure(f);
  assert.ok((await f.request("duplicate")).json().id);
  const producer = await getBoss();
  const duplicate = await f.request("duplicate");
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.json().id, null);
  const inTransaction = await f.request("duplicate", true);
  assert.equal(inTransaction.statusCode, 200);
  assert.equal(inTransaction.json().id, null);
  const viaOptions = await f.request("duplicate", "options.db");
  assert.equal(viaOptions.statusCode, 200);
  assert.equal(viaOptions.json().id, null);
  const response = await failure.request();
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().code, "internal_error");
  assert.equal(response.json().detail, "服务暂时无法完成此操作，请稍后重试。");
  assert.equal(failure.attempts(), 1);
  assert.equal(await getBoss(), producer);
});

for (const partition of [false, true])
  test(`first send to a preloaded ${partition ? "partition" : "shared"} queue recovers after another worker replaces it`, async (t) => {
    const f = await fixture(t);
    const untouched = `${f.queue}-untouched`;
    await f.install();
    await f.install(true, partition, untouched);
    assert.ok((await f.request("queue-a")).json().id);
    await f.install("delete", false, untouched);
    await f.install(true, !partition, untouched);
    const failed = await f.request("queue-b", false, untouched);
    assertUnavailable(failed, new QueueUnavailableError("queue_missing").message);
    assert.equal((await f.db`SELECT count(*)::int AS n FROM pgboss.job WHERE name=${untouched}`)[0].n, 0);
    assert.ok((await f.request("queue-b", false, untouched)).json().id);
    const duplicate = await f.request("queue-b", false, untouched);
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.json().id, null);
  });

for (const mode of ["tx", "options.db"] as const)
  test(`${mode} never waits for producer cleanup while holding its transaction lock`, async (t) => {
    const f = await fixture(t);
    const missing = `${f.queue}-deleted`;
    await f.install();
    await f.install(true, false, missing);
    const producer = await getBoss();
    await f.install("delete", false, missing);
    const gate = pauseQueueRead(producer, missing);
    const request = await prepareLockedTransaction(f, async (tx) => {
      gate.release();
      // Three promise handoffs place retirement between initial getBoss and ensureQueue.
      if (mode === "tx") for (let step = 0; step < 3; step++) await Promise.resolve();
      else await until(() => queueExpired(producer));
      const options =
        mode === "options.db"
          ? { db: { executeSql: async (text: string, values?: unknown[]) => ({ rows: await tx.unsafe(text, (values ?? []) as never[]) }) } }
          : {};
      return { id: await enqueue(f.queue, {}, options, mode === "tx" ? tx : undefined) };
    });
    try {
      const removed = f.request(undefined, false, missing);
      await gate.entered;
      const observed = await request();
      await removed;
      assert.equal(observed.selfWait, false, "transaction required outside cancellation to release its own cleanup barrier");
      assertUnavailable(observed.response, new QueueUnavailableError("queue_missing").message);
    } finally {
      gate.release();
      gate.restore();
    }
  });
