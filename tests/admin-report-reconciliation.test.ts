import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@amp/backend/db";
import { config } from "@amp/backend/config";
import { buildApp } from "./site-app.ts";
import { sourceOwnerHeaders } from "./source-owner-fixture.ts";
import { sessionPrincipal, AccountPermissionDenied } from "@amp/backend/admin/auth";
import { requestManagedReport } from "@amp/backend/reports/compose";

config.devAdmin = null;
const app = await buildApp("api"),
  headers = await sourceOwnerHeaders();
after(async () => {
  await app.close();
  await closeDb();
});
test("report management reads without side effects and persists exactly one version-bound command", async () => {
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at,first_published_at,origin)
    VALUES('daily','2020-10-01','2020-09-30','2020-10-01','{}',now(),now(),'rule')`;
  const read = await app.inject({ method: "GET", url: "/api/admin/reports?kind=daily&limit=1", headers });
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json().items[0].revision, 1);
  assert.equal((await sql`SELECT 1 FROM reports.reconciliation_jobs`).length, 0, "GET never queues a repair");
  const command = {
    method: "POST" as const,
    url: "/api/admin/reports/daily/2020-10-01/reconcile",
    headers: { ...headers, "idempotency-key": "synthetic-report-command" },
    payload: { expectedRevision: 1, reason: "核对合成晚到材料" },
  };
  assert.equal((await app.inject({ ...command, headers: { ...command.headers, "x-csrf-token": "wrong" } })).statusCode, 403);
  const first = await app.inject(command);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().status, "queued");
  const [scheduled] = await sql`SELECT next_attempt_at FROM reports.reconciliation_jobs WHERE kind='daily' AND key='2020-10-01'`;
  assert.ok(scheduled.next_attempt_at.getTime() > Date.now() - 5000, "a newly requested historical check is scheduled now, not years in the past");
  assert.deepEqual((await app.inject(command)).json(), first.json());
  assert.equal(Number((await sql`SELECT generation FROM reports.reconciliation_jobs`)[0].generation), 1);
  assert.equal((await sql`SELECT 1 FROM reports.reconciliation_commands`).length, 1);
  const next = await app.inject({ ...command, headers: { ...headers, "idempotency-key": "synthetic-another-command" } });
  assert.equal(next.json().status, "already_pending");
  assert.equal(
    (
      await app.inject({
        ...command,
        headers: { ...headers, "idempotency-key": "synthetic-stale-command" },
        payload: { ...command.payload, expectedRevision: 0 },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await app.inject({
        ...command,
        url: "/api/admin/reports/daily/1999-01-01/reconcile",
        payload: { ...command.payload, expectedRevision: 0 },
        headers: { ...headers, "idempotency-key": "synthetic-missing-command" },
      })
    ).statusCode,
    404,
  );
  await sql`UPDATE reports SET origin='manual' WHERE key='2020-10-01'`;
  const manual = await app.inject({ ...command, headers: { ...headers, "idempotency-key": "synthetic-manual-command" } });
  assert.equal(manual.json().status, "preserved_manual");
  assert.equal((await sql`SELECT revision FROM reports WHERE key='2020-10-01'`)[0].revision, 1);
  const principal = (await sessionPrincipal(headers.cookie))!;
  await sql`UPDATE identity.account_access SET revision=revision+1 WHERE user_id=${principal.userId}`;
  await assert.rejects(
    requestManagedReport({ kind: "daily", key: "2020-10-01" }, command.payload, principal, "synthetic-revoked-command"),
    AccountPermissionDenied,
  );
});
