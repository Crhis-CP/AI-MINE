import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createPublicClient, publicSchemas } from "../../packages/api-client/src/public.ts";
import { privateSchemas } from "../../packages/api-client/src/private.ts";
import { ApiError, contractResult } from "../../apps/web/app/lib/api.server.ts";

type PublicReadPath = Parameters<ReturnType<typeof createPublicClient>["GET"]>[0];
// @ts-expect-error Public consumers cannot call a private operation.
const privatePath: PublicReadPath = "/api/auth/options";
void privatePath;

const stats = { sources: 2, heatOnlySources: 1, items: 3, selected: 1, dailies: 0, sourceKinds: { rss: 2 }, day: { collected: 1, selected: 0 } };
if (process.argv.includes("--routes")) {
  const state = globalThis as typeof globalThis & { contractStats: unknown };
  state.contractStats = stats;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "@amp/backend/site/stats")
        return { url: "data:text/javascript,export async function loadSiteStats(){return globalThis.contractStats}", shortCircuit: true };
      return next(specifier, context);
    },
  });
  const { buildApp } = await import("../../apps/api/src/app.ts");
  const app = await buildApp("public-api");
  const privateApp = await buildApp("private-api");
  try {
    const first = await app.inject("/api/site/stats");
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json(), stats);
    assert.equal(first.body, JSON.stringify(stats));
    const unchanged = await app.inject({ url: "/api/site/stats", headers: { "if-none-match": first.headers.etag! } });
    assert.equal(unchanged.statusCode, 304);
    assert.equal(unchanged.body, "");
    state.contractStats = { ...stats, sources: "wrong" };
    const invalid = await app.inject("/api/site/stats");
    assert.equal(invalid.statusCode, 503);
    assert.equal(invalid.headers["content-type"], "application/problem+json");
    assert.equal(publicSchemas.Problem.parse(invalid.json()).code, "temporarily_unavailable");
    assert.equal((await app.inject("/api/auth/options")).statusCode, 404);
    const denied = await privateApp.inject("/api/auth/options");
    assert.equal(denied.statusCode, 404);
    assert.equal(denied.headers["content-type"], "application/problem+json");
    const options = await privateApp.inject({ url: "/api/auth/options", headers: { "x-forwarded-host": "private.invalid" } });
    assert.equal(options.statusCode, 200);
    assert.deepEqual(privateSchemas.LoginOptions.parse(options.json()), { password: false, feishu: false });
  } finally {
    await Promise.all([app.close(), privateApp.close()]);
  }
} else {
  test("existing stats and private options routes retain JSON, ETag and host behavior", () => {
    execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--routes"], {
      env: {
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        PRIVATE_HOST: "private.invalid",
        MODEL_CALLS_ENABLED: "false",
        AMP_CREDENTIALS_DIR: "/nonexistent/amp-contract-tests",
      },
      stdio: "pipe",
    });
  });
  test("generated public client validates values and preserves HTTP errors and cancellation", async () => {
    const controller = new AbortController();
    const client = createPublicClient({
      baseUrl: "https://fixture.invalid",
      fetch: async (request) => {
        assert.equal(new URL(request.url).pathname, "/api/site/stats");
        request.signal.throwIfAborted();
        return Response.json(stats);
      },
    });
    const result = await client.GET("/api/site/stats", { signal: controller.signal });
    assert.deepEqual(contractResult(result, publicSchemas.SiteStats), stats);
    assert.throws(() => contractResult({ ...result, data: { ...stats, items: null } }, publicSchemas.SiteStats));
    assert.throws(
      () =>
        contractResult(
          { response: new Response("", { status: 503, headers: { "retry-after": "30" } }), error: { code: "temporarily_unavailable" } },
          publicSchemas.SiteStats,
        ),
      (error) => error instanceof ApiError && error.status === 503 && error.retryAfter === 30,
    );
    controller.abort();
    await assert.rejects(client.GET("/api/site/stats", { signal: controller.signal }), { name: "AbortError" });
  });
  test("generated document components remain private to their entry", () => {
    for (const [audience, route, absent] of [
      ["public", "/api/site/stats", "LoginOptions"],
      ["private", "/api/auth/options", "SiteStats"],
    ]) {
      const json = readFileSync(new URL(`../../reference/contracts/${audience}.openapi.json`, import.meta.url), "utf8");
      const doc = JSON.parse(json);
      assert.equal(doc.openapi, "3.1.0");
      assert.deepEqual(Object.keys(doc.paths), [route]);
      assert.ok(!json.includes(absent));
      for (const [status, response] of Object.entries(doc.paths[route].get.responses)) {
        if (Number(status) >= 400) assert.deepEqual(Object.keys((response as { content: object }).content), ["application/problem+json"]);
      }
    }
  });
}
