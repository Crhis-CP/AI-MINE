import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { paidRequest } from "@amp/backend/providers/receipts";
import { installUsageFixtureForService } from "./usage-protection-fixture.ts";
const sql = dbOf("ai-gateway");
after(closeDb);
test("actual receipt reuse increments the local counter atomically without another physical attempt", async () => {
  await installUsageFixtureForService("synthetic-local-reuse");
  let calls = 0;
  const request = {
    service: "synthetic-local-reuse",
    purpose: "structure",
    lane: "policy" as const,
    subject: "policy:synthetic-reuse",
    identity: { input: "synthetic-only" },
  };
  const run = () =>
    paidRequest(request, async () => {
      calls++;
      return { response: { ok: true }, usage: { prompt_tokens: 1, completion_tokens: 1 } };
    });
  const first = await run();
  assert.equal(first.reused, false);
  const cached = await Promise.all(Array.from({ length: 8 }, run));
  assert.ok(cached.every((r) => r.reused));
  assert.equal(calls, 1);
  const [counter] = await sql`SELECT sum(count)::int n FROM ai.local_reuse_daily WHERE service='synthetic-local-reuse' AND lane='policy'`;
  assert.equal(counter.n, 8);
  const [attempts] = await sql`SELECT count(*)::int n FROM receipt_attempts WHERE receipt_id=${first.receiptId}`;
  assert.equal(attempts.n, 1);
});
