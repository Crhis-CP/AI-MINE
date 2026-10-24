import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { closeDb, sql } from "@amp/backend/db";
import { installModules, serverModules } from "@amp/backend/modules";
import { buildApp } from "../apps/api/src/app.ts";

after(closeDb);
const rpc = (body: string) =>
  JSON.parse(
    body
      .split("\n")
      .find((line) => line.startsWith("data:"))
      ?.slice(5) ?? body,
  );

test("installed reader abilities share Agent/MCP inputs and isolate per-request reminders without writes", async (t) => {
  const prior = serverModules(),
    answered: string[] = [],
    exits: string[] = [];
  t.after(() => installModules(prior));
  installModules([
    {
      name: "reader-fixture",
      hosts: ["module.example.invalid"],
      agent: {
        unavailable: ["合成材料尚未公开"],
        requests: ["合成入口只接受无参数读取"],
        abilities: [
          {
            path: "/module-fixture",
            title: "合成模块",
            ask: "读取合成值",
            answer: async () => "模块只读答案",
            etagPrefix: "module-fixture",
            cacheControl: "public, max-age=60",
            mcp: {
              tool: "module_fixture",
              use: "for synthetic reading",
              description: "Synthetic read-only fixture",
              input: z.strictObject({ value: z.string().max(20) }),
              run: async (args) => {
                if (args.value === "fail") throw Error("PRIVATE_SYNTHETIC_FAILURE");
                return { text: String(args.value), structured: { value: args.value } };
              },
            },
          },
        ],
      },
      notices: {
        agent: (req) => (req.headers["x-fixture-note"] ? `\n${req.headers["x-fixture-note"]}` : null),
        mcp: (req) => {
          const text = String(req.headers["x-fixture-note"] ?? "");
          return text ? { instructions: text, text, notice: { label: text } } : null;
        },
      },
      on: {
        requestAnswered: (_req, _reply, path) => {
          answered.push(path);
        },
        exitServed: (exit) => {
          exits.push(exit);
        },
      },
    },
  ]);
  const app = await buildApp("public-api");
  t.after(() => app.close());
  const [before] = await sql`SELECT (SELECT count(*) FROM receipts)::int receipts,(SELECT count(*) FROM fetch_runs)::int fetches`;
  const path = "/api/v1/agent/module-fixture";
  const guide = await app.inject("/api/v1/agent");
  assert.match(guide.body, /合成模块/);
  assert.match(guide.body, /\/api\/v1\/agent\/module-fixture/);
  assert.match(guide.body, /合成材料尚未公开/);
  assert.match(guide.body, /合成入口只接受无参数读取/);
  const plain = await app.inject(path);
  assert.equal(plain.statusCode, 200);
  assert.equal(plain.body, "模块只读答案");
  assert.equal((await app.inject(path + "?unknown=1")).statusCode, 400);
  const noted = await app.inject({ url: path, headers: { "x-fixture-note": "Only A" } });
  assert.match(noted.body, /Only A/);
  assert.equal(noted.headers["cache-control"], "private, no-store");
  assert.notEqual(plain.headers.etag, noted.headers.etag);
  const request = (value: string, note: string, host = "localhost", origin?: string) =>
    app.inject({
      method: "POST",
      url: "/api/mcp",
      headers: { host, accept: "application/json, text/event-stream", "x-fixture-note": note, ...(origin ? { origin } : {}) },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "aiminingpolicy_module_fixture", arguments: { value } } },
    });
  const [a, b] = await Promise.all([request("A", "Only A"), request("B", "Only B", "module.example.invalid")]);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.equal(rpc(a.body).result.structuredContent.notice.label, "Only A");
  assert.equal(rpc(b.body).result.structuredContent.notice.label, "Only B");
  assert.doesNotMatch(a.body, /Only B/);
  const browser = await request("A", "", "module.example.invalid", "https://module.example.invalid");
  assert.equal(browser.statusCode, 200);
  assert.equal(browser.headers["access-control-allow-origin"], "https://module.example.invalid");
  const preflight = await app.inject({ method: "OPTIONS", url: "/api/mcp", headers: { origin: "https://module.example.invalid" } });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], "https://module.example.invalid");
  for (const origin of ["http://module.example.invalid", "https://other.example.invalid"])
    assert.equal((await request("A", "", "module.example.invalid", origin)).statusCode, 403);
  const failure = await request("fail", "");
  assert.equal(rpc(failure.body).result.isError, true);
  assert.doesNotMatch(failure.body, /PRIVATE_SYNTHETIC_FAILURE/);
  for (const host of ["user@localhost", "localhost:80,other.invalid", "localhost/path"]) assert.equal((await request("A", "", host)).statusCode, 421);
  assert.equal((await request("A", "", "[::1]:3000")).statusCode, 200);
  const [afterRead] = await sql`SELECT (SELECT count(*) FROM receipts)::int receipts,(SELECT count(*) FROM fetch_runs)::int fetches`;
  assert.deepEqual(afterRead, before);
  assert.ok(answered.includes(path));
  assert.ok(!answered.some((path) => path.includes("?")));
  assert.ok(exits.includes("agent") && exits.includes("mcp"));
});

test("a failed request observer cannot suppress another observer or break the reader response", async (t) => {
  const prior = serverModules();
  let observed = 0;
  t.after(() => installModules(prior));
  installModules([
    {
      name: "bad-observer",
      on: {
        requestAnswered: () => {
          throw Error("synthetic observer failure");
        },
      },
    },
    {
      name: "good-observer",
      on: {
        requestAnswered: () => {
          observed++;
        },
      },
    },
  ]);
  const app = await buildApp("public-api");
  t.after(() => app.close());
  assert.equal((await app.inject("/api/health")).statusCode, 200);
  assert.equal(observed, 1);
});
