import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublicClient, publicSchemas } from "@amp/api-client/public";
import { createPrivateClient } from "@amp/api-client/private";
import { adminBody } from "../app/lib/admin-response.ts";
import { apiGet, contractResult, loadOr404 } from "../app/lib/api.server.ts";
import { adminGet } from "../app/lib/admin.server.ts";

test("public and admin loaders forward cancellation without turning it into a 503", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const signal = init?.signal;
    assert(signal);
    return new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  try {
    for (const load of [
      (signal: AbortSignal) => loadOr404("/api/site/items/example", { signal }),
      (signal: AbortSignal) => apiGet("/api/auth/options", { signal, baseUrl: "http://127.0.0.1:1", headers: { "x-forwarded-host": "web.test" } }),
      (signal: AbortSignal) => adminGet(new Request("http://local/admin/realtime", { signal }), "/api/admin/dashboard/realtime"),
    ]) {
      const controller = new AbortController();
      const pending = load(controller.signal);
      controller.abort();
      await assert.rejects(pending, (error: unknown) => error === controller.signal.reason);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("generated-client loader callback preserves its abort and 15-second timeout", async () => {
  const originalTimeout = AbortSignal.timeout;
  try {
    for (const path of ["/api/site/pool", "/api/site/timeline"] as const) {
      const timeout = new AbortController();
      AbortSignal.timeout = (ms) => {
        assert.equal(ms, 15_000);
        return timeout.signal;
      };
      for (const timedOut of [false, true]) {
        const controller = new AbortController();
        const client = createPublicClient({
          baseUrl: "http://127.0.0.1:1",
          fetch: async (request) =>
            new Promise<Response>((_resolve, reject) => {
              if (request.signal.aborted) reject(request.signal.reason);
              else request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
            }),
        });
        const pending = loadOr404(
          () =>
            client
              .GET(path, {
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
              })
              .then((result) =>
                contractResult(result, {
                  parse: (value) => (path.endsWith("timeline") ? publicSchemas.TimelineResponse : publicSchemas.PoolResponse).parse(value),
                }),
              ),
          { signal: controller.signal },
        );
        if (timedOut) timeout.abort(new DOMException("fixture timeout", "TimeoutError"));
        else controller.abort();
        await assert.rejects(pending, (error: unknown) =>
          timedOut
            ? !!error && typeof error === "object" && "init" in error && (error.init as { status?: number }).status === 503
            : error === controller.signal.reason,
        );
      }
    }
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test("an optional admin transport keeps original Host/cookie, timeout, cancellation and error mapping", async () => {
  const request = new Request("https://private.example/admin/usage-models/reconciliation", {
    headers: { host: "private.example", cookie: "fixture=1", "user-agent": "fixture", "x-forwarded-host": "spoof.example" },
  });
  assert.deepEqual(
    await adminGet(request, "/api/admin/runs", async (url, init) => {
      assert.equal(new URL(url).pathname, "/api/admin/runs");
      const headers = new Headers(init.headers);
      assert.equal(headers.get("cookie"), "fixture=1");
      assert.equal(headers.get("x-forwarded-host"), "private.example");
      assert.equal(headers.get("user-agent"), "fixture");
      return Response.json({ ok: true });
    }),
    { ok: true },
  );
  for (const status of [401, 404, 409, 500]) {
    await assert.rejects(
      adminGet(request, "/api/admin/runs", async () => Response.json({ detail: "fixture" }, { status })),
      (error: unknown) =>
        status === 401
          ? error instanceof Response && error.status === 302 && !!error.headers.get("location")?.startsWith("/admin/login?")
          : !!error && typeof error === "object" && "init" in error && (error.init as { status?: number }).status === (status === 500 ? 503 : status),
    );
  }
  const original = AbortSignal.timeout;
  try {
    for (const timedOut of [false, true]) {
      const caller = new AbortController(),
        timeout = new AbortController();
      AbortSignal.timeout = (ms) => {
        assert.equal(ms, 30_000);
        return timeout.signal;
      };
      const pending = adminGet(
        new Request(request, { signal: caller.signal }),
        "/api/admin/runs",
        async (_url, init) =>
          new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true })),
      );
      const controller = timedOut ? timeout : caller;
      controller.abort(new Error("fixture abort"));
      await assert.rejects(pending, (error) => error === controller.signal.reason);
    }
  } finally {
    AbortSignal.timeout = original;
  }
});

test("generated admin success and consumed error bodies stay readable to loaders and actions", async () => {
  const request = new Request("https://private.example/admin/runs", { headers: { host: "private.example" } });
  for (const status of [200, 409, 500]) {
    const body = status === 200 ? { feishu: false, password: true } : { detail: "请重新核对本次尝试" };
    const client = createPrivateClient({ baseUrl: "http://127.0.0.1:1", fetch: async () => Response.json(body, { status }) });
    const result = await client.GET("/api/auth/options");
    assert.equal(result.response.bodyUsed, true);
    assert.deepEqual(await adminBody(result, true), body);
    const pending = adminGet(request, "/api/auth/options", async () => result);
    if (status === 200) assert.deepEqual(await pending, body);
    else
      await assert.rejects(pending, (error: unknown) => {
        assert(error && typeof error === "object" && "data" in error && "init" in error);
        assert.deepEqual(error.data, { message: body.detail });
        assert.equal((error.init as { status: number }).status, status === 500 ? 503 : status);
        return true;
      });
  }
  assert.equal(await adminBody(new Response(null, { status: 204 }), true), null);
});
