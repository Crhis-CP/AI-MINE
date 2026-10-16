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

test("news and policy share the 500 reference limit without silently evicting the oldest", async () => {
  const { state, values } = await reader(
    Array.from({ length: 499 }, (_, i) => ({ id: `n${i}`, savedAt: "2026-10-01" })),
    ["p1"],
  );
  assert.equal(state.getStarred().length, 500);
  assert.equal(values.has("amp-policy-saved-v1"), false);
  assert.deepEqual(state.toggleStar({ id: "new" }), { ok: false, message: "最多收藏500条，请先移除一些收藏。" });
  assert.equal(state.isStarred("n98"), true);
  state.removeStar("p1", "policy");
  assert.deepEqual(state.toggleStar({ id: "new", type: "policy" }), { ok: true, added: true });
  assert.equal(state.getStarred().length, 500);
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
  const { state } = await reader(Array.from({ length: 501 }, (_, i) => ({ id: `n${i}` })));
  assert.equal(state.getStarred().length, 501);
  assert.equal(state.toggleStar({ id: "another" }).ok, false);
  state.removeStar("n500");
  assert.equal(state.getStarred().length, 500);
});

test("read marks are bounded recent IDs, deduplicated and never written on storage failure", async () => {
  const { state, values, deny } = await reader();
  for (let i = 0; i < 5002; i++) assert.equal(state.markRead(`r${i}`), true);
  assert.equal(state.getReadIds().length, 5000);
  assert.equal(state.getReadIds()[0], "r5001");
  assert.equal(state.getReadIds().includes("r0"), false);
  state.markRead("r4000");
  assert.equal(state.getReadIds()[0], "r4000");
  assert.equal(new Set(state.getReadIds()).size, 5000);
  assert.equal(state.markRead("<script>"), false);
  const before = values.get(state.KEYS.read);
  deny();
  assert.equal(state.markRead("new"), false);
  assert.equal(values.get(state.KEYS.read), before);
});
test("imports merge by reference type, keep existing choices and never import content", async () => {
  const { state, values } = await reader([{ type: "item", id: "existing", savedAt: "2026-01-01" }]);
  const incoming = {
    version: 1,
    starred: [
      { id: "existing", savedAt: "2026-02-01", title: "replacement" },
      { type: "policy", id: "existing", savedAt: "2026-02-01", summary: "forbidden" },
      { type: "story", id: "story1", savedAt: "2026-03-01" },
      { type: "bad", id: "bad", savedAt: "2026-01-01" },
      { id: "../bad", savedAt: "2026-01-01" },
    ],
    read: ["one", "one", 42, "<html>"],
    theme: "dark",
  };
  const report = state.importBundle(JSON.stringify(incoming));
  assert.equal(report.starredAdded, 2);
  assert.equal(report.starredSkipped, 2);
  assert.equal(report.readAdded, 1);
  assert.equal(report.readSkipped, 2);
  assert.equal(report.themeApplied, true);
  assert.equal(state.getStarred().find((ref) => ref.type === "item")!.savedAt, "2026-01-01");
  assert.doesNotMatch(values.get(state.KEYS.starred)!, /replacement|forbidden|summary|title/);
  assert.deepEqual(state.exportBundle(), { version: 1, starred: state.getStarred(), read: ["one"], theme: "dark" });
  const again = state.importBundle(JSON.stringify({ ...incoming, theme: "light" }));
  assert.equal(again.starredAdded, 0);
  assert.equal(again.readAdded, 0);
  assert.equal(again.themeApplied, false);
  assert.equal(state.getThemePreference(), "dark");
});
test("imports cannot erase corrupt or over-capacity existing references and reject malformed files", async () => {
  const { state, values } = await reader(Array.from({ length: 501 }, (_, i) => ({ id: `r${i}`, savedAt: "2026-01-01" })));
  const bundle = { version: 1, starred: [{ id: "new", savedAt: "2026-01-01" }], read: [] };
  assert.equal(state.importBundle(JSON.stringify(bundle)).starredSkipped, 1);
  assert.equal(state.getStarred().length, 501);
  assert.throws(() => state.importBundle("{"));
  assert.throws(() => state.importBundle("null"));
  assert.throws(() => state.importBundle(JSON.stringify({ ...bundle, version: 2 })));
  assert.throws(() => state.importBundle(" ".repeat(state.IMPORT_MAX_CHARS + 1)));
  values.set(state.KEYS.starred, "recoverable corrupt bytes");
  assert.throws(() => state.importBundle(JSON.stringify(bundle)));
  assert.equal(state.toggleStar({ id: "new" }).ok, false);
  assert.equal(state.removeStar("r1").ok, false);
  assert.equal(values.get(state.KEYS.starred), "recoverable corrupt bytes");
});
test("an import reports a failed read write without claiming it saved read marks", async () => {
  const { state, values } = await reader();
  const store = window.localStorage;
  const original = store.setItem;
  store.setItem = (key, value) => {
    if (key === state.KEYS.read) throw new Error("QuotaExceeded");
    original(key, value);
  };
  const result = state.importBundle(JSON.stringify({ version: 1, starred: [{ id: "new", savedAt: "2026-01-01" }], read: ["read"] }));
  assert.equal(result.starredAdded, 1);
  assert.equal(result.readFailed, true);
  assert.equal(result.readAdded, 0);
  assert.equal(values.get(state.KEYS.read), undefined);
});

test("recent search is bounded, case-insensitive, local only and clears only after storage succeeds", async () => {
  const { state, values, deny } = await reader();
  for (let i = 0; i < 12; i++) state.addRecentSearch(`Copper ${i}`);
  assert.equal(state.getRecentSearches().length, 10);
  assert.equal(state.getRecentSearches()[0], "Copper 11");
  state.addRecentSearch(" copper 5 ");
  assert.equal(state.getRecentSearches()[0], "copper 5");
  assert.equal(state.getRecentSearches().filter((q) => q.toLowerCase() === "copper 5").length, 1);
  state.addRecentSearch("中".repeat(250));
  assert.equal(state.getRecentSearches()[0]!.length, 200);
  assert.equal(state.addRecentSearch("  "), false);
  assert.ok(!("recentSearches" in state.exportBundle()));
  assert.equal(state.clearRecentSearches(), true);
  assert.deepEqual(state.getRecentSearches(), []);
  state.addRecentSearch("保留");
  const previous = values.get(state.KEYS.recentSearches);
  deny();
  assert.equal(state.clearRecentSearches(), false);
  assert.equal(state.addRecentSearch("失败"), false);
  assert.equal(values.get(state.KEYS.recentSearches), previous);
  assert.deepEqual(state.getRecentSearches(), ["保留"]);
});
