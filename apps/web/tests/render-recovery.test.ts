import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createRenderErrorHandler } from "../app/lib/render-recovery.ts";

const errorInfo = { componentStack: "synthetic fixture" };
function fixture(t: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const saved = new Map<string, string>();
  let reloads = 0,
    reads = 0;
  let response: () => Promise<Response> = async () => Response.json({ ok: true, release: "new-release" });
  const location = {
    href: "https://reader.invalid/items/item",
    reload: () => {
      reloads++;
    },
  };
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      saved.set(key, value);
    },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location, sessionStorage: storage } });
  globalThis.fetch = async (input, init) => {
    reads++;
    assert.equal(input, "/api/health");
    assert.equal(init?.cache, "no-store");
    assert.ok(init?.signal);
    return response();
  };
  console.error = () => {};
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
    globalThis.fetch = originalFetch;
    console.error = originalError;
  });
  return {
    location,
    storage,
    saved,
    setResponse: (next: typeof response) => {
      response = next;
    },
    counts: () => ({ reloads, reads }),
  };
}

test("a newer healthy release replaces an obsolete public document once, including a repeated old document", async (t) => {
  const f = fixture(t);
  await createRenderErrorHandler("old-release")(new Error("obsolete render"), errorInfo);
  assert.deepEqual(f.counts(), { reads: 1, reloads: 1 });
  assert.equal(f.saved.get("amp-render-recovery-release"), "old-release");
  await createRenderErrorHandler("old-release")(new Error("still old"), errorInfo);
  assert.deepEqual(f.counts(), { reads: 1, reloads: 1 });
});

test("admin edits, route responses, unknown versions and development do not probe or reload", async (t) => {
  const f = fixture(t);
  for (const path of ["/admin", "/admin/models?draft=1", "/admin/account"]) {
    f.location.href = `https://reader.invalid${path}`;
    await createRenderErrorHandler("old-release")(new Error("edit error"), errorInfo);
  }
  f.location.href = "https://reader.invalid/";
  await createRenderErrorHandler("old-release")({ status: 404, statusText: "Not Found", internal: false, data: "missing" }, errorInfo);
  for (const version of [null, "", "dev"]) await createRenderErrorHandler(version)(new Error("render"), errorInfo);
  assert.deepEqual(f.counts(), { reads: 0, reloads: 0 });
});

test("failed, malformed and unchanged health evidence leaves manual recovery available", async (t) => {
  const f = fixture(t);
  const handler = createRenderErrorHandler("old-release");
  for (const result of [
    { ok: false, release: "new-release" },
    { ok: true, release: "old-release" },
    { ok: true, release: "dev" },
    { ok: true, release: "" },
    null,
  ]) {
    f.setResponse(async () => Response.json(result));
    await handler(new Error("render"), errorInfo);
  }
  f.setResponse(async () => new Response("unavailable", { status: 503 }));
  await handler(new Error("render"), errorInfo);
  f.setResponse(async () => {
    throw new Error("offline");
  });
  await handler(new Error("render"), errorInfo);
  assert.equal(f.counts().reloads, 0);
  assert.equal(f.saved.size, 0);
});

test("simultaneous render errors share a check and navigation during that check prevents reload", async (t) => {
  const f = fixture(t),
    pending = Promise.withResolvers<Response>();
  f.setResponse(() => pending.promise);
  const handler = createRenderErrorHandler("old-release");
  const first = handler(new Error("render one"), errorInfo);
  await handler(new Error("render two"), errorInfo);
  assert.equal(f.counts().reads, 1);
  f.location.href = "https://reader.invalid/admin/models";
  pending.resolve(Response.json({ ok: true, release: "new-release" }));
  await first;
  assert.equal(f.counts().reloads, 0);
  assert.equal(f.saved.size, 0);
});

test("blocked browser storage does not create a reload loop", async (t) => {
  const f = fixture(t);
  f.storage.getItem = () => {
    throw new Error("storage blocked");
  };
  await createRenderErrorHandler("old-release")(new Error("render"), errorInfo);
  assert.deepEqual(f.counts(), { reads: 0, reloads: 0 });
});

test("failed recovery-marker writes leave the page in place", async (t) => {
  const f = fixture(t);
  f.storage.setItem = () => {
    throw new Error("storage full");
  };
  await createRenderErrorHandler("old-release")(new Error("render"), errorInfo);
  assert.deepEqual(f.counts(), { reads: 1, reloads: 0 });
});
