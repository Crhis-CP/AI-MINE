import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { checkApiTopology } from "../api-topology.ts";

test("unified topology probe rejects unsafe admin access, invalid health and login evidence", async (t) => {
  let fault: "none" | "admin" | "health" | "login" = "none";
  const origins: string[] = [];
  for (const role of ["api", "web"]) {
    const server = createServer((request, response) => {
      const privateHost = (role === "api" ? request.headers["x-forwarded-host"] : request.headers.host) === "private.example.test";
      const path = request.url;
      let status = 404;
      let body: unknown = {};
      if (path === "/api/health") {
        status = 200;
        body = fault === "health" ? null : { ok: true, db: "ok" };
      }
      if (path === "/api/site/meta") status = 200;
      if (path === "/api/auth/options" && privateHost) {
        status = 200;
        body = { password: fault !== "login", feishu: false };
      }
      if (path === "/api/admin/me" && privateHost) status = fault === "admin" ? 200 : 401;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
    t.after(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origins.push(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  }
  const targets = { apiUrl: origins[0]!, webUrl: origins[1]!, privateHost: "private.example.test" };
  assert.deepEqual(await checkApiTopology(targets), []);
  fault = "admin";
  assert.ok((await checkApiTopology(targets)).some((problem) => problem.includes("anonymous admin rejected: HTTP 200")));
  fault = "health";
  assert.ok((await checkApiTopology(targets)).some((problem) => problem.includes("invalid health response")));
  fault = "login";
  assert.ok((await checkApiTopology(targets)).some((problem) => problem.includes("invalid fixture login options")));
  assert.deepEqual(await checkApiTopology({ ...targets, apiUrl: "file:///not-http" }), ["API topology: invalid URL configuration"]);
});
