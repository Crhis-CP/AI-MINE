// Offline regressions for the three generic collectors: split dates, HTML-attribute JSON lists, form pages.
import assert from "node:assert/strict";
import { test } from "node:test";
import { previewSourceDate } from "../packages/backend/src/sources/date-extraction.ts";
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

test("single-quoted static data is parsed as data and executable expressions are rejected", () => {
  const row = source("json_list", {
    url: "https://company.example/news",
    mode: "html_attribute",
    attributeSelector: "#news",
    attributeName: ":articles",
    literalFormat: "static",
    titlePaths: ["title"],
    urlTemplate: "https://company.example/{slug}",
    publishedAtPath: "date",
    sourceDate: { format: "declared", formatPattern: "DD/MM/YYYY", language: "en" },
  });
  assert.doesNotThrow(() => assertSupportedConfig("json_list", row.config));
  const document = (data: string) => `<div id="news" :articles="${data.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></div>`;
  const [item] = jsonListDocument(document("[{title:'Mine\\'s production',slug:'quarter',date:'08/10/2026',},]"), row, "2026-10-14T00:00:00Z").candidates;
  assert.equal(item.title, "Mine's production");
  assert.equal(item.sourceDateObservation?.raw, "08/10/2026");
  assert.equal(item.publishedAt?.toISOString(), "2026-10-07T16:00:00.000Z");
  for (const invalid of [
    "[{title:process.exit(),slug:'x'}]",
    "(()=>[])()",
    "[...items]",
    "[{get title(){return 'x'}}]",
    "[{title:`template`}]",
    "[{title:NaN}]",
    "[{title:undefined}]",
    "[1,,2]",
  ])
    assert.throws(() => jsonListDocument(document(invalid), row, "2026-10-14T00:00:00Z"));
});

test("column arrays retain row alignment and verified filing URL components", () => {
  const row = source("json_list", {
    url: "https://data.sec.gov/submissions/CIK0000000001.json",
    itemsPath: "filings.recent",
    itemsShape: "columns",
    titleTemplate: "Company · {raw:form} · {raw:filingDate}",
    urlTemplate: "https://www.sec.gov/Archives/edgar/data/1/{compact:accessionNumber}/{primaryDocument}",
    publishedAtPath: "filingDate",
    includeValues: { path: "form", values: ["8-K", "6-K"] },
  });
  assert.doesNotThrow(() => assertSupportedConfig("json_list", row.config));
  const columns = {
    form: ["8-K", "4"],
    filingDate: ["2026-10-08", "2026-10-09"],
    accessionNumber: ["0000000001-26-000001", "0000000001-26-000002"],
    primaryDocument: ["notice.htm", "ownership.xml"],
  };
  const parse = (value: unknown) => jsonListDocument(JSON.stringify({ filings: { recent: value } }), row, "2026-10-14T00:00:00Z");
  const results = parse(columns);
  assert.equal(results.items.length, 2);
  assert.equal(results.candidates.length, 1);
  assert.equal(results.candidates[0].title, "Company · 8-K · 2026-10-08");
  assert.equal(results.candidates[0].url, "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/notice.htm");
  assert.throws(() => parse({ ...columns, filingDate: ["2026-10-08"] }), /column/);
  assert.throws(() => parse({ ...columns, form: "8-K" }), /column/);
});

test("configured source timezone resolves a list timestamp without assuming a timezone for other sources", () => {
  const config = { url: "https://exchange.example/news", titlePaths: ["title"], urlTemplate: "https://exchange.example/{id}", publishedAtPath: "published" };
  const body = JSON.stringify([{ id: "1", title: "公告", published: "2026-10-08 09:30:00" }]);
  const without = jsonListDocument(body, source("json_list", config), "2026-10-14T00:00:00Z").candidates[0];
  assert.equal(without.publishedAt?.toISOString(), "2026-10-07T16:00:00.000Z");
  assert.equal(previewSourceDate(without.sourceDateObservation!)?.utc, null);
  const declared = source("json_list", {
    ...config,
    sourceDate: { format: "iso8601", timezone: "Asia/Shanghai", timezoneEvidence: "Fixture official exchange timezone declaration" },
  });
  const withZone = jsonListDocument(body, declared, "2026-10-14T00:00:00Z").candidates[0];
  assert.equal(withZone.publishedAt?.toISOString(), "2026-10-08T01:30:00.000Z");
});

test("an unzoned JSON timestamp retains its calendar date without inventing an instant", () => {
  const row = source("json_list", {
    url: "https://company.example/news",
    titlePaths: ["title"],
    urlTemplate: "https://company.example/{id}",
    publishedAtPath: "date",
  });
  const [item] = jsonListDocument(JSON.stringify([{ title: "矿企公告", id: 1, date: "2026-10-08 10:30:00" }]), row, "2026-10-14T00:00:00Z").candidates;
  assert.equal(item.publishedAt?.toISOString(), "2026-10-07T16:00:00.000Z");
  const time = previewSourceDate(item.sourceDateObservation!);
  assert.equal(time?.local_date, "2026-10-08");
  assert.equal(time?.precision, "date");
  assert.equal(time?.utc, null);
  assert.equal(time?.local_time, null);
});

test("an item holding its record as a JSON string is parsed before paths, filters and title templates read it (TASK-0603)", () => {
  const row = source("json_list", {
    url: "https://registry.example/search",
    itemsPath: "results",
    itemJsonPath: "abstract",
    includeValues: { path: "meta.kind", values: ["legislation"] },
    titleTemplate: [
      "{raw:content.type} {raw:content.number} ({raw:content.province}) — {raw:content.title}",
      "{raw:content.type} {raw:content.number} — {raw:content.title}",
    ],
    titlePaths: ["content.subject"],
    urlTemplate: "https://registry.example/{meta.slug}/{meta.id}",
    externalIdPath: "meta.id",
    publishedAtPath: "content.date",
  });
  assert.doesNotThrow(() => assertSupportedConfig("json_list", row.config));
  const record = (meta: Record<string, unknown>, content: Record<string, unknown>) => ({ score: 1, abstract: JSON.stringify({ meta, content }) });
  const body = (results: unknown[]) => JSON.stringify({ results });
  const parsed = jsonListDocument(
    body([
      record(
        { kind: "legislation", slug: "9739-local-mendoza", id: "u-1" },
        { type: "Ley", number: 9739, province: "Mendoza", title: "Cobre", date: "2026-10-21" },
      ),
      record({ kind: "legislation", slug: "1304-nacional", id: "u-2" }, { type: "Decreto", number: 1304, title: "Renuncia", date: "2026-10-29" }),
      record({ kind: "legislation", slug: "rs-5909", id: "u-3" }, { type: "Resolución", subject: "Régimen minero", date: "2026-10-01" }),
      record({ kind: "jurisprudencia", slug: "fallo", id: "u-4" }, { type: "Sentencia", number: 1, title: "Fallo", date: "2026-10-30" }),
      { score: 1, abstract: "{not json" },
      { score: 1 },
    ]),
    row,
    "2026-11-10T00:00:00Z",
  ).candidates;
  assert.deepEqual(
    parsed.map((c) => [c.title, c.url, c.sourceDateObservation?.raw, (c.raw as { externalId: unknown }).externalId]),
    [
      ["Ley 9739 (Mendoza) — Cobre", "https://registry.example/9739-local-mendoza/u-1", "2026-10-21", "u-1"],
      ["Decreto 1304 — Renuncia", "https://registry.example/1304-nacional/u-2", "2026-10-29", "u-2"],
      ["Régimen minero", "https://registry.example/rs-5909/u-3", "2026-10-01", "u-3"],
    ],
    "court rulings are filtered out; malformed or missing strings are skipped; the first complete template wins",
  );
  assert.match(parsed[0]!.sourceDateObservation!.locator, /^json\.items\[0\]\.abstract\(json\)\.content\.date$/);
  // A page where no item carries a parsable record is a failure, not an empty listing, even with a filter configured.
  assert.throws(() => jsonListDocument(body([{ abstract: "[1]" }, { abstract: 3 }]), row, "2026-11-10T00:00:00Z"), /no item carried JSON at abstract/);
  for (const titleTemplate of ["", [], [""], ["{a}", 3]])
    assert.throws(() => assertSupportedConfig("json_list", { ...row.config, titleTemplate }), /titleTemplate/, JSON.stringify(titleTemplate));
  assert.throws(() => assertSupportedConfig("json_list", { ...row.config, itemJsonPath: "" }), /itemJsonPath/);
  assert.throws(() => assertSupportedConfig("rss", { feedUrl: "https://registry.example/feed", itemJsonPath: "abstract" }), /itemJsonPath/);
});
