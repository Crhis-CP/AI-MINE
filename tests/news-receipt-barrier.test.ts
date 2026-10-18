import "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { closeDb, sql } from "@amp/backend/db";
import { paidRequest, logicalKeyFor, rejectReceivedResponse, ReceiptUnknownError, ReceiptBusyError } from "@amp/backend/providers/receipts";

after(closeDb);
test("unknown and pending hold their own news key while distinct requests keep their own ledger", async () => {
  const original = {
    lane: "news" as const,
    service: "old",
    model: "model-A",
    purpose: "summarize_article",
    subject: "article:barrier@1",
    identity: { text: "same" },
  };
  const oldKey = logicalKeyFor(original);
  await sql`INSERT INTO receipts(logical_key,service,model,purpose,subject,status,request,attempts)
    VALUES(${oldKey},'old','model-A','summarize_article','article:barrier@1','unknown','{"lane":"news","userHash":"same"}',1)`;
  let hits = 0;
  const send = async () => {
    hits++;
    return { response: { ok: true } };
  };
  await assert.rejects(paidRequest(original, send), ReceiptUnknownError);
  for (const attemptTag of [undefined, "admin:changed-route"]) {
    const fresh = {
      ...original,
      service: "new",
      model: "model-B",
      identity: { configuration: "new", text: "same" },
      legacyIdentity: original.identity,
      requestSummary: { userHash: "same" },
      attemptTag,
    };
    const first = await paidRequest(fresh, send),
      reused = await paidRequest(fresh, send);
    assert.equal(reused.receiptId, first.receiptId);
    assert.ok(reused.reused);
  }
  assert.equal(hits, 2);
  assert.equal((await sql`SELECT status FROM receipts WHERE logical_key=${oldKey}`)[0].status, "unknown");
  await sql`UPDATE receipts SET status='pending' WHERE logical_key=${oldKey}`;
  await assert.rejects(paidRequest(original, send), ReceiptBusyError);
  await paidRequest({ ...original, service: "new", model: "model-B", identity: { text: "corrected" } }, send);
  assert.equal(hits, 3);
});

test("missing usage does not block known responses, and bad outputs still stop after three physical attempts", async () => {
  const req = {
    lane: "news" as const,
    service: "fixture-no-usage",
    model: "synthetic-model",
    purpose: "summarize_article",
    subject: "article:known-response@1",
    identity: { version: 1 },
  };
  let calls = 0;
  const send = async () => {
    calls++;
    return { response: { invalid: true } };
  };
  for (let n = 0; n < 3; n++) {
    const result = await paidRequest(req, send);
    assert.equal(result.reused, false);
    await rejectReceivedResponse(result.receiptId, "synthetic invalid output", result.attemptId);
  }
  assert.equal((await paidRequest(req, send)).reused, true);
  assert.equal(calls, 3);
  const known = await paidRequest({ ...req, identity: { version: 2 } }, send);
  assert.equal(known.reused, false, "known response and unknown bill are distinct from an unknown result");
  assert.equal(calls, 4);
  const rows = await sql`SELECT a.status,a.usage,u.state FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id
    JOIN ai.usage_attempts u ON u.attempt_id=a.id WHERE r.subject=${req.subject}`;
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => row.status === "received" && row.usage === null && row.state === "unknown"));
});
