import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
const { XMLParser } = createRequire(new URL("../packages/backend/package.json", import.meta.url))("fast-xml-parser");
import { renderSitemap, SitemapPageNotFound } from "../packages/backend/src/publication/sitemap.ts";

test("sitemap sharding preserves all qualified entries and rejects nonexistent shards", () => {
  const entries = Array.from({ length: 5 }, (_, n) => ({ loc: `/policies/p${n}?a=1&b=2`, lastmod: new Date("2026-10-09T00:00:00Z") }));
  const parser = new XMLParser();
  const index = parser.parse(renderSitemap(entries, undefined, 2));
  assert.equal(index.sitemapindex.sitemap.length, 3);
  assert.ok(index.sitemapindex.sitemap[0].loc.endsWith("/sitemaps/1.xml"));
  const actual = [1, 2, 3].flatMap((n) => {
    const rows = parser.parse(renderSitemap(entries, n, 2)).urlset.url;
    return Array.isArray(rows) ? rows : [rows];
  });
  assert.equal(actual.length, 5);
  assert.equal(new Set(actual.map((r: { loc: string }) => r.loc)).size, 5);
  assert.ok(actual.every((r: { loc: string; lastmod: string }) => r.loc.endsWith("?a=1&b=2") && r.lastmod === "2026-10-09T00:00:00.000Z"));
  assert.throws(() => renderSitemap(entries, 4, 2), SitemapPageNotFound);
  assert.throws(() => renderSitemap(entries, 0, 2), SitemapPageNotFound);
  assert.ok(parser.parse(renderSitemap([])).urlset !== undefined);
});
