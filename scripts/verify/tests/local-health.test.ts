import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { healthFailureEvidence, type LocalHealthFailure, readLocalHealth } from "../../../deploy/local-health.ts";

const release = "a".repeat(40);
async function serve(t: TestContext, handler: http.RequestListener) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `127.0.0.1:${address.port}`;
}
const fast = { attempts: 1, intervalMs: 0 };

test("only the registered endpoint's direct valid 200 establishes health", async (t) => {
  const address = await serve(t, (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, db: "ok", release }));
  });
  assert.deepEqual(await readLocalHealth(async () => address, release, fast), { target: `http://${address}/api/health`, status: 200, direct: true });
  await assert.rejects(
    readLocalHealth(async () => address, "other", fast),
    (error: LocalHealthFailure) => error.failure.reason === "invalid_response",
  );
});

test("503 is recorded as actual direct HTTP, while a failed endpoint command makes no request", async (t) => {
  let requests = 0;
  const address = await serve(t, (_req, res) => {
    requests++;
    res.writeHead(503);
    res.end();
  });
  await assert.rejects(
    readLocalHealth(
      async () => {
        throw new Error("port command exit 17");
      },
      release,
      fast,
    ),
    (error: LocalHealthFailure) => {
      assert.deepEqual(error.failure, { reason: "endpoint_lookup", observation: null });
      return true;
    },
  );
  assert.equal(requests, 0);
  await assert.rejects(
    readLocalHealth(async () => address, release, fast),
    (error: LocalHealthFailure) => {
      assert.deepEqual(error.failure, { reason: "http_status", observation: { target: `http://${address}/api/health`, status: 503, direct: true } });
      return true;
    },
  );
  assert.equal(requests, 1);
});

test("302 never follows Location to a second loopback origin", async (t) => {
  let escaped = 0;
  const other = await serve(t, (_req, res) => {
    escaped++;
    res.end(JSON.stringify({ ok: true, db: "ok", release }));
  });
  const address = await serve(t, (_req, res) => {
    res.writeHead(302, { location: `http://${other}/api/health` });
    res.end();
  });
  await assert.rejects(
    readLocalHealth(async () => address, release, fast),
    (error: LocalHealthFailure) => error.failure.reason === "redirect" && error.failure.observation?.status === 302,
  );
  assert.equal(escaped, 0);
});

test("health evidence rejects invalid targets and projects no raw response or command data", () => {
  const observation = { target: "http://127.0.0.1:1234/api/health", status: 503, direct: true };
  assert.deepEqual(healthFailureEvidence({ reason: "http_status", observation: { ...observation, raw: "not-projected" }, environment: "not-projected" }), {
    reason: "http_status",
    observation,
  });
  for (const value of [
    null,
    {},
    { reason: "other", observation },
    { reason: "http_status", observation: { ...observation, target: "http://other.invalid/api/health" } },
  ])
    assert.equal(healthFailureEvidence(value), null);
});
