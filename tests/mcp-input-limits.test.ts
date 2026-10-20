import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { registerMcp } from "../apps/api/src/routes/mcp.ts";
import { MCP_TOOL_NAMES as T } from "@amp/contracts/mcp";

function rpc(body: string) {
  const line = body.split("\n").find((value) => value.startsWith("data:"));
  return JSON.parse(line ? line.slice(5) : body);
}

test("public MCP rejects structural amplification before schema validation", async (t) => {
  // Match the application's larger upload allowance: this route must enforce its own smaller limit.
  const app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  registerMcp(app);
  t.after(() => app.close());
  const request = (method: string, params: unknown) =>
    app.inject({
      method: "POST",
      url: "/api/mcp",
      headers: { host: "localhost", accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method, params },
    });
  for (const args of [
    Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`unknown${index}`, index])),
    { q: { nested: Array.from({ length: 17 }, () => null) } },
  ]) {
    const response = await request("tools/call", { name: T.search, arguments: args });
    assert.equal(response.statusCode, 200);
    const result = rpc(response.body).result;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /element.*16|16.*element/i, "the SDK must reject before expanding schema errors");
  }
  const healthy = await request("tools/list", {});
  assert.equal(healthy.statusCode, 200);
  assert.equal(rpc(healthy.body).result.tools.length, Object.keys(T).length, "the server still handles ordinary requests after rejection");
});

test("public MCP's parser rejects oversized envelopes without reducing other routes' upload allowance", async (t) => {
  const app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  registerMcp(app);
  app.post("/synthetic-upload", async () => ({ accepted: true }));
  t.after(() => app.close());
  const payload = { jsonrpc: "2.0", id: 1, method: "ping", params: { _meta: { padding: "x".repeat(256 * 1024) } } };
  const headers = { host: "localhost", accept: "application/json, text/event-stream" };
  assert.equal((await app.inject({ method: "POST", url: "/api/mcp", headers, payload })).statusCode, 413);
  assert.equal((await app.inject({ method: "POST", url: "/synthetic-upload", headers, payload })).statusCode, 200);
});
