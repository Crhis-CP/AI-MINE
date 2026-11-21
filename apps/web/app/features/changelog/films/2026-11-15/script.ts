// The 2026-11-14/15 update as a short film (TASK-0367, Owner 2026-11-21: “真实数据那种”“点开能看”). Read on the server
// with its recording (recordings.server.ts) and sent with the page's data. Its figures are the recording beside it (snapshot.json, captured 2026-11-22 03:08 Beijing time by scripts/changelog-film-snapshot.ts); each scene's
// change is told in its own text, so the entry's lines keep to what the film does not show.
import type { Script } from "../../player/types";

export const FILM_20261115: Script = {
  title: "首页先看本国，还有金属走势、热点榜和法规页新版式",
  scenes: [
    { kind: "title", ms: 3500, heading: "这次更新" },
    {
      kind: "feed",
      ms: 8000,
      heading: "首页先看本国",
      text: "在中国或阿根廷打开首页，先看到本国最新的 5 条动态，也可以换国家或选“全球”。",
      to: "/",
    },
    {
      kind: "trend",
      ms: 7000,
      heading: "金属走势线",
      text: "每种金属多了一条走势线，只用官方公布的每一期价格，不补数、不估算。",
      to: "/metals",
    },
    {
      kind: "count",
      ms: 5500,
      heading: "热点榜",
      text: "热点榜每天统计最近 72 小时内被多家独立来源报道的矿业事件，不再分周几。",
      to: "/hot",
    },
    {
      kind: "sideBySide",
      ms: 6000,
      heading: "法规页解读与原文并排",
      text: "法规页左边是解读、右边是原文，点条款号就跳到原文那一条。",
      to: "/policies",
    },
    { kind: "outro", ms: 4000, heading: "打开看看" },
  ],
};
