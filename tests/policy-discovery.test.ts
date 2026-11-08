import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
const { XMLParser } = createRequire(new URL("../packages/backend/package.json", import.meta.url))("fast-xml-parser");
import { englishLoc, renderSitemap, SitemapPageNotFound } from "../packages/backend/src/publication/sitemap.ts";

test("sitemap sharding preserves all qualified entries and rejects nonexistent shards", () => {
  const entries = Array.from({ length: 5 }, (_, n) => ({ loc: `/policies/p${n}?a=1&b=2`, lastmod: new Date("2026-10-09T00:00:00Z") }));
  const parser = new XMLParser();
  const index = parser.parse(renderSitemap(entries, undefined, 2));
  // Each reader page is listed in Chinese and in English (TASK-0590): 10 addresses, 5 shards of 2.
  assert.equal(index.sitemapindex.sitemap.length, 5);
  assert.ok(index.sitemapindex.sitemap[0].loc.endsWith("/sitemaps/1.xml"));
  const actual = [1, 2, 3, 4, 5].flatMap((n) => {
    const rows = parser.parse(renderSitemap(entries, n, 2)).urlset.url;
    return Array.isArray(rows) ? rows : [rows];
  });
  assert.equal(actual.length, 10);
  assert.equal(new Set(actual.map((r: { loc: string }) => r.loc)).size, 10);
  assert.equal(actual.filter((r: { loc: string }) => r.loc.includes("/en/policies/")).length, 5);
  assert.ok(actual.every((r: { loc: string; lastmod: string }) => r.loc.endsWith("?a=1&b=2") && r.lastmod === "2026-10-09T00:00:00.000Z"));
  assert.throws(() => renderSitemap(entries, 6, 2), SitemapPageNotFound);
  assert.throws(() => renderSitemap(entries, 0, 2), SitemapPageNotFound);
  assert.ok(parser.parse(renderSitemap([])).urlset !== undefined);
});

test("the sitemap names both language versions of a page, Chinese as the default (TASK-0590)", () => {
  const xml = renderSitemap([{ loc: "/items/abc" }, { loc: "/" }, { loc: "/feed.xml" }]);
  assert.match(xml, /xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml"/);
  const urls = new XMLParser({ ignoreAttributes: false }).parse(xml).urlset.url as {
    loc: string;
    "xhtml:link"?: { "@_hreflang": string; "@_href": string }[];
  }[];
  assert.deepEqual(
    urls.map((u) => new URL(u.loc).pathname),
    ["/items/abc", "/en/items/abc", "/", "/en", "/feed.xml"],
  );
  const links = (u: (typeof urls)[number]) => Object.fromEntries((u["xhtml:link"] ?? []).map((l) => [l["@_hreflang"], new URL(l["@_href"]).pathname]));
  for (const u of urls.slice(0, 2)) assert.deepEqual(links(u), { "zh-CN": "/items/abc", en: "/en/items/abc", "x-default": "/items/abc" });
  assert.deepEqual(links(urls[3]!), { "zh-CN": "/", en: "/en", "x-default": "/" });
  assert.equal(urls[4]!["xhtml:link"], undefined, "a feed has one address");
  assert.equal(englishLoc("/en/all"), null);
  assert.equal(englishLoc("/api/site/news"), null);
  assert.equal(englishLoc("/topics/copper?page=2"), "/en/topics/copper?page=2");
});
