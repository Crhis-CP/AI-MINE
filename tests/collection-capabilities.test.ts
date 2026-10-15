// Offline regressions for the three generic collectors: split dates, HTML-attribute JSON lists, form pages.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSupportedConfig } from "@amp/backend/sources/config-keys";
import { jsonListDocument } from "@amp/backend/sources/json-list";
import { formPageRequest, htmlListDocument, listingFormPages } from "@amp/backend/sources/web-list";
import type { SourceRow } from "../packages/backend/src/sources/types.ts";

function source(kind: SourceRow["kind"], config: Record<string, unknown>): SourceRow {
  return {
    id: "fixture",
    name: "fixture",
    kind,
    config,
    tier: "T2",
    participation_mode: "editorial",
    lane: "news",
    first_party: false,
    interval_minutes: 60,
    enabled: false,
    cursor: null,
    fail_count: 0,
  };
}

test("split list dates are joined in selector order before parsing", () => {
  const row = source("web_list", {
    url: "https://company.example/news",
    itemSelector: ".item",
    linkSelector: "a",
    publishedAtSelectors: [".year", ".month", ".day"],
    publishedAtPartSeparator: "-",
  });
  assert.doesNotThrow(() => assertSupportedConfig("web_list", row.config));
  const html = `<div class="item"><a href="/news/1">产量公告</a><span class="year">2026</span><span class="month">10</span><span class="day">08</span></div>`;
  const [item] = htmlListDocument(html, "https://company.example/news", row, "2026-10-14T00:00:00.000Z");
  assert.equal(item?.candidate?.url, "https://company.example/news/1");
  assert.equal(item?.candidate?.sourceDateObservation?.raw, "2026-10-08");
  assert.equal(item?.candidate?.publishedAt?.toISOString(), "2026-10-07T16:00:00.000Z");
});

test("a JSON list living in an HTML attribute is read without a network call", () => {
  const row = source("json_list", {
    url: "https://company.example/news",
    mode: "html_attribute",
    attributeSelector: "#news",
    attributeName: ":articles",
    titlePaths: ["title"],
    urlTemplate: "https://company.example/news/{slug}",
    publishedAtPath: "published",
  });
  assert.doesNotThrow(() => assertSupportedConfig("json_list", row.config));
  const html = `<div id="news" :articles="[{&quot;title&quot;:&quot;季度产量&quot;,&quot;slug&quot;:&quot;q3&quot;,&quot;published&quot;:&quot;2026-10-08&quot;}]"></div>`;
  const [item] = jsonListDocument(html, row, "2026-10-14T00:00:00.000Z").candidates;
  assert.equal(item?.title, "季度产量");
  assert.equal(item?.url, "https://company.example/news/q3");
  assert.equal(item?.sourceDateObservation?.raw, "2026-10-08");
});

test("form pages keep named fields, skip unchecked boxes, and never ask for more than five pages", () => {
  const html = `<form id="pager" action="/news" method="get"><input name="q" value="mine"><input name="page" value="1"><input type="checkbox" name="extra" value="1"><input type="checkbox" name="on" value="yes" checked></form>`;
  const get = formPageRequest(html, "https://company.example/news", "#pager", "page", 2);
  assert.equal(get.method, "GET");
  assert.equal(get.url, "https://company.example/news?q=mine&on=yes&page=2");
  const post = formPageRequest(html.replace('method="get"', 'method="post"'), "https://company.example/news", "#pager", "page", 3);
  assert.equal(post.method, "POST");
  assert.equal(post.contentType, "application/x-www-form-urlencoded");
  assert.equal(post.body, "q=mine&on=yes&page=3");
  assert.deepEqual(listingFormPages(1, 99), { firstPage: 1, pageCount: 5 });
  assert.throws(() => formPageRequest("<div></div>", "https://company.example/news", "#pager", "page", 2), /翻页表单不存在/);
  assert.throws(() => assertSupportedConfig("web_list", { url: "https://company.example/news", pageForm: { selector: "form", page: 1 } }), /pageForm\.page/);
});
