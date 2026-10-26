import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FeedItemSummary, MediaView, PoolResponse, TimelineCard, XPostView, XPostFeedView, XPostDetailView, XPostDetailFields } from "../src/http/public.ts";
import type { ItemDetail, SiteItemDetail } from "../src/site.ts";

const legacy = {
  id: "original-post-fixture",
  title: "合成原帖",
  summary: null,
  reason: null,
  publishedAt: null,
  timelineAt: "2026-10-26T01:00:00Z",
  category: null,
  tags: [],
  score: null,
  selected: false,
  channel: "news",
  source: { name: "合成来源" },
};
const media = { kind: "image" as const, url: "https://example.invalid/image.png", width: null, height: null, alt: null, poster: null };
const quote = { authorName: "引用作者", handle: "quoted", text: "引用原文", translation: null };
const feed = { authorName: "作者", handle: "author", avatarUrl: null, media: [media], quoted: quote };
const detail = { ...feed, quoted: { ...quote, url: "https://example.invalid/post/quoted" } };

test("original-post fields are optional without inventing values or a new channel", () => {
  assert.deepEqual(FeedItemSummary.parse(legacy), legacy);
  assert.deepEqual(XPostDetailFields.parse({}), {});
  assert.equal(FeedItemSummary.parse({ ...legacy, x: null }).x, null);
  assert.deepEqual(FeedItemSummary.parse({ ...legacy, x: feed }).x, feed);
  assert.equal(PoolResponse.shape.items.safeParse([{ ...legacy, x: feed }]).success, true);
  assert.equal(TimelineCard.shape.item.safeParse({ ...legacy, x: feed }).success, true);
  assert.equal(FeedItemSummary.safeParse({ ...legacy, channel: "x", x: feed }).success, false);
  const item: Pick<ItemDetail, "x"> = { x: XPostDetailView.parse(detail) };
  const site: Pick<SiteItemDetail, "x"> = item;
  assert.deepEqual(XPostDetailFields.parse(site).x, detail);
});

test("card and detail projections reject copied main text, translations and internal payloads", () => {
  const full = { ...detail, text: "主原文", translation: "主译文" };
  assert.deepEqual(XPostView.parse(full), full);
  assert.equal(XPostFeedView.safeParse(full).success, false);
  assert.equal(XPostDetailView.safeParse(full).success, false);
  assert.equal(XPostFeedView.safeParse(detail).success, false, "the card does not carry a quote URL");
  for (const key of ["raw", "receiptId", "permission", "apiKey"]) {
    assert.equal(XPostView.safeParse({ ...full, [key]: "private" }).success, false);
    assert.equal(XPostFeedView.safeParse({ ...feed, quoted: { ...quote, [key]: "private" } }).success, false);
    assert.equal(MediaView.safeParse({ ...media, [key]: "private" }).success, false);
  }
});

test("media accepts safe source or site URLs and rejects unsafe responsive candidates", () => {
  assert.equal(
    MediaView.safeParse({ ...media, fullUrl: "/media/full.png", srcSet: "/media/small.png 320w, https://example.invalid/large.png 640w" }).success,
    true,
  );
  assert.equal(MediaView.safeParse({ ...media, kind: "video", poster: "/media/poster.png", srcSet: "https://example.invalid/poster.png 1.5x" }).success, true);
  for (const url of ["javascript:alert(1)", "data:text/html,private", "//other.invalid/image", "/\\other.invalid/image", "/bad image"]) {
    assert.equal(MediaView.safeParse({ ...media, url }).success, false, url);
    assert.equal(XPostView.safeParse({ ...detail, text: "", translation: null, avatarUrl: url }).success, false, url);
  }
  for (const srcSet of ["", "javascript:alert(1) 1x", "/media/image.png 0w", "/media/image.png 1.0w", "/media/image.png 1.5w", "/media/image.png 1x junk"])
    assert.equal(MediaView.safeParse({ ...media, srcSet }).success, false, srcSet);
  assert.equal(MediaView.safeParse({ ...media, width: -1 }).success, false);
  assert.equal(MediaView.safeParse({ ...media, height: "unknown" }).success, false);
  assert.equal(MediaView.safeParse({ ...media, fullUrl: null }).success, false);
});

test("generated public components preserve optional x and the safe card/detail split", () => {
  const doc = JSON.parse(readFileSync(new URL("../../../reference/contracts/public.openapi.json", import.meta.url), "utf8"));
  const schemas = doc.components.schemas;
  assert.ok(schemas.FeedItemSummary.properties.x);
  assert.ok(!schemas.FeedItemSummary.required.includes("x"));
  for (const name of ["XPostFeedView", "XPostDetailView"]) {
    assert.equal(schemas[name].additionalProperties, false);
    assert.equal(schemas[name].properties.text, undefined);
    assert.equal(schemas[name].properties.translation, undefined);
  }
  assert.ok(!schemas.XPostDetailFields.required?.includes("x"));
});
