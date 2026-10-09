import assert from "node:assert/strict";
import { test } from "node:test";
import { injectDb } from "@amp/backend/db";
import { sha256 } from "@amp/backend/lib/ids";
import { SESSION_COOKIE } from "@amp/backend/admin/auth";
import { buildApp } from "../apps/api/src/app.ts";
import { publicRoleFixture } from "./public-role-fixture.ts";
import { denied } from "./role-db-fixture.ts";
test("real private API requires current model capability and CSRF, preserves CAS and keeps backup configuration private", async (t) => {
  const f = await publicRoleFixture(t),
    dbs = await f.login(),
    dispose = injectDb({ identity: dbs.auth, "ai-gateway": dbs.private_ops, sources: dbs.private_ops, policy: dbs.private_ops });
  t.after(dispose);
  async function account(name: string, manage: boolean) {
    const [u] = await dbs.auth`INSERT INTO admin_users(email,display_name) VALUES(${`${name}@fixture.invalid`},${name}) RETURNING id`;
    await dbs.auth`INSERT INTO identity.account_access(user_id,role,models_manage,must_change_password) VALUES(${u!.id},'admin',${manage},false)`;
    const token = `fixture-${name}`;
    await dbs.auth`INSERT INTO admin_sessions(id_hash,user_id,csrf_token,expires_at,last_seen_at) VALUES(${sha256(token)},${u!.id},'csrf',now()+interval '1 hour',now())`;
    return { cookie: `${SESSION_COOKIE}=${token}`, id: Number(u!.id) };
  }
  const manager = await account("manager", true),
    ordinary = await account("ordinary", false),
    app = await buildApp("private-api");
  t.after(() => app.close());
  const get = (cookie?: string) => app.inject({ method: "GET", url: "/api/admin/model-fallbacks", headers: cookie ? { cookie } : {} });
  assert.equal((await get()).statusCode, 401);
  assert.equal((await get(ordinary.cookie)).statusCode, 403);
  const first = await get(manager.cookie);
  assert.equal(first.statusCode, 200, first.body);
  assert.ok(first.json().routes.every((r: { state: string }) => r.state === "none"));
  const body = { expected_revision: 0, backup_model: null, source_ids: [], reason: "SYNTHETIC default off" };
  assert.equal(
    (await app.inject({ method: "PUT", url: "/api/admin/model-fallbacks/summarize", headers: { cookie: manager.cookie }, payload: body })).statusCode,
    403,
  );
  const save = () =>
    app.inject({ method: "PUT", url: "/api/admin/model-fallbacks/summarize", headers: { cookie: manager.cookie, "x-csrf-token": "csrf" }, payload: body });
  const saved = await save();
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().revision, 1);
  assert.equal((await save()).statusCode, 409);
  await denied(dbs.worker, "UPDATE ai.model_fallback_routes SET backup_model=NULL");
  await denied(dbs.public_read, "SELECT * FROM ai.model_fallback_routes");
  await denied(dbs.public_read, "SELECT * FROM ai.model_fallback_resolutions");
  await dbs.auth`UPDATE identity.account_access SET models_manage=false,revision=revision+1 WHERE user_id=${manager.id}`;
  assert.equal((await get(manager.cookie)).statusCode, 403);
});
