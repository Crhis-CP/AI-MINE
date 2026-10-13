// Feishu sign-in is kept but off by default: the sign-in page offers it only once both login-app
// credentials are configured (the Owner kept Feishu push and sign-in on 2026-10-02, TASK-0003).
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { config } from "@amp/backend/config";
import { completeLogin, loginRedirect } from "@amp/backend/admin/auth";
import { buildApp } from "../apps/api/src/app.ts";

delete process.env.FEISHU_LOGIN_APP_ID;
delete process.env.FEISHU_LOGIN_APP_SECRET;
const app = await buildApp("private-api");
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

test("Feishu identity JSON is validated before allowlist lookup or SQL writes", async (t) => {
  process.env.FEISHU_LOGIN_APP_ID = "synthetic-login-id";
  process.env.FEISHU_LOGIN_APP_SECRET = "synthetic-login-secret";
  const before = config.adminUnionIds;
  config.adminUnionIds = ["synthetic-union"];
  t.after(() => {
    config.adminUnionIds = before;
  });
  let identity: unknown = { union_id: "synthetic-union", email: "valid@synthetic.test", enterprise_email: null, name: "Synthetic login" };
  let token: unknown = { access_token: "synthetic-access-token" };
  t.mock.method(globalThis, "fetch", async (input: unknown) => Response.json(String(input).endsWith("/token") ? token : identity));
  const state = () => {
    const value = loginRedirect("/admin");
    return [new URL(value.url).searchParams.get("state")!, value.stateCookie] as const;
  };
  const sql = dbOf("identity");
  const count = async () => (await sql`SELECT count(*)::int n FROM admin_users`)[0]!.n;
  const baseline = await count();
  for (const bad of [{ union_id: { untrusted: true } }, { union_id: "synthetic-union", name: ["bad"] }, { union_id: "synthetic-union", email: 5 }]) {
    identity = bad;
    const [given, cookie] = state();
    await assert.rejects(completeLogin("synthetic-code", given, cookie, undefined));
    assert.equal(await count(), baseline);
  }
  token = { access_token: { untrusted: true } };
  const [given, cookie] = state();
  await assert.rejects(completeLogin("synthetic-code", given, cookie, undefined));
  assert.equal(await count(), baseline);
  token = { access_token: "synthetic-access-token" };
  identity = { union_id: "synthetic-union", email: "VALID@synthetic.test", enterprise_email: null, name: "Synthetic login" };
  const [validState, validCookie] = state();
  const result = await completeLogin("synthetic-code", validState, validCookie, "Synthetic test");
  assert.equal(result.returnTo, "/admin");
  const [user] = await sql`SELECT email,display_name FROM admin_users WHERE id=${result.userId}`;
  assert.deepEqual({ ...user }, { email: "valid@synthetic.test", display_name: "Synthetic login" });
});
