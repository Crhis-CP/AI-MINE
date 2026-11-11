// A source can name the element holding its text version when the page shows it only after a script runs
// (TASK-0598). 福建省住建厅的文件页把“文字版”放在 style="display: none" 的元素里，页面打开时只显示扫描件
// “全真版”，所以正文读取只拿到页脚，稿件一直只有标题。合成页面，结构仿照该模板，不含真实来源内容。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { readable } from "../packages/backend/src/content/extract.ts";
import { unsupportedConfig } from "../packages/backend/src/sources/config-keys.ts";

const paragraph =
  "为推进示例工作，现将有关事项通知如下：一、各单位按照本通知要求组织实施，并及时报送进展情况，发现问题及时反馈。二、相关费用标准另行通知。三、本通知自发布之日起施行。";
const page = (wordStyle: string, inner = `<p>各有关单位：</p><p>${paragraph}</p><p>${paragraph}</p><p>${paragraph}</p>`) =>
  `<html><head><title>关于示例事项的通知_福建省示例厅</title></head><body>
<div class="nav"><a href="/">首页</a><a href="/zwgk/">政务公开</a></div>
<div class="tab_base_01"><div class="tabs_content tabs_bd">
  <div class="pic_con"><iframe class="isofd" src="/viewer.html"></iframe></div>
  <div class="word_con" ms-visible="show==false"${wordStyle}><div class="article_content">${inner}</div></div>
</div></div>
<div class="footer"><p>主办：福建省示例厅 承办：示例信息中心</p><p>为确保最佳浏览效果，建议您使用以下浏览器版本：IE浏览器9.0版本及以上；Google Chrome浏览器63版本及以上。</p></div>
</body></html>`;
const reveal = ["div.tabs_bd > div.word_con"];

test("a declared text version hidden until a script runs is read; without the declaration it stays hidden", () => {
  const html = page(' style="display: none;"');
  assert.equal(readable(html, "https://zjt.fujian.gov.cn/xxgk/a.htm"), null, "the footer alone is no body");
  const got = readable(html, "https://zjt.fujian.gov.cn/xxgk/a.htm", { reveal });
  assert.ok(got);
  assert.match(got.text, /各有关单位：/);
  assert.match(got.text, /本通知自发布之日起施行/);
  assert.doesNotMatch(got.text, /建议您使用以下浏览器版本/);
});

test("only the matched element is revealed: other inline styles stay and its hidden children stay hidden", () => {
  const inner = `<p>${paragraph}</p><p>${paragraph}</p><p>${paragraph}</p><p hidden>隐藏的批注不应出现</p><p style="display:none">另一段隐藏文字</p>`;
  const got = readable(page(' hidden style="DISPLAY: none !important; color: red"', inner), "https://zjt.fujian.gov.cn/xxgk/b.htm", { reveal });
  assert.ok(got);
  assert.match(got.text, /本通知自发布之日起施行/);
  assert.doesNotMatch(got.text, /隐藏的批注不应出现|另一段隐藏文字/);
  assert.equal(readable(page(' style="display: none;"'), "https://zjt.fujian.gov.cn/xxgk/c.htm", { reveal: ["div.no-such-element"] }), null);
});

test("detail.reveal is a short list of selectors; the configured source passes the config check", () => {
  assert.deepEqual(unsupportedConfig("web_list", { detail: { reveal } }), []);
  for (const bad of [[], [""], "div.word_con", Array.from({ length: 11 }, (_, i) => `div.c${i}`)])
    assert.ok(unsupportedConfig("web_list", { detail: { reveal: bad } }).includes("detail.reveal"), JSON.stringify(bad));
  const sources = JSON.parse(readFileSync(new URL("../industry/sources.json", import.meta.url), "utf8")).sources as Array<{
    id: string;
    kind: "web_list";
    config: Record<string, unknown>;
  }>;
  const housing = sources.find((s) => s.id === "fj-housing-news")!;
  assert.deepEqual((housing.config.detail as { reveal?: string[] }).reveal, reveal);
  assert.deepEqual(unsupportedConfig(housing.kind, housing.config), []);
});
