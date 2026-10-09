import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { UsageProtectionOverview, UsageBreaker } from "@amp/contracts/http/private";
import defaults from "../industry/usage-controls.json" with { type: "json" };
import { roleFixture } from "./role-db-fixture.ts";
import { provisionRoles } from "../scripts/db-roles.ts";
import { apiProcess } from "./api-process.ts";

test("real private roles expose read-only usage to administrators and Owner-only CAS price/configuration/recovery", async (t) => {
  const f = await roleFixture(t);
  await provisionRoles(f.admin, { prefix: f.prefix, publicConnections: 2, apply: true });
  const logins = await f.login();
  await Promise.all(Object.values(logins).map((db) => db.end()));
  const users: Record<string, number> = {};
  for (const role of ["owner", "admin"]) {
    const [user] = await f.admin`INSERT INTO admin_users(email,display_name) VALUES(${`usage-http-${role}@synthetic.invalid`},${role}) RETURNING id`;
    users[role] = user!.id;
    await f.admin`INSERT INTO identity.account_access(user_id,role,must_change_password) VALUES(${user!.id},${role},false)`;
    await f.admin`INSERT INTO admin_sessions(id_hash,user_id,csrf_token,expires_at) VALUES(${createHash("sha256").update(`usage-http-${role}`).digest("hex")},${user!.id},'synthetic-csrf',now()+interval '1 hour')`;
  }
  const server = await apiProcess(t, {
    ...f.env,
    NODE_ENV: "production",
    API_ROLE: "private-api",
    PRIVATE_HOST: "usage.synthetic.invalid",
    SITE_URL: "https://usage.synthetic.invalid",
    DATABASE_URL_PRIVATE_OPS: f.urlFor("private_ops"),
    DATABASE_URL_AUTH: f.urlFor("auth"),
    ADMIN_PASSWORD: "synthetic-password-never-used",
    SESSION_SECRET: "synthetic-usage-http-0123456789",
    PUBLIC_RATE_LIMIT_SECRET: "synthetic-usage-http-rate-0123456789",
  });
  await server.ready();
  const request = (path: string, role = "owner", body?: unknown, method = body ? "PUT" : "GET", csrf = true) =>
    fetch(server.url + path, {
      method,
      headers: {
        "x-forwarded-host": "usage.synthetic.invalid",
        cookie: `amp_admin=usage-http-${role}`,
        ...(body ? { "content-type": "application/json", ...(csrf ? { "x-csrf-token": "synthetic-csrf" } : {}) } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const overview = await request("/api/admin/usage-protection", "admin");
  assert.equal(overview.status, 200, await overview.clone().text());
  assert.equal(UsageProtectionOverview.parse(await overview.json()).can_manage, false);
  const change = { expected_version: 0, config: defaults, reason: "synthetic initial protection", high_risk_confirmed: true };
  assert.equal((await request("/api/admin/usage-config", "admin", change)).status, 403);
  assert.equal((await request("/api/admin/usage-config", "owner", change, "PUT", false)).status, 403);
  const initial = await request("/api/admin/usage-config", "owner", change);
  assert.equal(initial.status, 200, await initial.clone().text());
  assert.equal((await request("/api/admin/usage-config", "owner", change)).status, 409);
  const now = new Date().toISOString().slice(0, 10),
    price = {
      expected_version: 0,
      reason: "synthetic effective evidence",
      high_risk_confirmed: true,
      price: {
        service: "synthetic-http",
        model: "",
        configuration_hash: null,
        currency: "CNY",
        input_per_million_micros: null,
        output_per_million_micros: null,
        per_request_micros: "10000",
        max_request_micros: null,
        image_input_token_bound: null,
        protocol_input_token_allowance: 0,
        basis_url: "https://pricing.synthetic.invalid/rules?v=1#rates",
        observed_on: now,
        valid_until: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      },
    };
  assert.equal((await request("/api/admin/usage-prices", "owner", { ...price, price: { ...price.price, basis_url: "javascript:alert(1)" } })).status, 400);
  const installed = await request("/api/admin/usage-prices", "owner", price);
  assert.equal(installed.status, 200, await installed.clone().text());
  assert.equal((await request("/api/admin/usage-prices", "owner", price)).status, 409);
  const scope = { lane: "news", kind: "capability", capability: "synthetic", source_id: null, object_kind: null, object_id: null };
  await f.admin`INSERT INTO ai.usage_breakers(id,scope_key,scope,trigger,state,window_key,config_version,current,threshold,opened_at,receipt_ids) VALUES('http-breaker','http-scope',${f.admin.json(scope)},'repeated_input','open','synthetic',1,'{"repeats":"3"}','{"limit":"3","warning":"2"}',now(),'{}')`;
  const recovery = await request("/api/admin/breakers/http-breaker/recover", "owner", { expected_revision: 1, reason: "synthetic diagnosis complete" }, "POST");
  assert.equal(recovery.status, 200, await recovery.clone().text());
  assert.equal(UsageBreaker.parse(await recovery.json()).state, "recovered");
  await f.admin`UPDATE identity.account_access SET role='admin',revision=revision+1 WHERE user_id=${users.owner!}`;
  assert.equal((await request("/api/admin/usage-config", "owner", { ...change, expected_version: 1 })).status, 403);
  assert.equal(Number((await f.admin`SELECT count(*) AS n FROM receipt_attempts`)[0]!.n), 0);
});
