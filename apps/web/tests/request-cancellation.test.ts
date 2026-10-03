import assert from "node:assert/strict";
import { test } from "node:test";
import { apiGet, loadOr404 } from "../app/lib/api.server.ts";
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
