import "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { closeDb, dbOf } from "@amp/backend/db";
import { paidRequest, ReceiptUnknownError, ReceiptBusyError } from "@amp/backend/providers/receipts";
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
