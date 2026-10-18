import assert from "node:assert/strict";
import { test } from "node:test";
import { schemas as publicSchemas } from "@amp/contracts/http/public";
import { apiFetch } from "../app/lib/http.ts";
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

test("native HTTP loader preserves its abort and 15-second timeout", async () => {
  const originalTimeout = AbortSignal.timeout;
  const originalFetch = globalThis.fetch;
  try {
    for (const path of ["/api/site/pool", "/api/site/timeline"] as const) {
      const timeout = new AbortController();
      AbortSignal.timeout = (ms) => {
        assert.equal(ms, 15_000);
        return timeout.signal;
      };
      for (const timedOut of [false, true]) {
        const controller = new AbortController();
        globalThis.fetch = async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            assert(signal);
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        const pending = loadOr404(
          () =>
            apiFetch(path, {
              baseUrl: "http://127.0.0.1:1",
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
            }).then((result) =>
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
    globalThis.fetch = originalFetch;
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

test("native admin success and error bodies stay readable to loaders and actions", async (t) => {
  const request = new Request("https://private.example/admin/runs", { headers: { host: "private.example" } });
  for (const status of [200, 409, 500]) {
    const body = status === 200 ? { feishu: false, password: true } : { detail: "请重新核对本次尝试" };
    t.mock.method(globalThis, "fetch", async () => Response.json(body, { status }));
    const result = await apiFetch("/api/auth/options", { baseUrl: "http://127.0.0.1:1" });
    assert.equal(result.bodyUsed, false);
    const loaderResponse = result.clone();
    assert.deepEqual(await adminBody(result, true), body);
    const pending = adminGet(request, "/api/auth/options", async () => loaderResponse);
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
