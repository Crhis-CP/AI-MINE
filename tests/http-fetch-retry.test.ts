import "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@amp/backend/config";
import { DROPPED_RETRY, droppedConnection, guardedFetch } from "@amp/backend/lib/http-fetch";
import { failureMessage } from "@amp/backend/sources/collect";

const hits = new Map<string, number>();
const requests: http.IncomingHttpHeaders[] = [];
const fullBody = "x".repeat(100);
const server = http.createServer((req, res) => {
  const path = req.url!;
  const hit = (hits.get(path) ?? 0) + 1;
  hits.set(path, hit);
  if (path === "/recover") requests.push(req.headers);
  if (path === "/timeout") return;
  if (path.startsWith("/body") && hit === 1) {
    const errorStatus = /^\/body-(503|412)$/.exec(path)?.[1];
    res.writeHead(errorStatus ? Number(errorStatus) : 200, { "content-length": 100, "retry-after": "3600" });
    res.write(fullBody.slice(0, 10), () => req.socket.destroy());
    return;
  }
  if (path === "/always" || path === "/post" || ((path === "/recover" || path === "/no-retry" || path === "/budget") && hit === 1)) {
    req.socket.destroy();
    return;
  }
  res.writeHead(path === "/500" ? 500 : path === "/412" ? 412 : 200);
  res.end(fullBody);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const previousPrivate = config.allowPrivateNetworkFetch;
const previousDelay = DROPPED_RETRY.afterMs;
config.allowPrivateNetworkFetch = true;
DROPPED_RETRY.afterMs = 2;
after(async () => {
  config.allowPrivateNetworkFetch = previousPrivate;
  DROPPED_RETRY.afterMs = previousDelay;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("an opted-in GET repeats the same request after a dropped connection", async () => {
  const response = await guardedFetch(`${base}/recover`, { method: "get", headers: { "x-test": "same-request" }, retryDropped: true });
  assert.equal(response.status, 200);
  assert.equal(response.text(), fullBody);
  assert.equal(hits.get("/recover"), 2);
  assert.deepEqual(requests[0], requests[1]);
});

test("no opt-in means one request; its original error exposes the disconnect reason", async () => {
  await assert.rejects(guardedFetch(`${base}/no-retry`), (error: unknown) => {
    assert.ok(error instanceof TypeError);
    assert.equal(error.message, "fetch failed");
    assert.ok(droppedConnection(error));
    assert.match(failureMessage(error), /^fetch failed \((UND_ERR_SOCKET|ECONNRESET|EPIPE): .+\)$/);
    return true;
  });
  assert.equal(hits.get("/no-retry"), 1);
});

test("two dropped connections stop after exactly two requests and retain the error type", async () => {
  await assert.rejects(guardedFetch(`${base}/always`, { retryDropped: true }), (error: unknown) => {
    assert.ok(error instanceof TypeError);
    assert.equal(error.message, "fetch failed");
    return droppedConnection(error);
  });
  assert.equal(hits.get("/always"), 2);
});

test("a body cut short is terminated without opt-in, but a retry returns only the complete body", async () => {
  await assert.rejects(guardedFetch(`${base}/body-no-retry`), (error: unknown) => {
    assert.ok(error instanceof TypeError);
    assert.equal(error.message, "terminated");
    assert.equal((error.cause as { code: string }).code, "UND_ERR_SOCKET");
    return droppedConnection(error);
  });
  assert.equal(hits.get("/body-no-retry"), 1);
  const response = await guardedFetch(`${base}/body-retry`, { retryDropped: true });
  assert.equal(response.status, 200);
  assert.equal(response.body.byteLength, 100);
  assert.equal(response.text(), fullBody);
  assert.equal(hits.get("/body-retry"), 2);
});

test("POST does not retry even when opted in", async () => {
  await assert.rejects(guardedFetch(`${base}/post`, { method: "POST", body: "input", retryDropped: true }), droppedConnection);
  assert.equal(hits.get("/post"), 1);
});

test("HTTP errors and verification responses do not retry", async () => {
  for (const status of [500, 412]) {
    assert.equal((await guardedFetch(`${base}/${status}`, { retryDropped: true })).status, status);
    assert.equal(hits.get(`/${status}`), 1);
  }
});

test("an HTTP error whose body is cut short preserves its error and does not retry", async () => {
  for (const status of [503, 412]) {
    await assert.rejects(guardedFetch(`${base}/body-${status}`, { retryDropped: true }), (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, "terminated");
      assert.equal((error.cause as { code: string }).code, "UND_ERR_SOCKET");
      return true;
    });
    assert.equal(hits.get(`/body-${status}`), 1);
  }
});

test("a timeout does not retry", async () => {
  await assert.rejects(guardedFetch(`${base}/timeout`, { timeoutMs: 100, retryDropped: true }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "TimeoutError");
    assert.equal(droppedConnection(error), false);
    return true;
  });
  assert.equal(hits.get("/timeout"), 1);
});

test("the second request receives a fresh full timeout budget", async () => {
  const previousDelay = DROPPED_RETRY.afterMs;
  // The first request's budget expires while waiting to retry; the second still has time to finish.
  DROPPED_RETRY.afterMs = 1100;
  try {
    assert.equal((await guardedFetch(`${base}/budget`, { timeoutMs: 1000, retryDropped: true })).text(), fullBody);
    assert.equal(hits.get("/budget"), 2);
  } finally {
    DROPPED_RETRY.afterMs = previousDelay;
  }
});

test("only dropped-connection codes qualify, whether direct or in cause", () => {
  for (const code of ["UND_ERR_SOCKET", "ECONNRESET", "EPIPE"]) {
    assert.equal(droppedConnection({ code }), true);
    assert.equal(droppedConnection({ cause: { code } }), true);
  }
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED"]) {
    assert.equal(droppedConnection({ cause: { code } }), false);
  }
  assert.equal(droppedConnection(new Error("fetch failed", { cause: new AggregateError([]) })), false);
  assert.equal(droppedConnection(null), false);
});

test("failure reasons keep cause codes, avoid duplicates and retain the 1000-character bound", () => {
  const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
  const message = "fetch failed (UND_ERR_SOCKET: other side closed)";
  assert.equal(failureMessage(new Error("fetch failed", { cause })), message);
  assert.equal(failureMessage(new Error(message, { cause })), message);
  const refused = Object.assign(new AggregateError([]), { code: "ECONNREFUSED" });
  assert.equal(failureMessage(new Error("fetch failed", { cause: refused })), "fetch failed (ECONNREFUSED)");
  assert.equal(failureMessage(new Error("unchanged")), "unchanged");
  assert.equal(failureMessage("plain failure"), "plain failure");
  assert.equal(failureMessage(new Error("x".repeat(1001), { cause })), "x".repeat(1000));
});
