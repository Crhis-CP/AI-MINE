import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { buildApp } from "../apps/api/src/app.ts";
import { config } from "@amp/backend/config";
import { closeDb, dbOf } from "@amp/backend/db";
import { getBoss, stopBoss } from "@amp/backend/jobs/queue";
import { paidRequest, ReceiptUnknownError } from "@amp/backend/providers/receipts";
import { createPrivateClient, privateSchemas } from "../packages/api-client/src/private.ts";

test("observed receipt versions preserve guard order and reject an old UI form before any second release", async () => {
  const sql = dbOf("ai-gateway"),
    saved = { host: config.privateHost, admin: config.devAdmin };
  config.privateHost = "private.receipt.test";
  config.devAdmin = { displayName: "Receipt contract fixture" };
  const app = await buildApp("private-api");
  let hits = 0;
  const provider = createServer((_req, res) => {
    hits++;
    if (hits < 3) return res.destroy();
    res.end(JSON.stringify({ ok: true }));
  });
  const headers = { "x-forwarded-host": "private.receipt.test", "x-csrf-token": "dev" };
  const request = { service: "fixture-client-version", purpose: "invariant_test", subject: `observed-${process.pid}`, identity: { pid: process.pid } };
  try {
    await getBoss();
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const call = async () => ({ response: await (await fetch(`http://127.0.0.1:${(provider.address() as { port: number }).port}`)).json() });
    await assert.rejects(paidRequest(request, call));
    const read = async () => {
      const response = await app.inject({ url: "/api/admin/runs", headers });
      assert.equal(response.statusCode, 200, response.body);
      const body = privateSchemas.ReceiptReconciliationResponse.parse(response.json());
      const row = body.receipts.issues.find((item) => item.subject === request.subject)!;
      assert.ok(row);
      assert.equal("version_id" in row || "version_time" in row, false);
      return row;
    };
    const old = await read();
    const url = `/api/admin/receipts/${old.id}/release`;
    const body = { billed: false, note: "provider evidence only for attempt1", version: old.version };
    const post = (payload: object, requestHeaders = headers) => app.inject({ method: "POST", url, headers: requestHeaders, payload });
    assert.equal((await post({}, { ...headers, "x-forwarded-host": "wrong.test" })).statusCode, 404);
    config.devAdmin = null;
    assert.equal((await post({})).statusCode, 401);
    config.devAdmin = { displayName: "Receipt contract fixture" };
    assert.equal((await post({}, { ...headers, "x-csrf-token": "wrong" })).statusCode, 403);
    const fixture = JSON.parse(readFileSync(new URL("../scripts/verify/tests/fixtures/receipt-observation.json", import.meta.url), "utf8"));
    for (const invalid of fixture.invalidBodies) assert.equal((await post(invalid.body)).statusCode, 400, invalid.name);
    for (const payload of [
      { ...body, billed: true },
      { ...body, version: `rv1:${"0".repeat(64)}` },
    ])
      assert.equal((await post(payload)).statusCode, 409);
    const auditCount = async () => (await sql`SELECT count(*)::int AS n FROM audit_log WHERE subject=${`receipt:${old.id}`}`)[0].n;
    const jobs = async () => (await sql`SELECT count(*)::int AS n FROM pgboss.job`)[0].n;
    assert.equal(await auditCount(), 0);
    assert.equal(hits, 1);
    assert.equal((await read()).status, "unknown");
    const beforeJobs = await jobs();
    assert.equal((await post(body)).statusCode, 200);
    await assert.rejects(paidRequest(request, call));
    const current = await read();
    assert.equal(current.attempts, 2);
    assert.equal(current.status, "unknown");
    assert.notEqual(current.version, old.version);
    const stale = await post(body);
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().code, "conflict");
    assert.equal(await auditCount(), 1);
    assert.equal(await jobs(), beforeJobs);
    assert.equal((await read()).status, "unknown");
    await assert.rejects(paidRequest(request, call), ReceiptUnknownError);
    assert.equal(hits, 2);
    // A separately reviewed current version permits one attempt; the received response is then reused.
    const fresh = await post({ ...body, version: current.version, note: "new provider evidence for attempt2" });
    assert.equal(fresh.statusCode, 200);
    privateSchemas.ReceiptReleaseResponse.parse(fresh.json());
    assert.equal((await paidRequest(request, call)).reused, false);
    assert.equal((await paidRequest(request, call)).reused, true);
    assert.equal(hits, 3);
    const client = createPrivateClient({
      baseUrl: "http://private.test",
      fetch: async (req) => {
        const response = await app.inject({
          method: req.method as "GET" | "POST",
          url: new URL(req.url).pathname,
          headers: Object.fromEntries(req.headers),
          payload: req.method === "POST" ? await req.text() : undefined,
        });
        return new Response(response.body, { status: response.statusCode, headers: { "content-type": String(response.headers["content-type"]) } });
      },
    });
    const replay = await client.POST("/api/admin/receipts/{id}/release", { params: { path: { id: String(old.id) } }, headers, body });
    assert.equal(replay.response.status, 409);
    assert.equal(replay.error?.code, "conflict");
  } finally {
    await app.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await stopBoss();
    await closeDb();
    config.privateHost = saved.host;
    config.devAdmin = saved.admin;
  }
});
