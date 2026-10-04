import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublicClient, publicSchemas } from "@amp/api-client/public";
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
  const timeout = new AbortController();
  AbortSignal.timeout = (ms) => {
    assert.equal(ms, 15_000);
    return timeout.signal;
  };
  try {
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
            .GET("/api/site/pool", {
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
            })
            .then((result) => contractResult(result, publicSchemas.PoolResponse)),
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
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});
