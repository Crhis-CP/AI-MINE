// Feishu sign-in is kept but off by default: the sign-in page offers it only once both login-app
// credentials are configured (the Owner kept Feishu push and sign-in on 2026-10-02, TASK-0003).
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@amp/backend/db";
import { buildApp } from "../apps/api/src/app.ts";

delete process.env.FEISHU_LOGIN_APP_ID;
delete process.env.FEISHU_LOGIN_APP_SECRET;
const app = await buildApp();
after(async () => {
  delete process.env.FEISHU_LOGIN_APP_ID;
  delete process.env.FEISHU_LOGIN_APP_SECRET;
  await app.close();
  await closeDb();
});

async function feishuOffered() {
  const result = await app.inject({ method: "GET", url: "/api/auth/options" });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.headers["cache-control"], "no-store");
  return (result.json() as { feishu: boolean }).feishu;
}

test("Feishu sign-in is offered only when both login-app credentials are set", async () => {
  assert.equal(await feishuOffered(), false);
  process.env.FEISHU_LOGIN_APP_ID = "cli_test_login_app";
  assert.equal(await feishuOffered(), false, "an app id without its secret is not enough");
  process.env.FEISHU_LOGIN_APP_SECRET = "test-login-app-secret";
  assert.equal(await feishuOffered(), true);
  process.env.FEISHU_LOGIN_APP_ID = " ";
  assert.equal(await feishuOffered(), false, "a blank app id counts as unset");
});
