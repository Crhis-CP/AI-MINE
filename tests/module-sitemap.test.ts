import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@amp/backend/db";
import { installModules, serverModules, type SitemapEntry } from "@amp/backend/modules";
import { sitemapXml } from "@amp/backend/publication/sitemap";

const original = serverModules();
after(async () => {
  installModules(original);
  await closeDb();
});

test("module sitemap entries follow current visibility without overriding core pages or duplicating URLs", async () => {
  let visible = true;
  const entry = { loc: "/fixture-module?a=1&b=2", lastmod: new Date("2026-10-24T01:02:03Z"), changefreq: "daily", priority: 0.4 };
  installModules([{ name: "fixture", sitemap: { entries: async () => (visible ? [entry, entry, { loc: "/all", priority: 0.1 }] : []) } }]);
  const first = await sitemapXml();
  assert.equal(first.match(/\/fixture-module\?a=1&amp;b=2/g)?.length, 1);
  assert.match(first, /<lastmod>2026-10-24T01:02:03.000Z<\/lastmod>/);
  assert.match(first, /\/all<\/loc>[\s\S]*?<priority>0.9<\/priority>/);
  visible = false;
  assert.doesNotMatch(await sitemapXml(), /fixture-module/);
  installModules([]);
  assert.doesNotMatch(await sitemapXml(), /fixture-module/);
});

test("invalid or unavailable module discovery never returns a stale successful map", async () => {
  for (const entry of [
    { loc: "https://outside.invalid/path" },
    { loc: "//outside.invalid/path" },
    { loc: "/bad\\path" },
    { loc: "/fixture", lastmod: new Date("invalid") },
    { loc: "/fixture", changefreq: "</changefreq><bad/>" },
    { loc: "/fixture", priority: 2 },
  ] satisfies SitemapEntry[]) {
    installModules([{ name: "invalid", sitemap: { entries: async () => [entry] } }]);
    await assert.rejects(sitemapXml());
  }
  installModules([
    {
      name: "unavailable",
      sitemap: {
        entries: async () => {
          throw Error("fixture unavailable");
        },
      },
    },
  ]);
  await assert.rejects(sitemapXml(), /fixture unavailable/);
});
