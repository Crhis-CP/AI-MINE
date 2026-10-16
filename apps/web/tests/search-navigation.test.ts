import assert from "node:assert/strict";
import { after, test } from "node:test";
import { loadSearchNavigation } from "../app/features/search/navigation.ts";
const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
after(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});
test("search links share in-flight reads, retain no settled payload, and retry failed or invalid responses", async () => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "http://fixture.invalid" } } });
  let calls = 0,
    finish!: (response: Response) => void;
  globalThis.fetch = async () => {
    calls++;
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  };
  const first = loadSearchNavigation(),
    second = loadSearchNavigation();
  assert.strictEqual(first, second);
  assert.equal(calls, 1);
  finish(Response.json({ topics: [], hot: [] }));
  assert.deepEqual(await first, { topics: [], hot: [] });
  const fresh = loadSearchNavigation();
  assert.equal(calls, 2);
  finish(Response.json({}, { status: 503 }));
  await assert.rejects(fresh);
  const invalid = loadSearchNavigation();
  finish(Response.json({ topics: "invalid", hot: [] }));
  await assert.rejects(invalid);
  const retried = loadSearchNavigation();
  finish(Response.json({ topics: [{ slug: "mine", name: "合成矿企", group: "company" }], hot: [] }));
  assert.equal((await retried).topics[0]!.name, "合成矿企");
  assert.equal(calls, 4);
});
