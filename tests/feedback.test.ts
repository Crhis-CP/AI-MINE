// Reader feedback stays on the server (INV-27): even with the internal Feishu chat switched on and its
// app configured, feedback with a screenshot sends nothing to Feishu, and the screenshot is kept as a
// local file that only the admin pages read.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { after, test } from "node:test";
import { feedbackScreenshot } from "@amp/backend/admin/feedback";
import { config } from "@amp/backend/config";
import { closeDb, dbOf, initializeDb } from "@amp/backend/db";
import { submitFeedback } from "@amp/backend/operations/feedback";

const sql = dbOf("feedback");

const T = tag();
config.dataDir = mkdtempSync(path.join(tmpdir(), "amp-feedback-"));
// Everything the internal chat needs is in place: alerts would go out.
process.env.FEISHU_INTERNAL_ENABLED = "true";
process.env.FEISHU_APP_ID = "test-app";
process.env.FEISHU_APP_SECRET = "test-secret";
process.env.FEISHU_INTERNAL_CHAT_ID = "oc_test";

// Feishu, answered here: every request is recorded.
const feishuRequests: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!new URL(url).hostname.endsWith("feishu.cn")) return realFetch(input, init);
  feishuRequests.push(url);
  return Response.json({ code: 0, tenant_access_token: "t", expire: 7200, data: { image_key: "img", message_id: "m1" } });
}) as typeof fetch;

after(async () => {
  globalThis.fetch = realFetch;
  await closeDb();
});

const PNG = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } })
  .png()
  .toBuffer();

test("feedback with a screenshot is kept here and nothing goes to Feishu", async () => {
  const { id } = await submitFeedback({
    idempotencyKey: randomUUID(),
    content: `反馈 ${T}`,
    email: "reader@example.com",
    pageUrl: "/daily",
    screenshot: { mime: "image/png", data: PNG },
    ip: "203.0.113.7",
    userAgent: "test",
  });
  // A send started in the background after the reply would have reached Feishu by now.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(feishuRequests, [], "no request to Feishu");
  const [row] = await sql<{ content: string; screenshot_key: string }[]>`SELECT content, screenshot_key FROM feedback WHERE id = ${id}`;
  assert.equal(row!.content, `反馈 ${T}`);
  assert.match(row!.screenshot_key, /^local:/);
  const file = await feedbackScreenshot(id);
  assert.ok(file && existsSync(file), "the admin pages read the screenshot from the server");
});

test("feedback accepts general contact and 5000 characters while enforcing 10-character and 2MB limits", async () => {
  const common = {
    idempotencyKey: randomUUID(),
    email: "微信：reader-contact",
    pageUrl: "/all",
    screenshot: null,
    ip: "203.0.113.8",
    userAgent: "validation-test",
  };
  await assert.rejects(submitFeedback({ ...common, content: "太短" }), /至少 10/);
  await assert.rejects(submitFeedback({ ...common, content: "字".repeat(5001) }), /最多 5000/);
  await assert.rejects(
    submitFeedback({ ...common, content: "反馈内容用于校验截图大小", screenshot: { mime: "image/png", data: Buffer.alloc(2 * 1024 * 1024 + 1) } }),
    /2MB/,
  );
  const { id } = await submitFeedback({ ...common, content: "字".repeat(5000) });
  const [row] = await sql`SELECT email,length(content) AS length FROM feedback WHERE id=${id}`;
  assert.equal(row.email, common.email);
  assert.equal(row.length, 5000);
});

test("durable submission keys reuse the original row after response loss and reject changed payloads", async () => {
  const request = {
    idempotencyKey: randomUUID(),
    content: "相同请求丢失响应后不应新增反馈记录",
    email: "reader@example.com",
    pageUrl: "/daily",
    ip: "203.0.113.41",
    userAgent: "test",
  };
  const results = await Promise.all([submitFeedback(request), submitFeedback(request), submitFeedback(request)]);
  assert.ok(results.every((r) => r.id === results[0]!.id));
  assert.equal((await sql`SELECT count(*)::int AS n FROM feedback WHERE content=${request.content}`)[0]!.n, 1);
  await closeDb();
  await initializeDb("test");
  assert.deepEqual(await submitFeedback({ ...request, ip: "203.0.113.42" }), results[0]);
  for (const patch of [
    { content: "同一提交编号但更改了反馈正文内容" },
    { email: "other@example.com" },
    { pageUrl: "/all" },
    { screenshot: { mime: "image/png", data: PNG } },
  ])
    await assert.rejects(submitFeedback({ ...request, ...patch }), (error) => error instanceof Error && "status" in error && error.status === 409);
  await assert.rejects(submitFeedback({ ...request, idempotencyKey: undefined }), /提交编号/);
});
