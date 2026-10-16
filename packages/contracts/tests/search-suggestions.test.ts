import assert from "node:assert/strict";
import { test } from "node:test";
import { SearchSuggestions } from "../src/http/public.ts";
import type { SearchSuggestions as SearchLinks } from "../src/site.ts";
test("search navigation accepts honest empty results and bounded internal event links", () => {
  const empty: SearchLinks = SearchSuggestions.parse({ topics: [], hot: [] });
  assert.deepEqual(empty, { topics: [], hot: [] });
  const hot = { rank: 1, title: "合成矿业进展", to: "/story/event-123" };
  assert.ok(SearchSuggestions.safeParse({ topics: [{ slug: "copper", name: "铜", group: "field" }], hot: [hot] }).success);
  for (const to of ["https://example.invalid/story", "//example.invalid/story", "javascript:alert(1)", "/admin/settings", "/story/../admin"])
    assert.equal(SearchSuggestions.safeParse({ topics: [], hot: [{ ...hot, to }] }).success, false);
  assert.equal(SearchSuggestions.safeParse({ topics: [], hot: Array.from({ length: 6 }, () => hot) }).success, false);
  assert.equal(SearchSuggestions.safeParse({ topics: [], hot: [{ ...hot, body: "不属于导航的正文" }] }).success, false);
});
