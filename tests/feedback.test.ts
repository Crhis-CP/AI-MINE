// Reader feedback stays on the server (INV-27): even with the internal Feishu chat switched on and its
// app configured, feedback with a screenshot sends nothing to Feishu, and the screenshot is kept as a
// local file that only the admin pages read.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { feedbackScreenshot } from "@aihot/backend/admin/feedback";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { submitFeedback } from "@aihot/backend/operations/feedback";

const T = tag();
config.dataDir = mkdtempSync(path.join(tmpdir(), "aihot-feedback-"));
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

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

test("feedback with a screenshot is kept here and nothing goes to Feishu", async () => {
  const { id } = await submitFeedback({
    content: `反馈 ${T}`,
    email: "reader@example.com",
    pageUrl: "/daily",
    screenshot: { mime: "image/png", data: Buffer.concat([PNG, Buffer.from(T)]) },
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
