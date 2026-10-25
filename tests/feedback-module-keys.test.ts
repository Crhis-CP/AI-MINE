import "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { closeDb, sql } from "@amp/backend/db";
import { installModules, serverModules } from "@amp/backend/modules";
import { submitFeedback, feedbackSourceHash, feedbackEmailKey, FeedbackRejected } from "@amp/backend/operations/feedback";

const original = serverModules();
after(async () => {
  installModules(original);
  await closeDb();
});
const input = {
  idempotencyKey: randomUUID(),
  content: "模块封禁合成反馈",
  ip: "203.0.113.47",
  userAgent: "module-fixture",
  email: "module-fixture@example.test",
};
const source = feedbackSourceHash(input.ip, input.userAgent);
const key = "module:synthetic-key";
const rejection = (status: number) => (error: unknown) => error instanceof FeedbackRejected && error.status === status;

test("all known keys honor permanent, temporary and expired bans before writing", async () => {
  installModules([
    {
      name: "known-source",
      feedbackKeys: (ip) => {
        assert.equal(ip, input.ip);
        return [key, key];
      },
    },
  ]);
  await sql`INSERT INTO feedback_bans(source_hash,reason,created_by) VALUES(${key},'合成','test')`;
  await assert.rejects(submitFeedback(input), rejection(403));
  assert.equal((await sql`SELECT 1 FROM feedback WHERE source_hash=${source}`).length, 0);
  assert.equal((await sql`SELECT 1 FROM feedback.submission_state WHERE source_hash=${source}`).length, 0);
  await sql`UPDATE feedback_bans SET expires_at=now()+interval '1 hour' WHERE source_hash=${key}`;
  await assert.rejects(submitFeedback(input), (error: unknown) => rejection(429)(error) && (error as FeedbackRejected).retryAfter! > 0);
  await sql`UPDATE feedback_bans SET expires_at=now()-interval '1 second' WHERE source_hash=${key}`;
  const saved = await submitFeedback(input);
  assert.ok(saved.id > 0);
  assert.deepEqual(await submitFeedback(input), saved);
  for (const originalKey of [source, feedbackEmailKey(input.email)]) {
    await sql`INSERT INTO feedback_bans(source_hash,reason,created_by) VALUES(${originalKey},'合成','test')`;
    await assert.rejects(submitFeedback(input), rejection(403));
    await sql`DELETE FROM feedback_bans WHERE source_hash=${originalKey}`;
  }
});

test("missing key lookup or invalid module output cannot bypass existing moderator controls", async () => {
  for (const feedbackKeys of [
    () => {
      throw Error("fixture lookup unavailable");
    },
    () => [""],
    () => null as unknown as string[],
  ]) {
    installModules([{ name: "bad-source", feedbackKeys }]);
    await assert.rejects(submitFeedback({ ...input, idempotencyKey: randomUUID(), content: "不应保存的新反馈" }));
  }
  assert.equal((await sql`SELECT 1 FROM feedback WHERE content='不应保存的新反馈'`).length, 0);
  installModules([]);
  assert.ok((await submitFeedback({ ...input, idempotencyKey: randomUUID(), content: "默认来源正常提交" })).id);
});
