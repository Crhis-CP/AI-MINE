import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { checkWorkerHeartbeat } from "@amp/backend/operations/watch";

after(closeDb);

test("watchdog retries failed delivery, serializes concurrent checks and reports recovery only after delivery", async () => {
  await sql`DELETE FROM settings WHERE key IN ('heartbeat.worker','watchdog.worker')`;
  const now = Date.now(),
    stale = new Date(now - 3600_000),
    sent: string[] = [];
  const notify = async (title: string) => {
    sent.push(title);
    return "sent" as const;
  };
  await checkWorkerHeartbeat(notify, now);
  assert.equal(sent.length, 0);
  await sql`INSERT INTO settings(key,value,updated_by,updated_at) VALUES('heartbeat.worker','{}','worker',${stale})`;
  await assert.rejects(
    checkWorkerHeartbeat(async () => {
      throw new Error("simulated delivery failure");
    }, now),
    /simulated delivery failure/,
  );
  assert.equal((await sql`SELECT 1 FROM settings WHERE key='watchdog.worker'`).length, 0);
  await checkWorkerHeartbeat(async () => "disabled", now);
  assert.equal((await sql`SELECT 1 FROM settings WHERE key='watchdog.worker'`).length, 0, "disabled delivery is not reported as notified");
  await Promise.all([checkWorkerHeartbeat(notify, now), checkWorkerHeartbeat(notify, now)]);
  assert.equal(sent.length, 1);
  let [row] = await sql`SELECT value FROM settings WHERE key='watchdog.worker'`;
  assert.equal(row.value.state, "down");
  assert.equal(row.value.since, stale.toISOString());
  await sql`UPDATE settings SET updated_at=${new Date(now)} WHERE key='heartbeat.worker'`;
  await assert.rejects(
    checkWorkerHeartbeat(async () => {
      throw new Error("simulated recovery failure");
    }, now),
    /simulated recovery failure/,
  );
  [row] = await sql`SELECT value FROM settings WHERE key='watchdog.worker'`;
  assert.equal(row.value.state, "down");
  await Promise.all([checkWorkerHeartbeat(notify, now), checkWorkerHeartbeat(notify, now)]);
  assert.equal(sent.length, 2);
  [row] = await sql`SELECT value FROM settings WHERE key='watchdog.worker'`;
  assert.equal(row.value.state, "up");
});
