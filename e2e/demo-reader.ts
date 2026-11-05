// Demo reader data for the local demo API (e2e/demo-api.ts): synthetic, labelled as demo content, and
// parsed through the public contracts at import so any contract drift fails here first. No production data,
// no real company or person, no filing numbers.
import { ContentVersion, PoolResponse, SearchSuggestions, SiteInformation, SiteMeta, SiteStats, TimelineResponse } from "@amp/contracts/http/public";
import { FIXED_TIME } from "./time.ts";

const at = (minutesAgo: number) => new Date(Date.parse(FIXED_TIME) - minutesAgo * 60_000).toISOString();

type Seed = {
  id: string;
  title: string;
  summary: string;
  reason: string | null;
  source: string;
  category: string;
  tags: string[];
  selected: boolean;
  ago: number;
};
const SEEDS: Seed[] = [
  {
    id: "demo-royalty",
    title: "示例：某国修订矿业特许权费规则，铜、锂项目适用新税率",
    summary: "演示数据。新规按金属价格分档征收特许权费，已投产项目设两年过渡期，新项目自明年起适用。",
    reason: "直接改变在产与在建项目的税费测算。",
    source: "演示来源·政府公报",
    category: "policy_regulation",
    tags: ["铜", "锂"],
    selected: true,
    ago: 35,
  },
  {
    id: "demo-brine",
    title: "示例：南美一处锂盐湖项目完成扩产环评公示",
    summary: "演示数据。扩产后碳酸锂产能计划翻倍，公示期内接受社区与机构意见。",
    reason: "扩产节奏影响明后两年的供应预期。",
    source: "演示来源·项目公告",
    category: "company_project",
    tags: ["锂"],
    selected: true,
    ago: 80,
  },
  {
    id: "demo-copper-price",
    title: "示例：铜价连续三周上涨，冶炼加工费降至年内低位",
    summary: "演示数据。精矿供应偏紧叠加需求回暖，现货加工费继续下行。",
    reason: null,
    source: "演示来源·市场周报",
    category: "commodity_market",
    tags: ["铜"],
    selected: false,
    ago: 140,
  },
  {
    id: "demo-export",
    title: "示例：某国调整稀土中间品出口许可程序",
    summary: "演示数据。新增最终用户声明要求，审批时限延长至四十五个工作日。",
    reason: "出口审批变化牵动下游采购安排。",
    source: "演示来源·商务部门",
    category: "supply_trade_controls",
    tags: ["稀土"],
    selected: true,
    ago: 210,
  },
  {
    id: "demo-merger",
    title: "示例：两家中型矿企宣布换股合并，组建多金属平台",
    summary: "演示数据。合并后在三个国家持有在产矿山，交易尚需股东大会与监管批准。",
    reason: null,
    source: "演示来源·交易所公告",
    category: "capital_ma",
    tags: ["金", "铜"],
    selected: false,
    ago: 300,
  },
  {
    id: "demo-safety",
    title: "示例：一处地下金矿完成通风系统升级并恢复满负荷生产",
    summary: "演示数据。停产检修历时六周，主管部门复查后准予恢复。",
    reason: null,
    source: "演示来源·安全监管",
    category: "safety_incident",
    tags: ["金"],
    selected: false,
    ago: 420,
  },
];

const summary = (s: Seed) => ({
  id: s.id,
  title: s.title,
  summary: s.summary,
  reason: s.reason,
  publishedAt: at(s.ago),
  timelineAt: at(s.ago),
  category: s.category,
  tags: s.tags,
  score: null,
  selected: s.selected,
  channel: "news" as const,
  source: { name: s.source },
});

export const DEMO_ITEMS = SEEDS.map(summary);

export const demoMeta = SiteMeta.parse({ changelogVersion: null, filings: { icp: null, publicSecurity: null, newsLicense: null } });
export const demoContentVersion = ContentVersion.parse({ version: "demo-1", withdrawalVersion: "demo-1" });

export function demoTimeline(filters: { channel: string; category: string | null }) {
  const cards = DEMO_ITEMS.filter((item) => !filters.category || item.category === filters.category).map((item, index) => ({
    key: item.id,
    anchorAt: item.timelineAt,
    item,
    group:
      index === 0 ? { factId: "demo-fact-royalty", story: null, additionalSourceCount: 2, reportCount: 3, developmentCount: 1, memberIds: [item.id] } : null,
  }));
  return TimelineResponse.parse({
    filters: { channel: filters.channel, category: filters.category, tag: null, topic: null, jurisdiction: null },
    cards,
    nextCursor: null,
    refreshAt: null,
    hot: [
      { rank: 1, title: "示例：特许权费新规引发多家矿企重估项目", heat: 92, trend: "up", storyPublicId: null, itemId: "demo-royalty" },
      { rank: 2, title: "示例：锂盐湖扩产进入公示", heat: 71, trend: "new", storyPublicId: null, itemId: "demo-brine" },
      { rank: 3, title: "示例：铜冶炼加工费降至年内低位", heat: 64, trend: "flat", storyPublicId: null, itemId: "demo-copper-price" },
    ],
    dayCounts: {},
    generatedAt: FIXED_TIME,
  });
}

export function demoPool(filters: { channel: string; category: string | null; q: string | null; tab: "time" | "relevance" }) {
  const items = DEMO_ITEMS.filter((item) => !filters.category || item.category === filters.category);
  return PoolResponse.parse({
    filters: { channel: filters.channel, category: filters.category, tag: null, topic: null, q: filters.q, tab: filters.tab },
    items,
    page: 1,
    pageCount: 1,
    total: items.length,
    todayCount: items.length,
    freshness: FIXED_TIME,
    generatedAt: FIXED_TIME,
  });
}

export const demoStats = SiteStats.parse({
  sources: 455,
  sourceKinds: { web_list: 317, rss: 120, json_list: 18 },
  heatOnlySources: 0,
  items: DEMO_ITEMS.length,
  selected: DEMO_ITEMS.filter((item) => item.selected).length,
  dailies: 1,
  day: { collected: DEMO_ITEMS.length, selected: 3 },
  sampleSources: [
    { name: "演示来源·政府公报", kind: "web_list", heatOnly: false },
    { name: "演示来源·项目公告", kind: "rss", heatOnly: false },
    { name: "演示来源·市场周报", kind: "json_list", heatOnly: false },
  ],
  latest: DEMO_ITEMS.slice(0, 3).map((item) => ({ id: item.id, title: item.title, source: item.source.name })),
});

export const demoInformation = SiteInformation.parse({
  about: "本地演示：把分散的矿业报道整理成中文，保留来源和原文，方便继续核对。页面内容均为演示数据。",
  contactEmail: null,
  contactPage: null,
  metalLinks: [],
  revision: 1,
  updatedAt: null,
});

export const demoSuggestions = SearchSuggestions.parse({
  topics: [{ slug: "lithium", name: "锂", group: "field" }],
  hot: [{ rank: 1, title: "示例：特许权费新规引发多家矿企重估项目", to: "/story/demo-royalty" }],
});

/** Synthetic per-country news counts for the world map and the country filter (演示数据). */
const DEMO_COUNTRY_COUNTS: Array<[string, string, number]> = [
  ["CN", "中国", 46],
  ["AU", "澳大利亚", 31],
  ["CL", "智利", 24],
  ["AR", "阿根廷", 21],
  ["CD", "刚果（金）", 17],
  ["ID", "印度尼西亚", 15],
  ["PE", "秘鲁", 13],
  ["CA", "加拿大", 12],
  ["US", "美国", 11],
  ["ZA", "南非", 9],
  ["KZ", "哈萨克斯坦", 6],
  ["MN", "蒙古", 5],
  ["ZM", "赞比亚", 5],
  ["RU", "俄罗斯", 4],
  ["BO", "玻利维亚", 3],
  ["ZW", "津巴布韦", 3],
  ["GH", "加纳", 2],
  ["SG", "新加坡", 1],
];
export const demoJurisdictions = DEMO_COUNTRY_COUNTS.map(([code, label, news_count]) => ({
  code,
  label,
  kind: "country" as const,
  news_scope: true,
  policy_scope: true,
  news_count,
  policy_count: 0,
}));

/** Synthetic news map per window (演示数据): the last window beside the one before it. */
export function demoNewsMap(window: "1d" | "7d" | "30d", now = new Date()) {
  const days = { "1d": 1, "7d": 7, "30d": 30 }[window];
  const scale = { "1d": 0.08, "7d": 0.35, "30d": 1 }[window];
  const shift: Record<string, number> = { CL: 2.2, ID: 1.9, CD: 1.6, AU: 0.7, US: 0.6 };
  const countries = DEMO_COUNTRY_COUNTS.map(([code, label, total]) => {
    const count = Math.round(total * scale * (shift[code] ?? 1));
    const previous = Math.round(total * scale);
    return { code, label, count, previous };
  })
    .filter((c) => c.count > 0 || c.previous > 0)
    .sort((a, b) => b.count - a.count || b.previous - a.previous);
  return { window, from: new Date(now.getTime() - days * 86_400_000).toISOString(), to: now.toISOString(), countries };
}
