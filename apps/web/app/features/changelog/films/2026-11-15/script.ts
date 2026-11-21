// The 2026-11-14/15 update as a short film (TASK-0367, Owner 2026-11-21: “真实数据那种”“点开能看”). Read on the server
// with its recording (recordings.server.ts) and sent with the page's data. Its figures are the recording beside it (snapshot.json, captured 2026-11-21 by scripts/changelog-film-snapshot.ts); each scene's
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
      text: "在中国或阿根廷打开首页，顶部先是本国最新的 5 条动态；在中国还可以把本省的排在最前面，也可以换国家或选“全球”；中国和阿根廷还有了各自的动态页。",
      to: "/",
    },
    {
      kind: "trend",
      ms: 7000,
      heading: "金属走势线",
      text: "金属价格页每种金属下面多了一条走势线，按住可以看某一期的价格，手机上也能完整显示日期和价格；只用官方已经公布的每一期价格，不补数、不估算。",
      to: "/metals",
    },
    {
      kind: "count",
      ms: 5500,
      heading: "热点榜",
      text: "热点榜不再分周几，每天都统计最近 72 小时内被多家独立来源报道的矿业事件；符合条件的全部列出，不够也不凑数。",
      to: "/hot",
    },
    {
      kind: "sideBySide",
      ms: 6000,
      heading: "法规页解读与原文并排",
      text: "法规页改成左边解读、右边原文：点条款号，原文跳到那一条；有上一版时可以看修订痕迹；手机上分成“解读”和“原文”两个标签。",
      to: "/policies",
    },
    { kind: "outro", ms: 4000, heading: "打开看看" },
  ],
};
