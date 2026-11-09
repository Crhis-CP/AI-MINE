// Which reader lists show arriving news as it comes, and which new cards fade in (TASK-0587, Owner 2026-11-07).
import assert from "node:assert/strict";
import { test } from "node:test";
import { arrivalKeys, liveList, markArrivals, onHotList } from "../app/features/feed/live.ts";

test("精选, the first page of 全部动态 and 热点 are live; deeper pages and other lists wait for the reader", () => {
  assert.equal(liveList("/", ""), true);
  assert.equal(liveList("/hot", ""), true);
  assert.equal(liveList("/all", ""), true);
  assert.equal(liveList("/all", "?jurisdiction=PE&category=commodity_market"), true, "filters keep a first page live");
  assert.equal(liveList("/all", "?page=1"), true);
  assert.equal(liveList("/all", "?page=4"), false, "inserting above a deep page would move what is being read");
  assert.equal(liveList("/all", "?cursor=abc"), false);
  for (const section of ["/topics", "/topics/lithium", "/starred", "/daily", "/items/x", "/story/y"]) assert.equal(liveList(section, ""), false, section);
});

test("only the cards that were not on screen before are marked to fade in", () => {
  const node = (id: string) => ({ dataset: { itemId: id } as Record<string, string>, addEventListener() {} });
  const nodes = [node("old-1"), node("new-1"), node("old-2"), node("new-2")];
  const root = { querySelectorAll: () => nodes } as unknown as ParentNode;
  assert.equal(markArrivals(new Set(["old-1", "old-2"]), root), 2);
  assert.deepEqual(
    nodes.map((n) => "arrived" in n.dataset),
    [false, true, false, true],
  );
});

test("hot-list event cards fade in too, keyed apart from article IDs (Codex review #395)", () => {
  assert.equal(onHotList("/hot"), true);
  assert.equal(onHotList("/en/hot"), true);
  assert.equal(onHotList("/all"), false);
  // A hot card is the article or row its event link stretches over; two links in one card count once.
  const card = () => ({ dataset: {} as Record<string, string>, addEventListener() {} });
  const cards = { a: card(), b: card(), c: card() };
  const link = (story: string, inside: keyof typeof cards) => ({ getAttribute: () => `/story/${story}`, closest: () => cards[inside] });
  const links = [link("s-old", "a"), link("s-new", "b"), link("s-new", "b"), link("s-new2", "c")];
  const root = {
    querySelectorAll: (selector: string) => (selector === "[data-item-id]" ? [] : links),
  } as unknown as ParentNode;
  assert.deepEqual([...arrivalKeys(root, true)].sort(), ["story:s-new", "story:s-new2", "story:s-old"]);
  assert.equal(markArrivals(new Set(["story:s-old"]), root, true), 2);
  assert.deepEqual(
    Object.values(cards).map((n) => "arrived" in n.dataset),
    [false, true, true],
  );
  // Elsewhere the event links inside article cards are not arrivals of their own.
  assert.deepEqual([...arrivalKeys(root, false)], []);
});
