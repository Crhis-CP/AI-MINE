// Collector egress uses a direct connection when unset; a set EGRESS_PROXY_URL carries
// collection and images, and model calls stay off it. Nothing here dials the public internet.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { webEnvironmentProblems } from "../apps/web/runtime-env.ts";
import { config } from "@amp/backend/config";
import { guardedFetch } from "@amp/backend/lib/http-fetch";
import { environmentProblems } from "@amp/config";

const previousProxy = config.egressProxyUrl;
const previousPrivate = config.allowPrivateNetworkFetch;
const previousDispatcher = getGlobalDispatcher();
const savedEgress = process.env.EGRESS_PROXY_URL;
const mock = new MockAgent();
mock.disableNetConnect();
setGlobalDispatcher(mock);
let proxyHits = 0;
const proxy = createServer();
proxy.on("connect", (_req, socket) => {
  proxyHits += 1;
  socket.on("error", () => {});
  socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
});
await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

after(async () => {
  config.egressProxyUrl = previousProxy;
  config.allowPrivateNetworkFetch = previousPrivate;
  if (savedEgress === undefined) delete process.env.EGRESS_PROXY_URL;
  else process.env.EGRESS_PROXY_URL = savedEgress;
  setGlobalDispatcher(previousDispatcher);
  await mock.close();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
});

test("an empty egress proxy leaves collection direct, and a set one carries fetch but not model calls", async () => {
  config.allowPrivateNetworkFetch = true;
  const abroad = mock.get("https://abroad.invalid");
  abroad.intercept({ path: "/feed" }).reply(200, "feed");
  abroad.intercept({ path: "/feed" }).reply(200, "feed");
  mock.get("https://news.example.cn").intercept({ path: "/list" }).reply(200, "cn");
  mock.get("https://files.example.local").intercept({ path: "/a" }).reply(200, "local");
  mock.get("https://model.invalid").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, "registered-model");
  mock.get("https://plain-model.invalid").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, "plain-model");

  config.egressProxyUrl = null;
  const untouched = proxyHits;
  assert.equal((await guardedFetch("https://abroad.invalid/feed", { timeoutMs: 1000 })).text(), "feed");
  config.egressProxyUrl = "";
  assert.equal((await guardedFetch("https://abroad.invalid/feed", { timeoutMs: 1000 })).text(), "feed");
  assert.equal(proxyHits, untouched);

  config.egressProxyUrl = proxyUrl;
  process.env.EGRESS_PROXY_URL = proxyUrl;
  await assert.rejects(guardedFetch("https://abroad.invalid/feed", { timeoutMs: 1000 }));
  assert.ok(proxyHits > untouched);
  const afterFetch = proxyHits;
  assert.equal((await guardedFetch("https://news.example.cn/list", { timeoutMs: 1000 })).text(), "cn");
  assert.equal((await guardedFetch("https://files.example.local/a", { timeoutMs: 1000 })).text(), "local");
  assert.equal(
    (await guardedFetch("https://model.invalid/v1/chat/completions", { method: "POST", body: "{}", route: "direct", timeoutMs: 1000 })).text(),
    "registered-model",
  );
  assert.equal(await (await fetch("https://plain-model.invalid/v1/chat/completions", { method: "POST", body: "{}" })).text(), "plain-model");
  assert.equal(proxyHits, afterFetch);
});

test("production startup accepts EGRESS_PROXY_URL and still refuses a process-wide proxy", () => {
  for (const role of ["web", "api", "worker", "public-api", "private-api"] as const) {
    assert.deepEqual(environmentProblems(role, { NODE_ENV: "production", EGRESS_PROXY_URL: "http://127.0.0.1:7890" }), []);
    assert.deepEqual(environmentProblems(role, { NODE_ENV: "production", EGRESS_PROXY_URL: "" }), []);
    assert.deepEqual(environmentProblems(role, { NODE_ENV: "production", HTTP_PROXY: "http://127.0.0.1:7890" }), ["HTTP_PROXY"]);
    assert.deepEqual(environmentProblems(role, { NODE_ENV: "production", HTTPS_PROXY: "" }), ["HTTPS_PROXY"]);
    assert.deepEqual(environmentProblems(role, { NODE_ENV: "production", ALL_PROXY: "http://127.0.0.1:7890" }), ["ALL_PROXY"]);
  }
  assert.deepEqual(webEnvironmentProblems({ NODE_ENV: "production", EGRESS_PROXY_URL: "http://127.0.0.1:7890" }), []);
  assert.deepEqual(webEnvironmentProblems({ NODE_ENV: "production", https_proxy: "" }), ["https_proxy"]);
});
