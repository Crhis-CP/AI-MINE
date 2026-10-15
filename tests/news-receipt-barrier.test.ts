import "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { closeDb, dbOf } from "@amp/backend/db";
import { paidRequest, rejectReceivedResponse, ReceiptUnknownError, ReceiptBusyError } from "@amp/backend/providers/receipts";
const sql = dbOf("ai-gateway");
after(closeDb);
test("model and attempt tag changes cannot bypass unresolved news material cost", async () => {
  await sql`INSERT INTO receipts(logical_key,service,model,purpose,subject,status,request,attempts)
    VALUES('news-old-model','old','model-A','summarize_article','article:barrier@1','unknown','{"lane":"news"}',1)`;
  let hits = 0;
  for (const attemptTag of [undefined, "admin:changed-route"])
    await assert.rejects(
      () =>
        paidRequest(
          {
            lane: "news",
            service: "new",
            model: "model-B",
            purpose: "summarize_article",
            subject: "article:barrier@1",
            identity: { new: true },
            attemptTag,
          },
          async () => {
            hits++;
            return { response: {} };
          },
        ),
      ReceiptUnknownError,
    );
  assert.equal(hits, 0);
  await sql`UPDATE receipts SET status='pending' WHERE logical_key='news-old-model'`;
  await assert.rejects(
    () =>
      paidRequest({ lane: "news", service: "new", model: "B", purpose: "summarize_article", subject: "article:barrier@1", identity: 2 }, async () => ({
        response: {},
      })),
    ReceiptBusyError,
  );
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
