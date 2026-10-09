import assert from "node:assert/strict";
import { test } from "node:test";
import { publicRoleFixture } from "./public-role-fixture.ts";
import { injectDb } from "@amp/backend/db";
import { sha256 } from "@amp/backend/lib/ids";
import { SESSION_COOKIE } from "@amp/backend/admin/auth";
import { config } from "@amp/backend/config";
import { buildApp } from "../apps/api/src/app.ts";
import { stopBoss } from "@amp/backend/jobs/queue";
import { ModelConnectionRecord, ModelRegistryResponse } from "@amp/contracts/http/private";

test("model HTTP routes enforce current identity, CSRF and revision while returning only safe connection metadata", async (t) => {
  const f = await publicRoleFixture(t),
    dbs = await f.login();
  const restore = injectDb({ identity: dbs.auth, "ai-gateway": dbs.private_ops, ops: dbs.private_ops, sources: dbs.private_ops });
  t.after(restore);
  t.after(stopBoss);
  const beforeKey = process.env.MODEL_REGISTRY_ENCRYPTION_KEY;
  process.env.MODEL_REGISTRY_ENCRYPTION_KEY = Buffer.alloc(32, 93).toString("base64");
  t.after(() => {
    if (beforeKey) process.env.MODEL_REGISTRY_ENCRYPTION_KEY = beforeKey;
    else delete process.env.MODEL_REGISTRY_ENCRYPTION_KEY;
  });
  async function principal(name: string, role: "owner" | "admin", manage: boolean) {
    const [u] = await dbs.auth`INSERT INTO admin_users(email,display_name) VALUES(${`${name}@synthetic.invalid`},${name}) RETURNING id`;
    await dbs.auth`INSERT INTO identity.account_access(user_id,role,models_manage) VALUES(${u.id},${role},${manage})`;
    const token = `model-http-${name}`;
    await dbs.auth`INSERT INTO admin_sessions(id_hash,user_id,csrf_token,expires_at) VALUES(${sha256(token)},${u.id},'synthetic-csrf',now()+interval '1 hour')`;
    return {
      id: Number(u.id),
      headers: {
        cookie: `${SESSION_COOKIE}=${token}`,
        "x-csrf-token": "synthetic-csrf",
        ...(config.privateHost ? { "x-forwarded-host": config.privateHost } : {}),
      },
    };
  }
  const owner = await principal("owner", "owner", true),
    manager = await principal("manager", "admin", true),
    basic = await principal("basic", "admin", false);
  const app = await buildApp("private-api");
  t.after(() => app.close());
  const payload = {
    name: "HTTP synthetic",
    interface: "openai-compatible",
    endpoint: "https://fixture.invalid/v1",
    model: "synthetic-model",
    input_cny_per_million: "2",
    output_cny_per_million: "4",
    billing_basis: "https://fixture.invalid/prices",
    vision: false,
    json_mode: true,
    secret: "synthetic-no-production-key",
    owner_confirmed: true,
    supplier_basis: "https://fixture.invalid/quote",
    reason: "isolated HTTP fixture",
  };
  const request = (method: "GET" | "POST" | "PUT", url: string, who = owner, body?: unknown) =>
    app.inject({ method, url, headers: who.headers, ...(body ? { payload: body as object } : {}) });
  assert.equal((await request("GET", "/api/admin/model-connections", basic)).statusCode, 403);
  assert.equal((await request("POST", "/api/admin/model-connections", manager, payload)).statusCode, 403);
  assert.equal(
    (await app.inject({ method: "POST", url: "/api/admin/model-connections", headers: { ...owner.headers, "x-csrf-token": "stale" }, payload })).statusCode,
    403,
  );
  assert.equal((await request("POST", "/api/admin/model-connections", owner, { ...payload, billing_basis: "javascript:alert(1)" })).statusCode, 400);
  const created = await request("POST", "/api/admin/model-connections", owner, payload);
  assert.equal(created.statusCode, 200, created.body);
  const row = ModelConnectionRecord.parse(created.json());
  assert.doesNotMatch(created.body, /synthetic-no-production-key|sealed_secret|ciphertext/);
  const listing = await request("GET", "/api/admin/model-connections", manager);
  assert.equal(listing.statusCode, 200, listing.body);
  assert.equal(ModelRegistryResponse.parse(listing.json()).connections.length, 1);
  const { secret: _secret, owner_confirmed: _confirm, supplier_basis: _basis, ...edit } = payload;
  const updated = await request("PUT", `/api/admin/model-connections/${row.id}`, manager, {
    ...edit,
    name: "Edited metadata",
    expected_revision: row.revision,
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().revision, 2);
  assert.equal((await request("PUT", `/api/admin/model-connections/${row.id}`, manager, { ...edit, expected_revision: row.revision })).statusCode, 409);
  assert.equal(
    (
      await request("POST", `/api/admin/model-routes/policy_fulltext`, manager, {
        model: row.key,
        expected_revision: 0,
        reason: "must reject untested",
        evaluation_id: null,
        emergency_confirmed: true,
      })
    ).statusCode,
    409,
  );
  assert.equal((await request("GET", "/api/admin/model-connection-tests/00000000-0000-4000-8000-000000000000", manager)).statusCode, 409);
  await dbs.auth`UPDATE identity.account_access SET models_manage=false,revision=revision+1 WHERE user_id=${manager.id}`;
  assert.equal((await request("POST", `/api/admin/model-connections/${row.id}/test`, manager, { expected_revision: 2, lane: "news" })).statusCode, 403);
  assert.equal(
    (await request("POST", `/api/admin/model-connections/${row.id}/disable`, owner, { expected_revision: 2, reason: "isolation complete" })).statusCode,
    200,
  );
  assert.equal(Number((await f.admin`SELECT count(*) FROM receipt_attempts WHERE service=${row.key}`)[0].count), 0, "HTTP operations never call the model");
});
