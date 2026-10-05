// A web listing whose list HTML arrives inside JSON (MOFCOM's page units answer {"data":{"html":"<ul>…"}}):
// htmlJsonPath reads that string and the usual selectors parse it; links resolve against baseUrl. A
// listing that is not JSON, or has no string at the path, fails the fetch instead of passing as empty.
import "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@amp/backend/config";
import { fetchWebList } from "@amp/backend/sources/web-list";
import { sourceDateConfigHash, unsupportedConfig } from "@amp/backend/sources/config-keys";

const LIST =
  `<style>.pagination{display:block}</style><div id="分页列表"><ul class="txtList_01">` +
  `<li><a href="/zwgk/zcfb/art/2026/art_97459d25.html" title="商务部公告2026年第44号 公布对原产于欧盟的进口对硝基甲苯发起反倾销立案调查" target="_blank">商务部公告2026年第44号 公布对原产于欧盟的进口对硝基甲苯发起反倾销立案调查</a><span>[2026-10-03]</span></li>` +
  `<li><a href="/zwgk/zcfb/art/2026/art_4a7a0cc4.html" title="商务部办公厅关于做好2027年度汽车和摩托车出口许可申报工作的通知" target="_blank">商务部办公厅关于做好2027年度汽车和摩托车出口许可申报工作的通知</a><span>[2026-09-30]</span></li>` +
  `</ul></div>`;
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
  baseUrl: "https://www.mofcom.gov.cn/",
  language: "zh-CN",
  htmlJsonPath: "data.html",
  itemSelector: "ul.txtList_01 li",
  linkSelector: "a[href]",
  publishedAtRegex: "<span>\\[(\\d{4}-\\d{2}-\\d{2})\\]</span>",
  ...extra,
});
const source = (config: Record<string, unknown>) => ({ id: "test-json-html", kind: "web_list", config }) as never;

test("htmlJsonPath: the list HTML inside JSON parses with the usual selectors, links against baseUrl", async () => {
  assert.deepEqual(unsupportedConfig("web_list", listing("/unit")), []);
  const items = await fetchWebList(source(listing("/unit")));
  assert.deepEqual(
    items.map((c) => [c.url, c.title]),
    [
      ["https://www.mofcom.gov.cn/zwgk/zcfb/art/2026/art_97459d25.html", "商务部公告2026年第44号 公布对原产于欧盟的进口对硝基甲苯发起反倾销立案调查"],
      ["https://www.mofcom.gov.cn/zwgk/zcfb/art/2026/art_4a7a0cc4.html", "商务部办公厅关于做好2027年度汽车和摩托车出口许可申报工作的通知"],
    ],
  );
  // The day inside the brackets is the list date; a day without a time stays a day (no exact time).
  assert.deepEqual(
    items.map((c) => [c.sourceDateObservation?.raw, c.publishedAt]),
    [
      ["2026-10-03", null],
      ["2026-09-30", null],
    ],
  );
});

test("htmlJsonPath: a listing that is not JSON, or has no string at the path, fails the fetch", async () => {
  await assert.rejects(fetchWebList(source(listing("/not-json"))), /not JSON/);
  await assert.rejects(fetchWebList(source(listing("/no-html"))), /no string at data\.html/);
});

test("htmlJsonPath only with a direct JSON listing: through Jina, as Markdown or empty it is refused", () => {
  assert.deepEqual(unsupportedConfig("web_list", listing("/unit", { url: "https://r.jina.ai/https://www.mofcom.gov.cn/unit" })), ["htmlJsonPath+jina"]);
  assert.deepEqual(unsupportedConfig("web_list", listing("/unit", { parseMode: "markdown" })), ["htmlJsonPath+parseMode=markdown"]);
  assert.deepEqual(unsupportedConfig("web_list", listing("/unit", { htmlJsonPath: "" })), ["htmlJsonPath"]);
  assert.deepEqual(unsupportedConfig("web_list", listing("/unit", { htmlJsonPath: 3 })), ["htmlJsonPath"]);
});

test("htmlJsonPath decides where list dates come from, so it is part of the date configuration hash", () => {
  assert.notEqual(sourceDateConfigHash("web_list", listing("/unit")), sourceDateConfigHash("web_list", listing("/unit", { htmlJsonPath: "data.body" })));
});
