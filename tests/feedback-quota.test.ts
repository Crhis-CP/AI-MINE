import "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { closeDb, feedbackSql as sql } from "@amp/backend/db";
import { submitFeedback, feedbackSourceHash } from "@amp/backend/operations/feedback";
import { banFeedbackEmail, banSource, listFeedback, unbanSource } from "@amp/backend/admin/feedback";

after(closeDb);
const request = (ip: string) => ({ idempotencyKey: randomUUID(), content: "用于验证并行实例和未知回执重试的合成反馈", ip, userAgent: "quota-fixture" });
const execute = promisify(execFile);
async function otherInstance(inputs: ReturnType<typeof request>[]) {
  const code = `import './tests/setup.ts';
    import {submitFeedback} from '@amp/backend/operations/feedback';
    import {closeDb} from '@amp/backend/db';
    const out = await Promise.all(JSON.parse(process.argv[1]).map(async input => {
      try { return {status:201,...await submitFeedback(input)}; } catch(e) { return {status:e.status,message:e.message}; }
    }));
    await closeDb(); console.log('RESULT:'+JSON.stringify(out));`;
  const result = await execute(process.execPath, ["--input-type=module", "-e", code, JSON.stringify(inputs)], { timeout: 30_000 });
  return JSON.parse(result.stdout.match(/RESULT:(.+)/)![1]!) as Array<{ status: number; id?: number }>;
}
const limited = (error: unknown) => (error as { status: number }).status === 429;

test("concurrent exact submissions share one ID across keys and processes; replay attempts pause durably", async () => {
  const inputs = Array.from({ length: 8 }, () => request("quota-client-one"));
  const rows = await Promise.all(inputs.map(submitFeedback));
  assert.equal(new Set(rows.map((r) => r.id)).size, 1);
  const other = await otherInstance(Array.from({ length: 12 }, () => request("quota-client-one")));
  assert.ok(other.every((r) => r.id === rows[0]!.id));
  await assert.rejects(submitFeedback(inputs[0]!), limited);
  assert.equal((await otherInstance([request("quota-client-one")]))[0]!.status, 429);
  const source = feedbackSourceHash("quota-client-one", "quota-fixture");
  assert.equal((await sql`SELECT count(*)::int n FROM feedback WHERE source_hash=${source}`)[0]!.n, 1);
  const paused = await listFeedback({ id: String(rows[0]!.id) });
  assert.ok(paused.rows[0]!.banned_until, "admin shows the durable automatic pause");
  await unbanSource(source, "test");
  assert.equal((await listFeedback({ id: String(rows[0]!.id) })).rows[0]!.banned_until, null);
  assert.deepEqual(await submitFeedback(inputs[0]!), rows[0]);
});

test("three distinct reports pause only that source; expiry, moderator email pause and explicit release work", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const input = { ...request("distinct-source"), email: "reader@example.test" };
  const first = await submitFeedback(input);
  for (let i = 1; i < 3; i++) await submitFeedback({ ...input, idempotencyKey: randomUUID(), content: `不同的反馈内容 ${i}` });
  await assert.rejects(submitFeedback({ ...input, idempotencyKey: randomUUID(), pageUrl: "/daily" }), limited);
  assert.ok((await submitFeedback({ ...request("independent-source"), email: input.email })).id, "unverified email never propagates automatic bans");
  t.mock.timers.tick(3600001);
  assert.ok((await submitFeedback({ ...input, idempotencyKey: randomUUID(), content: "窗口恢复之后的新反馈" })).id);
  await banFeedbackEmail(first.id, "确认滥用", "test");
  await assert.rejects(submitFeedback({ ...request("email-source"), email: input.email }), limited);
  t.mock.timers.tick(48 * 3600000 + 1);
  assert.ok((await submitFeedback({ ...request("email-source"), email: input.email })).id);
  await banSource(feedbackSourceHash(input.ip, input.userAgent), "人工长期暂停", "test");
  await assert.rejects(submitFeedback(input), (e) => (e as { status: number }).status === 403);
  await unbanSource(feedbackSourceHash(input.ip, input.userAgent), "test");
  assert.deepEqual(await submitFeedback(input), first);
});

test("legacy global counters do not block; invalid pictures and changed-key payloads spend attempts", async () => {
  await sql`INSERT INTO feedback.quota_buckets(scope,bucket_key,window_start,used) VALUES('site_day','site',now(),500)`;
  assert.ok((await submitFeedback(request("daily-client-a"))).id);
  for (let i = 0; i < 20; i++)
    await assert.rejects(submitFeedback({ ...request("invalid-image-client"), screenshot: { mime: "image/png", data: Buffer.from("invalid") } }), /有效的/);
  await assert.rejects(submitFeedback(request("invalid-image-client")), limited);
  assert.equal((await sql`SELECT used FROM feedback.quota_buckets WHERE scope='site_day'`)[0]!.used, 500);
});
