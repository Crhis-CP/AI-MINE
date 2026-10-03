import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fetcherConfig } from "@amp/config";
import { createFetcher } from "../apps/fetcher/src/server.ts";

test("fetcher configuration validates its bind address without database access", () => {
  assert.deepEqual(fetcherConfig({}), { host: "127.0.0.1", port: 3003 });
  assert.deepEqual(fetcherConfig({ FETCHER_HOST: "localhost", FETCHER_PORT: "3100" }), { host: "localhost", port: 3100 });
  for (const FETCHER_PORT of ["", "0", "65536", "1.5", "NaN"]) assert.throws(() => fetcherConfig({ FETCHER_PORT }), /FETCHER_PORT/);
  for (const FETCHER_HOST of ["", "http://127.0.0.1", "invalid host"]) assert.throws(() => fetcherConfig({ FETCHER_HOST }), /FETCHER_HOST/);
});

test("the recording server replays fixtures and rejects absent, malformed and oversized requests", async (t) => {
  const url = "https://example.invalid/recorded";
  const server = createFetcher(new Map([[url, { status: 201, headers: { "content-type": "text/plain", "x-fixture": "synthetic" }, body: "fixture only" }]]));
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

test("fetcher refuses database and model credentials before it listens", () => {
  for (const name of ["DATABASE_URL", "LLM_API_KEY"]) {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL("../apps/fetcher/src/main.ts", import.meta.url))], {
      env: { NODE_ENV: "production", [name]: "PRIVATE_MARKER" },
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, new RegExp(`fetcher must not hold ${name}`));
    assert.doesNotMatch(child.stderr, /PRIVATE_MARKER/);
    assert.doesNotMatch(child.stdout, /fetcher started/);
  }
});
