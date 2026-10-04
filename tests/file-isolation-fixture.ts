import { stub } from "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { BudgetExceededError, paidRequest } from "@amp/backend/providers/receipts";
import { ensureQueue, getBoss, stopBoss } from "@amp/backend/jobs/queue";

/** Two real files deliberately share logical keys, budget rows and queue names. */
export function isolatedFile(label: string) {
  test(`${label}: paid budgets and queue data belong only to this file`, async (t) => {
    const sql = dbOf("ai-gateway"),
      provider = await stub(() => ({ label }));
    t.after(async () => {
      await provider.close();
      await stopBoss();
      await closeDb();
    });
    assert.equal((await sql`SELECT current_database() AS name`)[0].name, new URL(process.env.DATABASE_URL!).pathname.slice(1));
    assert.equal((await sql`SELECT count(*)::int AS n FROM receipts`)[0].n, 0);
    assert.ok((await sql`SELECT count(*)::int AS n FROM topics`)[0].n > 0);
    await sql`UPDATE budgets SET per_minute=1, per_hour=1, per_day=1 WHERE service='deepseek'`;
    const request = { service: "deepseek", purpose: "file-isolation", identity: "same-input" };
    const call = async () => ({ response: await (await fetch(provider.url)).json() });
    const result = await paidRequest(request, call);
    assert.equal(result.reused, false);
    assert.deepEqual(result.response, { label });
    await assert.rejects(paidRequest({ ...request, identity: "second-input" }, call), BudgetExceededError);
    assert.equal(provider.hits(), 1);
    const boss = await getBoss(),
      queue = "fixture.file-isolation";
    await ensureQueue(queue);
    assert.equal((await boss.getDb().executeSql("SELECT count(*)::int AS n FROM pgboss.job WHERE name=$1", [queue])).rows[0].n, 0);
    const id = await boss.send(queue, { label });
    assert.ok(id);
    assert.deepEqual((await boss.getJobById(queue, id))!.data, { label });
  });
}
