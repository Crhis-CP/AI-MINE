import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { injectDb } from "@amp/backend/db";
import { paidRequest, ReceiptUnknownError } from "@amp/backend/providers/receipts";
import { receiptObservedVersion, releaseReceipt } from "@amp/backend/admin/runs";
import { roleFixture } from "./role-db-fixture.ts";

test("an old non-billing confirmation cannot release a new unknown attempt or a changed timestamp", async (t) => {
  const f = await roleFixture(t),
    sql = f.admin;
  const versionFor = async (id: number) => {
    const [row] = await sql<{ receiptId: string; attempts: number; updatedAtUtc: string }[]>`SELECT id::text AS "receiptId", attempts,
      pg_catalog.to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAtUtc" FROM receipts WHERE id=${id}`;
    return receiptObservedVersion(row!);
  };
  let paused = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  let onceOnly = true;
  const ops = new Proxy(sql, {
    apply(target, receiver, args) {
      const query = Reflect.apply(target, receiver, args);
      const text = Array.isArray(args[0]) ? args[0].join("?").replace(/\s+/g, " ").trim() : "";
      if (onceOnly && text.startsWith("SELECT status") && text.includes("FROM receipts WHERE id")) {
        onceOnly = false;
        return (async () => {
          const rows = await query;
          paused.resolve();
          await resume.promise;
          return rows;
        })();
      }
      return query;
    },
  });
  const revoke = injectDb({ "ai-gateway": sql, ops });
  const req = { service: "fixture-aba", purpose: "invariant_test", subject: f.prefix, identity: { prefix: f.prefix } };
  let hits = 0,
    delayed: Promise<unknown> | undefined;
  const provider = createServer((_req, res) => {
    hits++;
    if (hits < 3) return res.destroy();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ attempt: hits }));
  });
  try {
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const url = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
    const call = async () => ({ response: await (await fetch(url)).json() });
    await assert.rejects(paidRequest(req, call));
    const [row] = await sql`SELECT id, attempts, status FROM receipts WHERE subject=${req.subject}`;
    assert.equal(row.attempts, 1);
    assert.equal(row.status, "unknown");
    const evidence = { billed: false, note: "provider record for attempt 1 confirms no charge", version: await versionFor(row.id) };
    delayed = releaseReceipt(row.id, evidence, "fixture-B");
    await paused.promise;
    assert.equal((await releaseReceipt(row.id, evidence, "fixture-A"))?.status, "failed");
    await assert.rejects(paidRequest(req, call));
    resume.resolve();
    await assert.rejects(delayed, (error: { code?: string }) => error.code === "conflict");
    const [after] = await sql`SELECT attempts, status FROM receipts WHERE id=${row.id}`;
    assert.equal(after.attempts, 2);
    assert.equal(after.status, "unknown");
    await assert.rejects(paidRequest(req, call), ReceiptUnknownError);
    assert.equal(hits, 2, "a third request must not reach the fake provider");
    const audits = await sql`SELECT actor, before FROM audit_log WHERE subject=${`receipt:${row.id}`}`;
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actor, "fixture-A");
    assert.equal(audits[0].before.attempts, 1);
    assert.equal(typeof audits[0].before.updatedAt, "string");
    assert.deepEqual(
      (await sql`SELECT status FROM receipt_attempts WHERE receipt_id=${row.id} ORDER BY attempt`).map((r) => r.status),
      ["failed", "unknown"],
    );
    await sql`UPDATE receipts SET updated_at=date_trunc('milliseconds',updated_at)+interval '100 microseconds' WHERE id=${row.id}`;
    const [old] = await sql`SELECT updated_at::text AS version FROM receipts WHERE id=${row.id}`;
    paused = Promise.withResolvers<void>();
    resume = Promise.withResolvers<void>();
    onceOnly = true;
    delayed = releaseReceipt(row.id, { billed: false, note: "provider record for attempt 2", version: await versionFor(row.id) }, "fixture-stale-time");
    await paused.promise;
    await sql`UPDATE receipts SET updated_at=updated_at+interval '1 microsecond' WHERE id=${row.id}`;
    resume.resolve();
    await assert.rejects(delayed, (error: { code?: string }) => error.code === "conflict");
    const [current] = await sql`SELECT updated_at::text AS version FROM receipts WHERE id=${row.id}`;
    assert.notEqual(old.version, current.version);
    assert.equal(new Date(old.version).getTime(), new Date(current.version).getTime(), "millisecond conversion would lose this version change");
    assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE subject=${`receipt:${row.id}`}`)[0].n, 1);
    await assert.rejects(paidRequest(req, call), ReceiptUnknownError);
    assert.equal(hits, 2);
  } finally {
    resume.resolve();
    await delayed?.catch(() => {});
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    revoke();
  }
});
