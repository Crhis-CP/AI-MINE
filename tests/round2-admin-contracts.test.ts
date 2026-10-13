import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../apps/api/src/app.ts";
import { dbOf, closeDb } from "@amp/backend/db";
import { config } from "@amp/backend/config";
import { SESSION_COOKIE } from "@amp/backend/admin/auth";
import { sha256 } from "@amp/backend/lib/ids";
import { stopBoss } from "@amp/backend/jobs/queue";
const sql = dbOf("ops");
after(async () => {
  await stopBoss();
  await closeDb();
});

test("real Owner archive and private withdrawal commands retain authentication, CSRF, schemas and snapshot CAS", async () => {
  const old = { host: config.privateHost, dev: config.devAdmin };
  config.privateHost = "round2.private.test";
  config.devAdmin = null;
  const app = await buildApp("private-api");
  try {
    const [user] = await sql`INSERT INTO admin_users(email,display_name) VALUES('round2-owner@synthetic.test','Synthetic Owner') RETURNING id`;
    await sql`INSERT INTO identity.account_access(user_id,role) VALUES(${user.id},'owner')`;
    const token = "synthetic-round2-http-session",
      csrf = "synthetic-round2-csrf";
    await sql`INSERT INTO admin_sessions(id_hash,user_id,csrf_token,expires_at) VALUES(${sha256(token)},${user.id},${csrf},now()+interval '1 hour')`;
    const base = { "x-forwarded-host": config.privateHost };
    const headers = { ...base, cookie: `${SESSION_COOKIE}=${token}`, "x-csrf-token": csrf };
    await sql`INSERT INTO audit_log(actor,action,subject) VALUES('typing-fixture','typing.test','typing-one')`;
    const audit = await app.inject({ url: "/api/admin/audit?subject=typing-one&action=typing&page=1", headers });
    assert.equal(audit.statusCode, 200, audit.body);
    assert.equal(audit.json().rows.length, 1);
    for (const query of ["subject=one&subject=two", "action=one&action=two", "page=object"])
      assert.equal((await app.inject({ url: `/api/admin/audit?${query}`, headers })).statusCode, 400, query);

    const [source] = await sql`INSERT INTO sources(id,name,kind,config,enabled) VALUES('round2-http-source','Synthetic Archive','rss','{}',true) RETURNING *`;
    const archive = { version: source.updated_at.toISOString(), reason: "Synthetic archive", high_risk_confirmed: true };
    const url = "/api/admin/sources/round2-http-source/archive";
    assert.equal((await app.inject({ method: "POST", url, headers: base, payload: archive })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url, headers: { ...base, cookie: headers.cookie }, payload: archive })).statusCode, 403);
    const done = await app.inject({ method: "POST", url, headers, payload: archive });
    assert.equal(done.statusCode, 200, done.body);
    assert.equal(done.json().source.enabled, false);
    assert.ok(done.json().source.archived_at);
    const listed = await app.inject({ url: "/api/admin/sources?q=round2-http-source&archived=true", headers });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.ok(listed.json().rows.some((row: { id: string }) => row.id === "round2-http-source"));
    const restore = await app.inject({
      method: "PATCH",
      url: "/api/admin/sources/round2-http-source",
      headers,
      payload: { patch: { enabled: true }, version: done.json().source.updated_at },
    });
    assert.equal(restore.statusCode, 409, restore.body);
    await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at) VALUES('daily','2026-10-11','2026-10-10T00:00:00Z','2026-10-11T00:00:00Z','{"sections":[],"flashes":[]}',now())`;
    const target = { type: "report", lane: "news", kind: "daily", key: "2026-10-11" };
    const preview = await app.inject({ method: "POST", url: "/api/admin/withdrawals/preview", headers, payload: { target } });
    assert.equal(preview.statusCode, 200, preview.body);
    const action = { target, action: "withdraw", reason: "Synthetic hold", expectedSnapshotHash: preview.json().snapshotHash };
    const held = await app.inject({ method: "POST", url: "/api/admin/withdrawals/actions", headers, payload: action });
    assert.equal(held.statusCode, 200, held.body);
    assert.equal(typeof held.json().withdrawalId, "number");
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/withdrawals/actions", headers, payload: action })).statusCode, 409);
    const current = await app.inject({ method: "POST", url: "/api/admin/withdrawals/preview", headers, payload: { target } });
    const released = await app.inject({
      method: "POST",
      url: "/api/admin/withdrawals/actions",
      headers,
      payload: {
        target,
        action: "restore",
        reason: "Synthetic restore",
        expectedSnapshotHash: current.json().snapshotHash,
        withdrawalId: held.json().withdrawalId,
      },
    });
    assert.equal(released.statusCode, 200, released.body);
    assert.equal((await sql`SELECT active FROM publication.withdrawal_targets WHERE withdrawal_id=${held.json().withdrawalId}`)[0].active, false);
    assert.equal(
      (await app.inject({ method: "POST", url: "/api/admin/withdrawals/preview", headers, payload: { target: { ...target, lane: "policy" } } })).statusCode,
      400,
    );
  } finally {
    await app.close();
    config.privateHost = old.host;
    config.devAdmin = old.dev;
  }
});
