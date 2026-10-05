// A web listing whose list HTML arrives inside JSON (the column pages of MOFCOM's commercial offices
// abroad declare a page unit that answers {"data":{"html":"<ul>…"}}): htmlJsonPath reads that string and the
// usual selectors parse it; links resolve against baseUrl, the column page. A listing that is not JSON, or
// has no string at the path, fails the fetch instead of passing as empty. Titles and links are made up.
import "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@amp/backend/config";
import { fetchWebList } from "@amp/backend/sources/web-list";
import { sourceDateConfigHash, unsupportedConfig } from "@amp/backend/sources/config-keys";

const LIST =
  `<style>.pagination{display:block}</style><div id="信息列表"><div class="page-content"><ul class="txtList_01">` +
  `<li><a href="/jmxw/art/2026/art_0001.html" target="_blank">某国调整铜精矿出口政策</a><span>2026-08-06 18:42:37</span></li>` +
  `<li><a href="/jmxw/art/2026/art_0002.html" target="_blank">某国收回未使用的钴出口配额</a><span>[2026-07-02]</span></li>` +
  `</ul></div><div class="pagination" rows="15" count="417" pageNo="1"></div></div>`;
const pages: Record<string, string> = {
  "/unit": JSON.stringify({ success: true, code: "200", data: { html: LIST } }),
  "/not-json": `<html><body>${LIST}</body></html>`,
  "/no-html": JSON.stringify({ success: false, data: null }),
};
const server = http.createServer((req, res) => {
  const body = pages[(req.url ?? "").split("?")[0]!];
  res.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json;charset=UTF-8" });
  res.end(body ?? "");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const listing = (path: string, extra: Record<string, unknown> = {}) => ({
  url: `${base}${path}?parseType=bulidstatic&pageId=fc8bdff4`,
  baseUrl: "https://cd.mofcom.gov.cn/jmxw/index.html",
  language: "zh-CN",
  htmlJsonPath: "data.html",
  itemSelector: "ul.txtList_01 li",
  linkSelector: "a[href]",
  publishedAtRegex: "<span>\\s*\\[?(\\d{4}-\\d{2}-\\d{2})",
  ...extra,
});
const source = (config: Record<string, unknown>) => ({ id: "test-json-html", kind: "web_list", config }) as never;

test("htmlJsonPath: the list HTML inside JSON parses with the usual selectors, links against baseUrl", async () => {
  assert.deepEqual(unsupportedConfig("web_list", listing("/unit")), []);
  const items = await fetchWebList(source(listing("/unit")));
  assert.deepEqual(
    items.map((c) => [c.url, c.title]),
    [
      ["https://cd.mofcom.gov.cn/jmxw/art/2026/art_0001.html", "某国调整铜精矿出口政策"],
      ["https://cd.mofcom.gov.cn/jmxw/art/2026/art_0002.html", "某国收回未使用的钴出口配额"],
    ],
  );
  // Either way of writing the day is the list date; a day without a declared time zone stays a day.
  assert.deepEqual(
    items.map((c) => [c.sourceDateObservation?.raw, c.publishedAt]),
    [
      ["2026-08-06", null],
      ["2026-07-02", null],
    ],
  );
});

test("htmlJsonPath: a listing that is not JSON, or has no string at the path, fails the fetch", async () => {
  await assert.rejects(fetchWebList(source(listing("/not-json"))), /not JSON/);
  await assert.rejects(fetchWebList(source(listing("/no-html"))), /no string at data\.html/);
});

test("htmlJsonPath only with a direct JSON listing and a named page: through Jina, as Markdown, empty or without baseUrl it is refused", () => {
  assert.deepEqual(unsupportedConfig("web_list", listing("/unit", { url: "https://r.jina.ai/https://www.mofcom.gov.cn/unit" })), ["htmlJsonPath+jina"]);
  assert.deepEqual(unsupportedConfig("web_list", listing("/unit", { parseMode: "markdown" })), ["htmlJsonPath+parseMode=markdown"]);
  assert.deepEqual(unsupportedConfig("web_list", listing("/unit", { htmlJsonPath: "" })), ["htmlJsonPath"]);
  assert.deepEqual(unsupportedConfig("web_list", listing("/unit", { htmlJsonPath: 3 })), ["htmlJsonPath"]);
  assert.deepEqual(unsupportedConfig("web_list", listing("/unit", { baseUrl: undefined })), ["htmlJsonPath without baseUrl"]);
});

test("htmlJsonPath decides where list dates come from, so it is part of the date configuration hash", () => {
  assert.notEqual(sourceDateConfigHash("web_list", listing("/unit")), sourceDateConfigHash("web_list", listing("/unit", { htmlJsonPath: "data.body" })));
});
