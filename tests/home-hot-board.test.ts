// The homepage hotspot board is a reader-visible section above the featured list.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the hotspot board is rendered above the featured list", () => {
  const home = readFileSync(new URL("../apps/web/app/routes/home.tsx", import.meta.url), "utf8");
  const board = readFileSync(new URL("../apps/web/app/features/feed/HotTopics.tsx", import.meta.url), "utf8");
  const hotAt = home.indexOf("<HotTopics");
  const featuredTitle = home.indexOf("<h1");
  const featuredList = home.indexOf("<Timeline");
  assert.ok(hotAt >= 0, "首页渲染热点榜");
  assert.ok(featuredTitle > hotAt, "热点榜在精选标题上面");
  assert.ok(home.indexOf("<FeedBar") < hotAt, "手机入口在热点榜上面，热点榜仍在资讯列表前");
  assert.ok(featuredList > hotAt, "精选列表仍在热点榜下面");
  assert.equal(home.indexOf("<HotTopics"), home.lastIndexOf("<HotTopics"));
  assert.match(home, /cards=\{data\.cards\}/);
  assert.match(board, /热点榜/);
  assert.match(board, /暂时没有热点/);
  assert.match(board, /还没有足够多来源共同讨论的事件/);
  assert.match(board, /另有 \$\{others\} 家来源/);
  assert.match(board, /e\.heat > 0/);
  assert.doesNotMatch(board, /if \(entries\.length === 0\) return null/);
});
