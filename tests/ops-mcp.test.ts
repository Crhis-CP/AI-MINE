import assert from "node:assert/strict";
import { test } from "node:test";
import { publicRoleFixture, publicServer } from "./public-role-fixture.ts";
import { denied } from "./role-db-fixture.ts";
import { injectDb, initializeDb, closeDb, DB_MODULES } from "@amp/backend/db";
import { SESSION_COOKIE } from "@amp/backend/admin/auth";
import { sha256 } from "@amp/backend/lib/ids";
import { config } from "@amp/backend/config";
import { refreshOperationalSnapshots } from "../packages/backend/src/operations/operational-snapshots.ts";
import { storeOperationalSnapshot, recordOperationalSnapshotFailure } from "../packages/backend/src/operations/read-snapshots.ts";
import { buildApp } from "../apps/api/src/app.ts";
import { webHostPolicy } from "../apps/web/host-policy.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
function rpc(text: string) {
  if (text.startsWith("{")) return JSON.parse(text);
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  assert.ok(line, text.slice(0, 200));
  return JSON.parse(line.slice(5));
}

test("worker snapshots and real observer login expose bounded metadata only; Owner, CSRF and private network boundary are enforced", async (t) => {
  const f = await publicRoleFixture(t),
    sessions = await f.login();
  await f.run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {initializeDb,closeDb} from '@amp/backend/db';import {ensureQueue,enqueue,stopBoss} from '@amp/backend/jobs/queue';await initializeDb('worker');await ensureQueue('news.observer-fixture');await enqueue('news.observer-fixture',{private_text:'DO_NOT_EXPORT_QUEUE_PAYLOAD'});await stopBoss();await closeDb();`,
    ],
    { DATABASE_URL_WORKER: f.urlFor("worker"), DATABASE_URL_BACKUP: f.urlFor("backup") },
  );
  const restore = injectDb(Object.fromEntries(DB_MODULES.map((name) => [name, sessions.worker])));
  const states = await refreshOperationalSnapshots();
  assert.ok(
    states.every((x) => x.state === "sampled"),
    JSON.stringify(states),
  );
  await assert.rejects(storeOperationalSnapshot("health", [{ component: "worker", last_recorded_at: null, secret: "NO_EXPORT" }]));
  const sampled = new Date(Date.now() - 10 * 60_000);
  await storeOperationalSnapshot("health", [{ component: "worker", last_recorded_at: sampled.toISOString() }], sampled);
  await recordOperationalSnapshotFailure("health");
  restore();
  await denied(sessions.ops_read, "SELECT * FROM receipts");
  await denied(sessions.ops_read, "SELECT * FROM admin_users");
  await denied(sessions.ops_read, "UPDATE ops.operational_snapshots SET payload='[]'");
  await denied(sessions.ops_read, "CREATE TABLE public.observer_write(value text)");
  await denied(sessions.public_read, "SELECT * FROM ops.operational_snapshots");
  assert.ok((await sessions.ops_read`SELECT dataset FROM ops.operational_snapshots`).length >= 10);
  const users: Record<string, { id: number; headers: Record<string, string> }> = {};
  for (const name of ["owner", "admin"]) {
    const [u] = await sessions.auth`INSERT INTO admin_users(email,display_name) VALUES(${`${name}@private.invalid`},${`PERSONAL_NAME_${name}`}) RETURNING id`;
    await sessions.auth`INSERT INTO identity.account_access(user_id,role) VALUES(${u.id},${name})`;
    const token = `ops-test-${name}`;
    await sessions.auth`INSERT INTO admin_sessions(id_hash,user_id,csrf_token,expires_at) VALUES(${sha256(token)},${u.id},'synthetic-csrf',now()+interval '1 hour')`;
    users[name] = {
      id: Number(u.id),
      headers: {
        cookie: `${SESSION_COOKIE}=${token}`,
        "x-csrf-token": "synthetic-csrf",
        ...(config.privateHost ? { "x-forwarded-host": config.privateHost } : {}),
      },
    };
  }
  await initializeDb("private-api", {
    DATABASE_URL_PRIVATE_OPS: f.urlFor("private_ops"),
    DATABASE_URL_AUTH: f.urlFor("auth"),
    DATABASE_URL_OPS_READ: f.urlFor("ops_read"),
    DATABASE_POOL_MAX: "1",
  });
  t.after(closeDb);
  const app = await buildApp("private-api");
  t.after(() => app.close());
  const call = (who = "owner", args: unknown = { dataset: "health" }, extra: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url: "/mcp-ops",
      headers: { ...users[who]!.headers, accept: "application/json, text/event-stream", ...extra },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_operations", arguments: args } },
    });
  assert.equal((await call("admin")).statusCode, 403);
  assert.equal((await call("owner", undefined, { "x-csrf-token": "wrong" })).statusCode, 403);
  const protection = await call("owner", { dataset: "protection" });
  assert.ok(rpc(protection.body).result.structuredContent.items.some((x: { state: string }) => x.state === "needs_configuration"));
  const before = Number((await f.admin`SELECT count(*) FROM receipt_attempts`)[0].count);
  const health = await call();
  assert.equal(health.statusCode, 200, health.body);
  const result = rpc(health.body).result.structuredContent;
  assert.equal(result.state, "stale");
  assert.equal(result.sampled_at, sampled.toISOString());
  assert.equal(result.items.length, 1);
  assert.ok(result.excludes.includes("个人信息与账号标识"));
  const queued = await call("owner", { dataset: "queues" });
  assert.doesNotMatch(queued.body, /DO_NOT_EXPORT_QUEUE_PAYLOAD/);
  assert.ok(rpc(queued.body).result.structuredContent.items.some((x: { name: string }) => x.name === "news.observer-fixture"));
  assert.equal(health.headers["cache-control"], "private, no-store");
  const malformed = rpc((await call("owner", { dataset: "health", sql: "SELECT * FROM secrets" })).body);
  assert.ok(malformed.error || malformed.result?.isError);
  const audit = await call("owner", { dataset: "audit", limit: 1 });
  assert.doesNotMatch(audit.body, /PERSONAL_NAME_|private.invalid|synthetic-csrf|NO_EXPORT/);
  assert.equal(Number((await f.admin`SELECT count(*) FROM receipt_attempts`)[0].count), before);
  assert.ok(Number((await f.admin`SELECT count(*) FROM audit_log WHERE action='ops_mcp.read'`)[0].count) >= 2);
  await sessions.auth`UPDATE identity.account_access SET active=false,revision=revision+1 WHERE user_id=${users.admin!.id}`;
  assert.equal((await call("admin")).statusCode, 401);
  // Public process never registers the route, even if given a valid private cookie.
  const pub = await publicServer(t, f);
  assert.equal((await pub.request("/mcp-ops", { method: "POST", headers: users.owner!.headers })).status, 404);
  await app.close();
  await closeDb();
  // Existing private controls remain usable with the observer address absent; this feature fails closed.
  await initializeDb("private-api", { DATABASE_URL_PRIVATE_OPS: f.urlFor("private_ops"), DATABASE_URL_AUTH: f.urlFor("auth"), DATABASE_POOL_MAX: "1" });
  const absent = await buildApp("private-api");
  t.after(() => absent.close());
  const unavailable = await absent.inject({
    method: "POST",
    url: "/mcp-ops",
    headers: { ...users.owner!.headers, accept: "application/json, text/event-stream" },
    payload: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_operations", arguments: { dataset: "health" } } },
  });
  assert.equal(rpc(unavailable.body).result.isError, true);
  assert.doesNotMatch(unavailable.body, /postgres|DATABASE_URL|private.invalid/);
});

test("the web entry rejects the observer path on every hostname including normalized path variants", () => {
  for (const host of ["site.example", "admin.example", "other.example"])
    for (const pathname of ["/mcp-ops", "/MCP-OPS", "/mcp-ops/", "/%6dcp-ops", "/x/../mcp-ops", "/mcp-ops.data"]) {
      let status = 0,
        ended = false;
      const req = { url: pathname, headers: { host }, rawHeaders: ["Host", host] } as IncomingMessage;
      const res = {
        writeHead(code: number) {
          status = code;
          return this;
        },
        end() {
          ended = true;
        },
      } as unknown as ServerResponse;
      assert.equal(webHostPolicy({ SITE_URL: "https://site.example", PRIVATE_HOST: "admin.example" })(req, res), null);
      assert.equal(status, 404);
      assert.equal(ended, true);
    }
});
