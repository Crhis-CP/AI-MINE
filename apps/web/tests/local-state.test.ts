import assert from "node:assert/strict";
import { after, test } from "node:test";
import { beijingDate } from "@amp/contracts/time";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
after(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});
let instance = 0;
async function reader(stars: unknown[] = [], policies: string[] = []) {
  const values = new Map<string, string>([
    ["amp-starred-items", JSON.stringify(stars)],
    ["amp-policy-saved-v1", JSON.stringify(policies)],
  ]);
  let denied = false;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (denied) throw new Error("QuotaExceeded");
          values.set(key, value);
        },
        removeItem: (key: string) => {
          if (denied) throw new Error("QuotaExceeded");
          values.delete(key);
        },
      },
    },
  });
  const state: typeof import("../app/lib/local-state.ts") = await import(`../app/lib/local-state.ts?test=${instance++}`);
  return {
    state,
    values,
    deny: () => {
      denied = true;
    },
  };
}

test("existing news snapshots migrate to references and erase title, summary and score copies", async () => {
  const { state, values } = await reader([{ id: "old", title: "withdrawn-title", summary: "withdrawn-summary", score: 88, savedAt: "broken" }]);
  const refs = state.getStarred();
  assert.equal(refs.length, 1);
  assert.deepEqual(Object.keys(refs[0]!).sort(), ["id", "savedAt", "type"]);
  assert.equal(refs[0]!.type, "item");
  assert.doesNotThrow(() => beijingDate(refs[0]!.savedAt));
  assert.doesNotMatch(values.get("amp-starred-items")!, /withdrawn|summary|score/);
  assert.strictEqual(state.getStarred(), refs);
  assert.deepEqual(state.removeStar("old"), { ok: true, added: false });
  assert.deepEqual(state.getStarred(), []);
});

test("invalid added dates stay removable and valid dates survive unchanged", async () => {
  const { state } = await reader([
    { id: "a", savedAt: "+275760-09-13T00:00:00.000Z" },
    { id: "b", savedAt: "2026-09-29T08:30:00+08:00" },
  ]);
  assert.equal(state.getStarred().length, 2);
  assert.doesNotThrow(() => beijingDate(state.getStarred()[0]!.savedAt));
  assert.equal(state.getStarred()[1]!.savedAt, "2026-09-29T08:30:00+08:00");
});

test("news and policy share the 100 reference limit without silently evicting the oldest", async () => {
  const { state, values } = await reader(
    Array.from({ length: 99 }, (_, i) => ({ id: `n${i}`, savedAt: "2026-10-01" })),
    ["p1"],
  );
  assert.equal(state.getStarred().length, 100);
  assert.equal(values.has("amp-policy-saved-v1"), false);
  assert.deepEqual(state.toggleStar({ id: "new" }), { ok: false, message: "最多收藏100条，请先移除一些收藏。" });
  assert.equal(state.isStarred("n98"), true);
  state.removeStar("p1", "policy");
  assert.deepEqual(state.toggleStar({ id: "new", type: "policy" }), { ok: true, added: true });
  assert.equal(state.getStarred().length, 100);
});

test("storage denial never reports a successful save or deletion", async () => {
  const { state, deny } = await reader([{ id: "existing", savedAt: "2026-10-01" }]);
  state.getStarred();
  deny();
  assert.deepEqual(state.toggleStar({ id: "new" }), { ok: false, message: "浏览器暂时无法保存收藏。" });
  assert.deepEqual(state.removeStar("existing"), { ok: false, message: "浏览器暂时无法保存收藏。" });
  assert.equal(state.isStarred("existing"), true);
  assert.equal(state.isStarred("new"), false);
});

test("existing overflow references remain recoverable while new additions are rejected", async () => {
  const { state } = await reader(Array.from({ length: 101 }, (_, i) => ({ id: `n${i}` })));
  assert.equal(state.getStarred().length, 101);
  assert.equal(state.toggleStar({ id: "another" }).ok, false);
  state.removeStar("n100");
  assert.equal(state.getStarred().length, 100);
});
