import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fromHtml } from "@amp/backend/sources/web-list";
import type { SourceRow } from "../packages/backend/src/sources/types.ts";

test("Jilin HRSS nested duplicate anchors retain the nonempty title, original date and same-site link", () => {
  const catalogue = JSON.parse(readFileSync(new URL("../industry/sources.json", import.meta.url), "utf8"));
  const source = catalogue.sources.find((row: { id: string }) => row.id === "hrss-jl-news") as SourceRow;
  const html = `<div class="wang-left-top1-rig"><div id="tabBox1"><div class="tabCon"><div class="tCon"><ul>
    <li><a href="./gzdt/202610/t20261012_1.html"><a href="./gzdt/202610/t20261012_1.html">合成工作动态标题</a></a><p>[2026-10-12]</p></li>
    <li><a href="./gzdt/202610/t20261011_2.html">正常单层标题</a><p>[2026-10-11]</p></li>
    <li><a href="https://other.invalid/item">站外视频不进入本源</a><p>[2026-10-10]</p></li>
    <li><a href="./empty.html"></a><p>[2026-10-09]</p></li>
    </ul></div></div></div></div>`;
  const before = { ...source, config: { ...source.config, linkSelector: "a[href]", titleSelector: "a" } };
  assert.equal(fromHtml(html, String(source.config.url), before).length, 1, "the previous selector loses the malformed nested item");
  const rows = fromHtml(html, String(source.config.url), source);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.title),
    ["合成工作动态标题", "正常单层标题"],
  );
  assert.equal(rows[0]!.url, "https://hrss.jl.gov.cn/gzdt/202610/t20261012_1.html");
  assert.equal(rows[0]!.sourceDateObservation?.raw, "2026-10-12");
});
