import assert from "node:assert/strict";
import { test } from "node:test";
import { installTestConnections } from "./direct-db-fixture.ts";
import { publicRoleFixture } from "./public-role-fixture.ts";
import { buildApp } from "./site-app.ts";
import { sha256 } from "@amp/backend/lib/ids";
import { SESSION_COOKIE, sessionPrincipal, AccountPermissionDenied } from "@amp/backend/admin/auth";
import { updateBudget } from "@amp/backend/admin/settings";
import { config } from "@amp/backend/config";
import { stopBoss } from "@amp/backend/jobs/queue";

test("ordinary administrators cannot change Owner source, notification or request-limit settings", async (t) => {
  const f = await publicRoleFixture(t),
    dbs = await f.login();
  t.after(installTestConnections(dbs.private_ops, dbs.auth));
  t.after(stopBoss);
  async function account(name: string, role: "admin" | "owner") {
    const [user] = await dbs.auth`INSERT INTO admin_users(email,display_name) VALUES(${`${name}@synthetic.invalid`},${name}) RETURNING id`;
    await dbs.auth`INSERT INTO identity.account_access(user_id,role,models_manage) VALUES(${user.id},${role},true)`;
    const token = `settings-${name}`;
    await dbs.auth`INSERT INTO admin_sessions(id_hash,user_id,csrf_token,expires_at) VALUES(${sha256(token)},${user.id},'synthetic-csrf',now()+interval '1 hour')`;
    return {
      cookie: `${SESSION_COOKIE}=${token}`,
      "x-csrf-token": "synthetic-csrf",
      ...(config.privateHost ? { "x-forwarded-host": config.privateHost } : {}),
    };
  }
  const admin = await account("operator", "admin"),
    owner = await account("owner", "owner"),
    app = await buildApp("api");
  t.after(() => app.close());
  await f.admin`INSERT INTO sources(id,name,kind,enabled) VALUES('owner-settings-source','Synthetic source','rss',true)`;
  await f.admin`INSERT INTO notify_targets(key,purpose,kind,enabled) VALUES('owner-settings-alert','alert','log',true)`;
  const [source] = await f.admin`SELECT updated_at FROM sources WHERE id='owner-settings-source'`;
  const actions = [
    {
      method: "POST" as const,
      url: "/api/admin/sources",
      payload: {
        id: "owner-settings-new",
        name: "Synthetic new source",
        kind: "rss",
        config: { feedUrl: "https://fixture.invalid/feed" },
        permission_scope: { hosts: ["fixture.invalid"], path_prefixes: ["/"], document_types: [], excluded_content: [] },
        attachments_in_scope: false,
      },
    },
    {
      method: "PATCH" as const,
      url: "/api/admin/sources/owner-settings-source",
      payload: { patch: { enabled: false }, version: source.updated_at.toISOString(), reason: "Synthetic change" },
    },
    { method: "POST" as const, url: "/api/admin/notify-targets/owner-settings-alert", payload: { enabled: false, reason: "Synthetic change" } },
    { method: "PUT" as const, url: "/api/admin/budgets/owner-settings-service", payload: { perMinute: 1, perHour: 2, perDay: 3, reason: "Synthetic change" } },
  ];
  for (const action of actions) assert.equal((await app.inject({ ...action, headers: admin })).statusCode, 403, `${action.method} ${action.url}`);
  for (const url of ["/api/admin/sources/preview", "/api/admin/sources/owner-settings-source/preview", "/api/admin/sources/owner-settings-source/fetch"])
    assert.equal((await app.inject({ method: "POST", url, headers: admin, payload: { id: "owner-settings-source" } })).statusCode, 403, url);
  assert.equal((await f.admin`SELECT enabled FROM sources WHERE id='owner-settings-source'`)[0].enabled, true);
  assert.equal((await f.admin`SELECT enabled FROM notify_targets WHERE key='owner-settings-alert'`)[0].enabled, true);
  assert.equal((await f.admin`SELECT 1 FROM sources WHERE id='owner-settings-new'`).length, 0);
  assert.equal((await f.admin`SELECT 1 FROM budgets WHERE service='owner-settings-service'`).length, 0);
  assert.equal((await app.inject({ method: "GET", url: "/api/admin/settings", headers: admin })).statusCode, 200);
  await f.admin`INSERT INTO audit_log(actor,action,subject,reason,"after") VALUES('owner','synthetic.owner-only','private-audit','fixture','{"marker":"OWNER_AUDIT_ONLY"}')`;
  assert.equal((await app.inject({ method: "GET", url: "/api/admin/audit?action=synthetic.owner-only", headers: admin })).statusCode, 403);
  const auditResponse = await app.inject({ method: "GET", url: "/api/admin/audit?action=synthetic.owner-only", headers: owner });
  assert.equal(auditResponse.statusCode, 200);
  assert.match(auditResponse.body, /OWNER_AUDIT_ONLY/);
  const [unknown] =
    await f.admin`INSERT INTO receipts(logical_key,service,purpose,status,attempts) VALUES('synthetic-owner-unknown','fixture','fixture','unknown',1) RETURNING id`;
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/admin/receipts/${unknown.id}/release`,
        headers: admin,
        payload: { billed: false, note: "Synthetic provider observation", version: `rv1:${"a".repeat(64)}` },
      })
    ).statusCode,
    403,
  );
  assert.equal((await f.admin`SELECT status FROM receipts WHERE id=${unknown.id}`)[0].status, "unknown");
  for (const headers of [admin, owner])
    assert.equal(
      (await app.inject({ method: "POST", url: "/api/admin/processing/requeue", headers, payload: { group: null, reason: "Synthetic bulk" } })).statusCode,
      403,
    );
  for (const action of actions) assert.equal((await app.inject({ ...action, headers: owner })).statusCode, 200, `${action.method} ${action.url}`);
  const principal = await sessionPrincipal(owner.cookie);
  assert.ok(principal);
  await dbs.auth`UPDATE identity.account_access SET revision=revision+1 WHERE user_id=${principal.userId}`;
  await assert.rejects(
    updateBudget("owner-settings-service", { perMinute: 9, perHour: 9, perDay: 9, reason: "Stale owner session" }, "synthetic-owner", principal),
    AccountPermissionDenied,
  );
  assert.equal((await f.admin`SELECT per_day FROM budgets WHERE service='owner-settings-service'`)[0].per_day, 3);
});
