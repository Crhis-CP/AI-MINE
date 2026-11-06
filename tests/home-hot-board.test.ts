// The homepage hotspot board is a reader-visible section above the featured list.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the hotspot board is rendered above the featured list", () => {
  const home = readFileSync(new URL("../apps/web/app/routes/home.tsx", import.meta.url), "utf8");
  const board = readFileSync(new URL("../apps/web/app/features/feed/HotTopics.tsx", import.meta.url), "utf8");
  const hotAt = home.indexOf("<HotTopics");
  const filters = readFileSync(new URL("../apps/web/app/features/feed/Filters.tsx", import.meta.url), "utf8");
  // The featured title (h1) lives in FeedToolbar since the UI update of 2026-11-05.
  const featuredTitle = home.indexOf("<FeedToolbar");
  assert.match(filters, /export function FeedToolbar[\s\S]*?<h1/);
  const featuredList = home.indexOf("<Timeline");
  assert.ok(hotAt >= 0, "首页渲染热点榜");
  assert.ok(featuredTitle > hotAt, "热点榜在精选标题上面");
  assert.ok(home.indexOf("<FeedBar") < hotAt, "手机入口在热点榜上面，热点榜仍在资讯列表前");
  assert.ok(featuredList > hotAt, "精选列表仍在热点榜下面");
  assert.equal(home.indexOf("<HotTopics"), home.lastIndexOf("<HotTopics"));
  assert.match(home, /cards=\{data\.cards\}/);
  // Reader copy moved to the Chinese dictionary with the bilingual base (DEC-78).
  const zh = readFileSync(new URL("../apps/web/app/i18n/zh.ts", import.meta.url), "utf8");
  assert.match(zh, /title: "热点榜"/);
  assert.match(zh, /emptyTitle: "暂时没有热点"/);
  assert.match(zh, /还没有足够多来源共同讨论的事件/);
  assert.match(zh, /另有 \{count\} 家来源/);
  assert.match(board, /entries\.length === 0 \?/);
  assert.match(board, /e\.heat > 0/);
  assert.doesNotMatch(board, /if \(entries\.length === 0\) return null/);
});
