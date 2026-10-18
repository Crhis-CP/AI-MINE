import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createRecordedFetchServer } from "./fixtures/recorded-fetch.ts";

test("the recording server replays fixtures and rejects absent, malformed and oversized requests", async (t) => {
  const url = "https://example.invalid/recorded";
  const server = createRecordedFetchServer(
    new Map([[url, { status: 201, headers: { "content-type": "text/plain", "x-fixture": "synthetic" }, body: "fixture only" }]]),
  );
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: string) => fetch(`${base}/fetch`, { method: "POST", headers: { "content-type": "application/json" }, body });
  const hit = await post(JSON.stringify({ url }));
  assert.equal(hit.status, 201);
  assert.equal(hit.headers.get("x-fixture"), "synthetic");
  assert.equal(await hit.text(), "fixture only");
  for (const [body, status, code] of [
    [JSON.stringify({ url: "https://example.invalid/missing" }), 404, "not_recorded"],
    ["{", 400, "invalid_json"],
    ["null", 400, "invalid_request"],
    [JSON.stringify({ url: 7 }), 400, "invalid_request"],
    [JSON.stringify({ url: "x".repeat(17_000) }), 413, "request_too_large"],
  ] as const) {
    const res = await post(body);
    assert.equal(res.status, status);
    assert.deepEqual(await res.json(), { code });
  }
  const get = await fetch(`${base}/fetch`);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  assert.deepEqual(await get.json(), { code: "method_not_allowed" });
  const missing = await fetch(`${base}/other`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { code: "not_found" });
});
