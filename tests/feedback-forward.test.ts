import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { after, test } from "node:test";
import { config } from "@amp/backend/config";
import { closeDb, dbOf } from "@amp/backend/db";
import { eraseFeedback, feedbackScreenshot } from "@amp/backend/admin/feedback";
import { submitFeedback, forwardPendingFeedback } from "@amp/backend/operations/feedback";

const sql = dbOf("feedback");
config.dataDir = mkdtempSync(path.join(tmpdir(), "amp-feedback-delivery-"));
process.env.FEISHU_APP_ID = "test-app";
process.env.FEISHU_APP_SECRET = "test-secret";
process.env.FEISHU_INTERNAL_CHAT_ID = "oc_feedback_test";
process.env.FEISHU_ALERT_CHAT_ID = "oc_alert_test";
process.env.FEISHU_FEEDBACK_ENABLED = "true";
process.env.FEISHU_INTERNAL_ENABLED = "true";
const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } })
  .png()
  .toBuffer();
let mode: "ok" | "upload-fail" | "send-fail" | "send-unknown" | "upload-structure" | "send-structure" = "ok";
let structuredReply: unknown;
let uploads = 0;
const messages: Array<{ receive_id: string; content: string; uuid: string }> = [];
const alerts: Array<{ receive_id: string; content: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  assert.equal(new URL(url).hostname, "open.feishu.cn", "only the stubbed Feishu API is allowed");
  if (url.includes("tenant_access_token")) return Response.json({ code: 0, tenant_access_token: "test-token", expire: 7200 });
  if (url.endsWith("/images")) {
    uploads++;
    assert.ok(init?.body instanceof FormData);
    assert.ok(init.body.get("image") instanceof Blob);
    return Response.json(
      mode === "upload-structure" ? structuredReply : mode === "upload-fail" ? { code: 234007 } : { code: 0, data: { image_key: "img_feedback_test" } },
    );
  }
  assert.ok(url.includes("/messages?receive_id_type=chat_id"));
  const payload = JSON.parse(String(init?.body));
  if (payload.msg_type === "text") {
    alerts.push(payload);
    return Response.json({ code: 0, data: { message_id: `om_alert_${alerts.length}` } });
  }
  messages.push(payload);
  if (mode === "send-unknown") throw new TypeError("response lost");
  return Response.json(
    mode === "send-structure" ? structuredReply : mode === "send-fail" ? { code: 230020 } : { code: 0, data: { message_id: `om_test_${messages.length}` } },
  );
}) as typeof fetch;
after(async () => {
  globalThis.fetch = realFetch;
  await closeDb();
});

const create = (screenshot = false) =>
  submitFeedback({
    idempotencyKey: randomUUID(),
    content: `专用反馈群完整投递测试 ${tag()}`,
    email: "reader@example.com",
    pageUrl: "/all",
    screenshot: screenshot ? { mime: "image/png", data: png } : null,
    ip: randomUUID(),
    userAgent: "test",
  });
const row = async (id: number) => (await sql`SELECT * FROM feedback WHERE id=${id}`)[0]!;
const ready = (id: number) => sql`UPDATE feedback SET forward_attempted_at=now()-interval '6 minutes' WHERE id=${id}`;

test("full feedback reaches only the dedicated group once; screenshot and handling records stay local", async () => {
  const { id } = await create(true);
  assert.equal(messages.length, 0);
  assert.equal((await row(id)).forward_status, "pending");
  const results = await Promise.all([forwardPendingFeedback(), forwardPendingFeedback()]);
  assert.equal(
    results.reduce((n, r) => n + r.sent, 0),
    1,
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.receive_id, "oc_feedback_test");
  const body = JSON.parse(messages[0]!.content).zh_cn;
  assert.equal(body.title, `读者反馈 #${id}`);
  const text = JSON.stringify(body);
  for (const part of [(await row(id)).content, "reader@example.com", "/all", "img_feedback_test", "/admin/feedback"]) assert.ok(text.includes(part));
  assert.ok(messages[0]!.uuid.length <= 50);
  const stored = await row(id);
  assert.equal(stored.forward_status, "sent");
  assert.ok(stored.forward_message_id && stored.forwarded_at);
  assert.equal(stored.status, "new");
  const file = await feedbackScreenshot(id);
  assert.ok(file && existsSync(file));
  await forwardPendingFeedback();
  assert.equal(messages.length, 1);
});

test("an explicit send failure retries with the uploaded image reused", async () => {
  mode = "send-fail";
  const { id } = await create(true),
    before = uploads;
  assert.equal((await forwardPendingFeedback()).failed, 1);
  assert.equal((await row(id)).forward_status, "retry");
  assert.equal(uploads, before + 1);
  const uuid = messages.at(-1)!.uuid;
  mode = "ok";
  await ready(id);
  assert.equal((await forwardPendingFeedback()).sent, 1);
  assert.equal(uploads, before + 1);
  assert.equal(messages.at(-1)!.uuid, uuid);
});

test("image failure leaves the complete screenshot available for a later retry", async () => {
  mode = "upload-fail";
  const { id } = await create(true),
    before = messages.length;
  assert.equal((await forwardPendingFeedback()).failed, 1);
  assert.equal(messages.length, before);
  assert.ok(existsSync((await feedbackScreenshot(id))!));
  mode = "ok";
  await ready(id);
  assert.equal((await forwardPendingFeedback()).sent, 1);
});

test("unknown sends and interrupted workers are retained without blind duplicate sends", async () => {
  mode = "send-unknown";
  const { id } = await create();
  assert.equal((await forwardPendingFeedback()).unknown, 1);
  assert.equal((await row(id)).forward_status, "unknown");
  const alertCount = alerts.length;
  assert.ok(alertCount > 0);
  for (const alert of alerts) {
    assert.equal(alert.receive_id, "oc_alert_test");
    assert.ok(!alert.content.includes("reader@example.com"));
    assert.ok(!alert.content.includes("专用反馈群完整投递测试"));
    assert.ok(!alert.content.includes("img_feedback_test"));
  }
  const before = messages.length;
  mode = "ok";
  await ready(id);
  await forwardPendingFeedback();
  assert.equal(messages.length, before);
  assert.equal(alerts.length, alertCount, "the same unresolved feedback does not repeatedly alert");
  const interrupted = await create();
  await sql`UPDATE feedback SET forward_status='sending',forward_attempted_at=now()-interval '4 minutes' WHERE id=${interrupted.id}`;
  assert.equal((await forwardPendingFeedback()).unknown, 1);
  assert.equal(messages.length, before);
});

test("disabled switch, missing target, historical and erased rows do not forward", async () => {
  const { id } = await create();
  const before = messages.length;
  process.env.FEISHU_FEEDBACK_ENABLED = "false";
  await forwardPendingFeedback();
  process.env.FEISHU_FEEDBACK_ENABLED = "true";
  delete process.env.FEISHU_INTERNAL_CHAT_ID;
  await forwardPendingFeedback();
  assert.equal(messages.length, before, "never fallback to the alert group");
  process.env.FEISHU_INTERNAL_CHAT_ID = "oc_feedback_test";
  await sql`UPDATE feedback SET forward_status=NULL WHERE id=${id}`;
  const erased = await create();
  await eraseFeedback(erased.id, "test deletion", "test");
  await forwardPendingFeedback();
  assert.equal(messages.length, before);
  assert.equal((await row(erased.id)).forward_status, "cancelled");
});

test("malformed image keys never enter SQL or a message; malformed send receipts remain unknown without retries", async () => {
  for (const image_key of [42, {}, [], "", "   ", null]) {
    mode = "upload-structure";
    structuredReply = { code: 0, data: { image_key } };
    const { id } = await create(true),
      before = messages.length;
    assert.equal((await forwardPendingFeedback()).failed, 1);
    assert.equal(messages.length, before);
    assert.equal((await row(id)).forward_image_key, null);
    assert.ok(existsSync((await feedbackScreenshot(id))!));
    await eraseFeedback(id, "synthetic test cleanup", "test");
  }
  for (const reply of [null, [], { code: "0" }, { code: 0 }, ...[42, {}, [], "", "   ", null].map((message_id) => ({ code: 0, data: { message_id } }))]) {
    mode = "send-structure";
    structuredReply = reply;
    const { id } = await create();
    assert.equal((await forwardPendingFeedback()).unknown, 1);
    assert.equal((await row(id)).forward_status, "unknown");
    assert.equal((await row(id)).forward_message_id, null);
    const before = messages.length;
    mode = "ok";
    await ready(id);
    await forwardPendingFeedback();
    assert.equal(messages.length, before, "unconfirmed responses never authorize another send");
  }
});
