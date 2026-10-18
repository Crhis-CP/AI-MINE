import "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { feedbackSql as sql, closeDb } from "@amp/backend/db";
import { updateFeedback, anonymizeExpiredFeedback, weeklyFeedbackSummary, sendWeeklyFeedbackSummary } from "@amp/backend/admin/feedback";

after(closeDb);
test("completion time remains stable, 180-day cleanup preserves feedback and removes identifying fields", async () => {
  const [f] =
    await sql`INSERT INTO feedback(content,email,source_hash,status) VALUES('网页错误请检查，联系 chris@example.com','chris@example.com','private-hash','new') RETURNING *`;
  await updateFeedback(f!.id, { status: "resolved", version: f!.updated_at.toISOString() }, "test");
  const [first] = await sql`SELECT * FROM feedback WHERE id=${f!.id}`;
  await updateFeedback(f!.id, { note: "已处理", version: first!.updated_at.toISOString() }, "test");
  assert.equal((await sql`SELECT completed_at FROM feedback WHERE id=${f!.id}`)[0]!.completed_at.toISOString(), first!.completed_at.toISOString());
  const now = new Date(first!.completed_at.getTime() + 181 * 86400000);
  assert.equal((await anonymizeExpiredFeedback(now)).cleaned, 1);
  const [row] = await sql`SELECT * FROM feedback WHERE id=${f!.id}`;
  assert.equal(row!.email, null);
  assert.equal(row!.source_hash, null);
  assert.ok(row!.content.includes("网页错误请检查"));
  assert.ok(!row!.content.includes("chris@example.com"));
  assert.equal((await anonymizeExpiredFeedback(now)).cleaned, 0);
  const summary = await weeklyFeedbackSummary(new Date());
  assert.ok(!JSON.stringify(summary).includes("chris"));
  assert.ok(!JSON.stringify(summary).includes("private-hash"));
});

test("weekly alerts retry failure and send only aggregate data once", async () => {
  let hits = 0;
  const now = new Date("2026-10-04T23:59:00Z");
  await assert.rejects(() =>
    sendWeeklyFeedbackSummary(now, async () => {
      hits++;
      throw new Error("synthetic transport failure");
    }),
  );
  const sent = await sendWeeklyFeedbackSummary(now, async (_title, lines) => {
    hits++;
    assert.ok(!JSON.stringify(lines).includes("chris@example.com"));
    return "sent";
  });
  assert.equal(sent.delivery, "sent");
  const again = await sendWeeklyFeedbackSummary(now, async () => {
    hits++;
    return "sent";
  });
  assert.equal(again.delivery, "already_sent");
  assert.equal(hits, 2);
});

test("status-only feedback edits preserve the stored typed note while explicit null clears it", async () => {
  const [row] = await sql`INSERT INTO feedback(content,status,note) VALUES('合成反馈备注保留验证','new','保留此备注') RETURNING id,updated_at`;
  const changed = await updateFeedback(row!.id, { status: "triaged", version: row!.updated_at.toISOString() }, "test");
  assert.equal(changed!.note, "保留此备注");
  const cleared = await updateFeedback(row!.id, { note: null, version: changed!.updated_at.toISOString() }, "test");
  assert.equal(cleared!.note, null);
  await assert.rejects(updateFeedback(row!.id, { note: "过期写入", version: row!.updated_at.toISOString() }, "test"), { code: "conflict" });
});
