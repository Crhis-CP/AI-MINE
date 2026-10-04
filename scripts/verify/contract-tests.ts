import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createPublicClient, publicSchemas } from "../../packages/api-client/src/public.ts";
import { privateSchemas } from "../../packages/api-client/src/private.ts";
import type { PoolResponse, FeedItemSummary, ItemSummary, SourceRef } from "../../packages/contracts/src/site.ts";
import type { components } from "../../packages/api-client/src/public.types.ts";
import { ApiError, contractResult } from "../../apps/web/app/lib/api.server.ts";

type PublicReadPath = Parameters<ReturnType<typeof createPublicClient>["GET"]>[0];
// @ts-expect-error Public consumers cannot call a private operation.
const privatePath: PublicReadPath = "/api/auth/options";
void privatePath;

const stats = { sources: 2, heatOnlySources: 1, items: 3, selected: 1, dailies: 0, sourceKinds: { rss: 2 }, day: { collected: 1, selected: 0 } };
const pool: PoolResponse = {
  filters: { channel: "all", category: null, tag: null, topic: null, q: null, tab: "time" },
  items: [
    {
      id: "contract-item",
      title: "契约条目",
      summary: null,
      reason: null,
      source: { name: "合成来源" },
      publishedAt: null,
      timelineAt: "2026-10-04T00:00:00.000Z",
      category: null,
      tags: [],
      score: null,
      selected: false,
      channel: "news",
    },
  ],
  page: 1,
  pageCount: 1,
  total: 1,
  todayCount: 1,
  freshness: "2026-10-04T00:00:00.000Z",
  generatedAt: "2026-10-04T00:00:00.000Z",
};
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type PriorFeed = Pick<
  ItemSummary,
  "id" | "title" | "summary" | "reason" | "publishedAt" | "timelineAt" | "category" | "tags" | "score" | "selected" | "channel"
> & { source: Pick<SourceRef, "name"> };
const shapeProof: [Same<PoolResponse, components["schemas"]["PoolResponse"]>, Same<FeedItemSummary, PriorFeed>] = [true, true];
void shapeProof;
if (process.argv.includes("--routes")) {
  const state = globalThis as typeof globalThis & { contractStats: unknown; contractPool: unknown; poolMode: string; poolQueries: unknown[] };
  state.contractStats = stats;
  state.contractPool = { ...pool, generatedAt: new Date(pool.generatedAt) };
  state.poolMode = "ok";
  state.poolQueries = [];
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "@amp/backend/site/stats")
        return { url: "data:text/javascript,export async function loadSiteStats(){return globalThis.contractStats}", shortCircuit: true };
      if (specifier === "@amp/backend/publication/pool")
        return {
          url:
            "data:text/javascript," +
            encodeURIComponent(`
          export class SearchBusyError extends Error { retryAfter = 17; }
          export async function loadPool(query) {
            globalThis.poolQueries.push(query);
            if (globalThis.poolMode === "busy") throw new SearchBusyError();
            return globalThis.contractPool;
          }`),
          shortCircuit: true,
        };
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
    const listing = await app.inject("/api/site/pool?page=2&page=9&channel=all&ignored=yes");
    assert.equal(listing.statusCode, 200);
    assert.equal(listing.body, JSON.stringify(state.contractPool), "validation does not reserialize or strip the original wire bytes");
    assert.equal(listing.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(listing.headers["cache-control"], "public, max-age=60, s-maxage=60");
    assert.deepEqual(state.poolQueries[0], { channel: "all", category: null, tag: null, topic: null, topicTags: null, q: null, tab: "time", page: 2 });
    state.contractPool = { ...pool, generatedAt: "2026-10-04T00:01:00.000Z" };
    const pool304 = await app.inject({ url: "/api/site/pool", headers: { "if-none-match": listing.headers.etag! } });
    assert.equal(pool304.statusCode, 304);
    assert.equal(pool304.body, "");
    state.contractPool = { ...pool, generatedAt: "invalid-date" };
    const badConditional = await app.inject({ url: "/api/site/pool", headers: { "if-none-match": listing.headers.etag! } });
    assert.equal(badConditional.statusCode, 503, "an unchanged ETag cannot bypass wire validation");
    const badQuery = await app.inject("/api/site/pool?category=not-a-key");
    assert.equal(badQuery.statusCode, 400);
    assert.equal(badQuery.headers["content-type"], "application/problem+json");
    state.contractPool = { ...pool, items: [{ ...pool.items[0], score: "wrong" }] };
    const badPool = await app.inject("/api/site/pool");
    assert.equal(badPool.statusCode, 503);
    assert.equal(badPool.headers["content-type"], "application/problem+json");
    state.poolMode = "busy";
    const busyPool = await app.inject("/api/site/pool");
    assert.equal(busyPool.statusCode, 503);
    assert.equal(busyPool.headers["retry-after"], "17");
    assert.equal((await privateApp.inject({ url: "/api/site/pool", headers: { "x-forwarded-host": "private.invalid" } })).statusCode, 404);
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
  test("existing stats, pool and private options routes retain wire, query, ETag and host behavior", () => {
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
  test("pool generated client enforces nullable DTO and preserves serialized query/cancellation", async () => {
    const controller = new AbortController();
    const client = createPublicClient({
      baseUrl: "https://fixture.invalid",
      fetch: async (request) => {
        assert.equal(new URL(request.url).pathname, "/api/site/pool");
        assert.equal(new URL(request.url).searchParams.get("page"), "2");
        request.signal.throwIfAborted();
        return Response.json(pool);
      },
    });
    const response = await client.GET("/api/site/pool", { params: { query: { page: 2 } }, signal: controller.signal });
    assert.deepEqual(contractResult(response, publicSchemas.PoolResponse), pool);
    for (const item of [
      { ...pool.items[0], category: "unapproved" },
      { ...pool.items[0], summary: undefined },
    ]) {
      assert.throws(() => publicSchemas.PoolResponse.parse({ ...pool, items: [item] }));
    }
    controller.abort();
    await assert.rejects(client.GET("/api/site/pool", { params: { query: { page: 2 } }, signal: controller.signal }), { name: "AbortError" });
  });
  test("generated document components remain private to their entry", () => {
    for (const [audience, routes, absent] of [
      ["public", ["/api/site/pool", "/api/site/stats"], "LoginOptions"],
      ["private", ["/api/auth/options"], "PoolResponse"],
    ] as const) {
      const json = readFileSync(new URL(`../../reference/contracts/${audience}.openapi.json`, import.meta.url), "utf8");
      const doc = JSON.parse(json);
      assert.equal(doc.openapi, "3.1.0");
      assert.deepEqual(Object.keys(doc.paths), routes);
      assert.ok(!json.includes(absent));
      for (const route of routes)
        for (const [status, response] of Object.entries(doc.paths[route].get.responses)) {
          if (Number(status) >= 400) assert.deepEqual(Object.keys((response as { content: object }).content), ["application/problem+json"]);
        }
    }
  });
}
