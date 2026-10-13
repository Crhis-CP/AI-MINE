import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { injectDb } from "@amp/backend/db";
import { sha256 } from "@amp/backend/lib/ids";
import { SESSION_COOKIE } from "@amp/backend/admin/auth";
import { buildApp } from "../apps/api/src/app.ts";
import { publicRoleFixture } from "./public-role-fixture.ts";
import { denied } from "./role-db-fixture.ts";

test("real auth/private_ops/worker/public roles enforce Owner-only, closed-by-default, CSRF and immutable confirmation boundaries", async (t) => {
  const f = await publicRoleFixture(t),
    dbs = await f.login(),
    dispose = injectDb({ identity: dbs.auth, "ai-gateway": dbs.private_ops, content: dbs.private_ops, enrichment: dbs.private_ops, sources: dbs.private_ops });
  t.after(dispose);
  async function account(name: string, role: "owner" | "admin") {
    const [user] = await dbs.auth`INSERT INTO admin_users(email,display_name) VALUES(${`${name}@synthetic.test`},${name}) RETURNING id`;
    await dbs.auth`INSERT INTO identity.account_access(user_id,role,models_manage,must_change_password) VALUES(${user!.id},${role},true,false)`;
    const token = `synthetic-${name}`;
    await dbs.auth`INSERT INTO admin_sessions(id_hash,user_id,csrf_token,expires_at,last_seen_at) VALUES(${sha256(token)},${user!.id},'test-csrf',now()+interval '1 hour',now())`;
    return { id: Number(user!.id), cookie: `${SESSION_COOKIE}=${token}` };
  }
  const owner = await account("selection-owner", "owner"),
    manager = await account("selection-manager", "admin"),
    app = await buildApp("private-api");
  t.after(() => app.close());
  const request = (url: string, cookie?: string, payload?: unknown, csrf = true) =>
    app.inject({
      method: payload ? "POST" : "GET",
      url,
      headers: { ...(cookie ? { cookie } : {}), ...(csrf ? { "x-csrf-token": "test-csrf" } : {}) },
      ...(payload ? { payload } : {}),
    });
  assert.equal((await request("/api/admin/selectbench/control")).statusCode, 401);
  assert.equal((await request("/api/admin/selectbench/standards", manager.cookie)).statusCode, 403);
  const control = await request("/api/admin/selectbench/control", owner.cookie);
  assert.equal(control.statusCode, 200, control.body);
  assert.equal(control.json().enabled, false);
  assert.equal((await request("/api/admin/selectbench", owner.cookie)).statusCode, 409);
  const command = {
    requestId: randomUUID(),
    expectedRevision: 0,
    enabled: true,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    reason: "Synthetic isolated role test",
  };
  assert.equal((await request("/api/admin/selectbench/control", owner.cookie, command, false)).statusCode, 403);
  const opened = await request("/api/admin/selectbench/control", owner.cookie, command);
  assert.equal(opened.statusCode, 200, opened.body);
  assert.equal((await request("/api/admin/selectbench", owner.cookie)).statusCode, 200);
  const status = await request("/api/admin/selectbench/standards", owner.cookie);
  assert.equal(status.statusCode, 200, status.body);
  assert.equal(status.json().checks.ownerStandardReview, false);
  await denied(dbs.worker, "UPDATE ai.selection_tool_control SET expires_at=now()");
  await denied(dbs.worker, "INSERT INTO ai.selection_records(id,kind,payload) VALUES('forged','standard_review','{}')");
  await denied(dbs.private_ops, "UPDATE ai.selection_records SET payload='{}'");
  await denied(dbs.public_read, "SELECT * FROM ai.selection_samples");
  await dbs.auth`UPDATE identity.account_access SET revision=revision+1 WHERE user_id=${owner.id}`;
  await dbs.auth`DELETE FROM admin_sessions WHERE user_id=${owner.id}`;
  assert.equal((await request("/api/admin/selectbench/control", owner.cookie)).statusCode, 401);
});
