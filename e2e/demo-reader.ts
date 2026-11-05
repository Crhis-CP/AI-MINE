// Demo reader data for the local demo API (e2e/demo-api.ts): synthetic, labelled as demo content, and
// parsed through the public contracts at import so any contract drift fails here first. No production data,
// no real company or person, no filing numbers.
import {
  ContentVersion,
  Policy,
  PolicyCard,
  PolicyListResponse,
  PolicyReadingPage,
  PolicyScopeList,
  PoolResponse,
  SearchSuggestions,
  SiteInformation,
  SiteMeta,
  SiteStats,
  TimelineResponse,
} from "@amp/contracts/http/public";
import type { HotEntryView, HotResponse, ReportCitation, ReportDetail, ReportIndexEntry, ReportNavigationEntry } from "@amp/contracts/site";
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

/** One demo article page per demo card: synthetic body, outline and source link, so the reading page can be reviewed. */
export function demoItemDetail(id: string) {
  const item = DEMO_ITEMS.find((i) => i.id === id);
  if (!item) return null;
  return {
    ...item,
    revision: 1,
    originalTitle: null,
    source: { id: "demo-source", name: item.source.name, kind: "web_list", firstParty: true },
    links: { original: "https://example.invalid/demo-source" },
    discoveredAt: item.publishedAt,
    story: null,
    readingMode: "full",
    author: null,
    language: "zh",
    body: {
      zh: `<h2 id="s1">要点</h2><p>${item.summary}</p><p>演示数据。正文用于检查排版：段落宽度、行高、标题层级与引用样式。</p><h2 id="s2">背景</h2><p>演示数据。此处是第二节正文，说明事件背景和此前进展。</p><blockquote><p>演示数据。引用原文的一段话。</p></blockquote><h2 id="s3">影响</h2><p>演示数据。此处是第三节正文，说明对项目、价格或合规的影响。</p>`,
      original: null,
      zhKind: "original",
      complete: true,
    },
    outline: [
      { id: "s1", text: "要点", level: 2 },
      { id: "s2", text: "背景", level: 2 },
      { id: "s3", text: "影响", level: 2 },
    ],
    relatedStories: [],
    indexable: false,
    group: null,
    hasTranslation: false,
    bodyLanguage: "zh",
    companyContext: [],
    attribution: null,
    relatedPolicies: [],
  };
}

// ---------------------------------------------------------------------------
// Hot ranking (演示数据): eight synthetic events with heat, trend and a day of hourly heat.
// ---------------------------------------------------------------------------

type HotSeed = {
  id: string;
  title: string;
  summary: string;
  latest: string | null;
  heat: number;
  trend: HotEntryView["trend"];
  trendPct: number | null;
  badges: HotEntryView["badges"];
  sources: string[];
  sourceCount: number;
  participants: number;
  /** Rough shape of the day: heat 24 hours ago and now, and an optional bump. */
  from: number;
  bump?: number;
  firstAgo: number;
  latestAgo: number;
  itemId?: string;
};
const HOT_SEEDS: HotSeed[] = [
  {
    id: "demo-story-royalty",
    title: "示例：特许权费新规引发多家矿企重估在产项目",
    summary: "演示数据。新规按金属价格分档征收，多家中型矿企表示将重新测算铜、锂项目的税费与现金流，行业协会已提交书面意见。",
    latest: "演示数据。主管部门表示过渡期安排将另行发布实施细则。",
    heat: 92.4,
    trend: "up",
    trendPct: 38,
    badges: ["surge", "rising"],
    sources: ["演示来源·政府公报", "演示来源·行业协会"],
    sourceCount: 14,
    participants: 23,
    from: 18,
    firstAgo: 26 * 60,
    latestAgo: 35,
    itemId: "demo-royalty",
  },
  {
    id: "demo-story-brine",
    title: "示例：南美锂盐湖扩产进入环评公示",
    summary: "演示数据。项目扩产后碳酸锂产能计划翻倍，公示期内社区与机构可提交意见。",
    latest: "演示数据。当地社区组织申请延长公示期。",
    heat: 71.2,
    trend: "new",
    trendPct: null,
    badges: ["new"],
    sources: ["演示来源·项目公告", "演示来源·地方媒体"],
    sourceCount: 8,
    participants: 12,
    from: 0,
    firstAgo: 5 * 60,
    latestAgo: 80,
    itemId: "demo-brine",
  },
  {
    id: "demo-story-copper",
    title: "示例：铜冶炼加工费降至年内低位",
    summary: "演示数据。精矿供应偏紧叠加需求回暖，现货加工费连续三周下行。",
    latest: null,
    heat: 64.8,
    trend: "flat",
    trendPct: 2,
    badges: [],
    sources: ["演示来源·市场周报", "演示来源·价格机构"],
    sourceCount: 9,
    participants: 11,
    from: 60,
    bump: 12,
    firstAgo: 40 * 60,
    latestAgo: 140,
    itemId: "demo-copper-price",
  },
  {
    id: "demo-story-export",
    title: "示例：稀土中间品出口许可新增最终用户声明",
    summary: "演示数据。审批时限延长至四十五个工作日，下游采购方开始调整备货节奏。",
    latest: "演示数据。商务部门发布申请材料清单。",
    heat: 58.1,
    trend: "up",
    trendPct: 21,
    badges: ["rising"],
    sources: ["演示来源·商务部门", "演示来源·贸易周刊"],
    sourceCount: 7,
    participants: 10,
    from: 30,
    firstAgo: 20 * 60,
    latestAgo: 210,
    itemId: "demo-export",
  },
  {
    id: "demo-story-merger",
    title: "示例：两家中型矿企换股合并组建多金属平台",
    summary: "演示数据。合并后在三个国家持有在产矿山，交易尚需股东大会与监管批准。",
    latest: null,
    heat: 46.5,
    trend: "down",
    trendPct: -17,
    badges: [],
    sources: ["演示来源·交易所公告"],
    sourceCount: 5,
    participants: 7,
    from: 62,
    firstAgo: 44 * 60,
    latestAgo: 300,
    itemId: "demo-merger",
  },
  {
    id: "demo-story-safety",
    title: "示例：地下金矿完成通风系统升级后恢复满产",
    summary: "演示数据。停产检修历时六周，主管部门复查后准予恢复生产。",
    latest: null,
    heat: 38.9,
    trend: "flat",
    trendPct: -3,
    badges: [],
    sources: ["演示来源·安全监管", "演示来源·地方媒体"],
    sourceCount: 4,
    participants: 6,
    from: 40,
    bump: 6,
    firstAgo: 30 * 60,
    latestAgo: 420,
    itemId: "demo-safety",
  },
  {
    id: "demo-story-nickel",
    title: "示例：镍中间品库存连续两月回落",
    summary: "演示数据。冶炼厂检修叠加新能源需求恢复，港口库存降至季度低位。",
    latest: null,
    heat: 31.7,
    trend: "up",
    trendPct: 12,
    badges: [],
    sources: ["演示来源·市场周报"],
    sourceCount: 3,
    participants: 5,
    from: 22,
    firstAgo: 22 * 60,
    latestAgo: 9 * 60,
  },
  {
    id: "demo-story-water",
    title: "示例：一处铜矿尾矿库开展年度安全评估",
    summary: "演示数据。评估结果将在三十日内向社区公开，期间不影响正常生产。",
    latest: null,
    heat: 24.3,
    trend: "down",
    trendPct: -26,
    badges: [],
    sources: ["演示来源·环境部门"],
    sourceCount: 3,
    participants: 4,
    from: 36,
    firstAgo: 46 * 60,
    latestAgo: 16 * 60,
  },
];

/** Smooth hourly heat from `from` 24 hours ago to `to` now, with a small mid-day bump; nulls before a new story's first hour. */
function spark(seed: HotSeed): Array<number | null> {
  const firstHour = 23 - Math.floor(seed.firstAgo / 60);
  return Array.from({ length: 24 }, (_, h) => {
    if (h < firstHour) return null;
    const t = h / 23;
    const wave = (seed.bump ?? 4) * Math.sin(t * Math.PI * 2.2);
    return Math.max(0, Math.round((seed.from + (seed.heat - seed.from) * t * t + wave) * 10) / 10);
  });
}

export const demoHot = {
  computedAt: at(10),
  ruleVersion: "demo-1",
  windowHours: 48,
  entries: HOT_SEEDS.map((s, i) => ({
    rank: i + 1,
    story: { publicId: s.id, title: s.title },
    heat: s.heat,
    trend: s.trend,
    trendPct: s.trendPct,
    badges: s.badges,
    participantCount: s.participants,
    sourceCount: s.sourceCount,
    signalCount: s.participants * 3,
    reportCount: s.sourceCount + 2,
    sourceNames: s.sources,
    latestAt: at(s.latestAgo),
    firstReportAt: at(s.firstAgo),
    representative: s.itemId ? { id: s.itemId, url: `https://example.invalid/${s.itemId}`, sourceName: s.sources[0]! } : null,
    spark: spark(s),
    summary: s.summary,
    latest: s.latest,
  })),
} satisfies HotResponse;

// ---------------------------------------------------------------------------
// Daily report (演示数据): the latest issue built from the demo cards, and one earlier issue.
// ---------------------------------------------------------------------------

const DAILY_LATEST = "2026-10-04",
  DAILY_PREVIOUS = "2026-10-03";

function citation(id: string, role: string | null = null, sources = 3): ReportCitation {
  const item = DEMO_ITEMS.find((i) => i.id === id)!;
  return {
    itemId: item.id,
    title: item.title,
    summary: item.summary,
    sourceName: item.source.name,
    sourceUrl: `https://example.invalid/${item.id}`,
    sourceId: "demo-source",
    firstParty: role === "官方",
    role,
    storyPublicId: null,
    publishedAt: item.publishedAt,
    available: true,
    sources,
  };
}
const flash = (n: number, title: string, sourceName: string): ReportCitation => ({
  itemId: null,
  title,
  summary: null,
  sourceName,
  sourceUrl: `https://example.invalid/flash-${n}`,
  sourceId: null,
  firstParty: false,
  role: null,
  storyPublicId: null,
  publishedAt: null,
  available: true,
});

const latestSections = [
  {
    label: "政策与监管",
    summary: "演示数据。两项规则调整分别涉及特许权费与出口许可，影响在产项目测算和下游采购安排。",
    items: [citation("demo-royalty", "官方", 6), citation("demo-export", "官方", 4)],
  },
  {
    label: "企业与项目",
    summary: null,
    items: [citation("demo-brine", "官方", 3), citation("demo-merger", null, 2)],
  },
  { label: "市场与价格", summary: null, items: [citation("demo-copper-price", null, 5)] },
  { label: "安全与环境", summary: null, items: [citation("demo-safety", "官方", 2)] },
];

const dailyLatest: ReportDetail = {
  kind: "daily",
  key: DAILY_LATEST,
  title: "示例：特许权费新规落地，锂盐湖扩产进入公示",
  windowStart: "2026-10-03T00:00:00Z",
  windowEnd: "2026-10-04T00:00:00Z",
  generatedAt: "2026-10-04T00:00:00Z",
  firstPublishedAt: "2026-10-04T00:00:00Z",
  revision: 1,
  generationStatus: "ready",
  lead: {
    title: "示例：某国修订矿业特许权费规则，铜、锂项目适用新税率",
    leadParagraph:
      "演示数据。新规按金属价格分档征收特许权费，已投产项目设两年过渡期，新项目自明年起适用。多家矿企表示将重新测算在产与在建项目的税费，行业协会已提交书面意见。",
  },
  leadItemId: "demo-royalty",
  overview: "演示数据。本期收录 6 件大事：规则调整两项、项目进展两项、市场与安全各一项。",
  highlights: [citation("demo-brine", "官方", 3), citation("demo-export", "官方", 4), citation("demo-copper-price", null, 5)],
  sections: latestSections,
  stories: latestSections.flatMap((s) => s.items.map((c) => ({ ...c, label: s.label }))),
  flashes: [
    flash(1, "示例：一处铁矿港口恢复正常装船", "演示来源·港口通告"),
    flash(2, "示例：钴中间品报价小幅回升", "演示来源·价格机构"),
    flash(3, "示例：某勘探公司公布新一轮钻探结果", "演示来源·项目公告"),
  ],
  metrics: { totalEvents: 6, sourcesCount: 18, firstPartyEvents: 4 },
  readingMinutes: 6,
  prev: DAILY_PREVIOUS,
  next: null,
};

const previousSections = [
  {
    label: "企业与项目",
    summary: null,
    items: [
      {
        ...flash(11, "示例：一座露天铜矿完成扩建后首批精矿装运", "演示来源·项目公告"),
        summary: "演示数据。扩建后年产能提升约三成。",
        role: "官方",
        firstParty: true,
      },
      { ...flash(12, "示例：两家勘探公司签署联合开发协议", "演示来源·交易所公告"), summary: "演示数据。协议涉及一处稀土矿权的分阶段勘探。" },
    ],
  },
  {
    label: "市场与价格",
    summary: null,
    items: [{ ...flash(13, "示例：锂辉石报价企稳，下游询价增加", "演示来源·市场周报"), summary: "演示数据。现货成交量较上周回升。" }],
  },
];
const dailyPrevious: ReportDetail = {
  kind: "daily",
  key: DAILY_PREVIOUS,
  title: "示例：露天铜矿扩建投产，锂辉石报价企稳",
  windowStart: "2026-10-02T00:00:00Z",
  windowEnd: "2026-10-03T00:00:00Z",
  generatedAt: "2026-10-03T00:00:00Z",
  firstPublishedAt: "2026-10-03T00:00:00Z",
  revision: 1,
  generationStatus: "ready",
  lead: { title: "示例：一座露天铜矿完成扩建后首批精矿装运", leadParagraph: "演示数据。扩建后年产能提升约三成，首批精矿已运往港口。" },
  leadItemId: null,
  overview: null,
  highlights: [],
  sections: previousSections,
  stories: previousSections.flatMap((s) => s.items.map((c) => ({ ...c, label: s.label }))),
  flashes: [],
  metrics: { totalEvents: 3, sourcesCount: 7, firstPartyEvents: 1 },
  readingMinutes: 3,
  prev: null,
  next: DAILY_LATEST,
};

const DAILY_REPORTS = [dailyLatest, dailyPrevious];
export const demoDailyIndex: ReportNavigationEntry[] = DAILY_REPORTS.map((r) => ({
  key: r.key,
  title: r.title,
  count: r.stories.length,
}));
export const demoDailyArchive: ReportIndexEntry[] = DAILY_REPORTS.map((r) => ({
  key: r.key,
  title: r.title,
  generatedAt: r.generatedAt,
  count: r.stories.length,
}));
export const demoDailyLatestPage = { index: demoDailyIndex, report: dailyLatest };
export const demoDailyReport = (key: string) => DAILY_REPORTS.find((r) => r.key === key) ?? null;

// ---------------------------------------------------------------------------
// Policies (演示数据): five synthetic instruments across four jurisdictions; two with a complete
// interpretation and full reading, three with basic facts only. No real authority, no instrument numbers.
// ---------------------------------------------------------------------------

const TIME_BASIS = "演示数据：合成日期，不是真实法规记录";
type Meaning = "published" | "effective" | "deadline" | "applicable" | "updated";
const MEANING_LABEL: Record<Meaning, string> = { published: "来源发布", effective: "生效", deadline: "截止", applicable: "适用", updated: "来源更新" };
const day = (meaning: Meaning, date: string, condition: string | null = null) => ({
  raw: date,
  local_date: date,
  local_time: null,
  timezone: null,
  utc: null,
  precision: "date" as const,
  meaning,
  meaning_label: MEANING_LABEL[meaning],
  basis: TIME_BASIS,
  condition_text: condition,
  label: date,
  beijing_date: date,
});
/** A system time in Beijing, second precision: `utc` must be a whole-second instant. */
const instantAt = (meaning: "site_public" | "checked", utc: string) => {
  const local = new Date(Date.parse(utc) + 8 * 3_600_000).toISOString();
  return {
    raw: utc,
    local_date: local.slice(0, 10),
    local_time: local.slice(11, 19),
    timezone: "Asia/Shanghai",
    utc,
    precision: "second" as const,
    meaning,
    meaning_label: meaning === "site_public" ? "本站公开" : "原文核对",
    basis: TIME_BASIS,
    condition_text: null,
    label: local.slice(0, 10),
    beijing_date: local.slice(0, 10),
  };
};

const THEME_LABEL = {
  investment_company: "投资与公司",
  mineral_rights: "矿权",
  land_construction: "建设与土地",
  safety_environment: "安全与环境",
  labour_community: "劳动与社区",
  tax_finance: "财税与资金",
  trade_transport: "贸易与运输",
} as const;
const NATURE_LABEL = { law: "法律", regulation: "法规", amendment: "修正", draft: "草案", notice: "通知", guidance: "指引" } as const;
type Theme = keyof typeof THEME_LABEL;
type Nature = keyof typeof NATURE_LABEL;
type Stage = "proposed" | "consultation" | "adopted" | "published";
type Enforcement = "whole" | "partial" | "not_in_force" | "unknown";
const IN_FORCE = { whole: "yes", partial: "partial", not_in_force: "no", unknown: "unknown" } as const;
const CHANGE_LABEL = { first_publication: "首次公布", substantive_change: "实质修改", enforcement: "施行" } as const;

type Jurisdiction = { code: string; label: string; kind: "country" | "organization" };
const CL: Jurisdiction = { code: "CL", label: "智利", kind: "country" },
  AR: Jurisdiction = { code: "AR", label: "阿根廷", kind: "country" },
  ID: Jurisdiction = { code: "ID", label: "印度尼西亚", kind: "country" },
  AU: Jurisdiction = { code: "AU", label: "澳大利亚", kind: "country" };

type Interpretation = {
  guide: string;
  mainPoints: Array<{ text: string; clause: string }>;
  impacts: Array<{
    theme: Theme;
    legalActor: string;
    affected: string;
    activity: string;
    condition: string;
    mode: "direct" | "indirect";
    impact: string;
    deadline: string | null;
    exceptions: string | null;
  }>;
  sections: Array<{ title: string; text: string; basis: "source_fact" | "interpretation" | "uncertain"; conditions: string[]; exceptions: string[] }>;
  /** Reading body: the Chinese translation beside the original, block by block. */
  blocks: Array<{ kind: "heading" | "paragraph" | "list_item"; zh: string; original: string }>;
  effective: string;
  deadline: { text: string; date: string } | null;
};
type PolicySeed = {
  id: string;
  title: string;
  originalTitle: string;
  originalLanguage: string;
  jurisdiction: Jurisdiction;
  authority: string;
  nature: Nature;
  stage: Stage;
  enforcement: Enforcement;
  themes: Theme[];
  change: keyof typeof CHANGE_LABEL;
  published: string;
  /** Whole-second UTC instant the page went public on this site. */
  firstPublic: string;
  summary: string;
  applicability: string | null;
  relatedItem: string | null;
  interpretation: Interpretation | null;
};

const POLICY_SEEDS: PolicySeed[] = [
  {
    id: "demo-policy-royalty",
    title: "示例：矿业特许权费分档征收条例（修订）",
    originalTitle: "Ejemplo: Reglamento de regalías mineras escalonadas (demostración)",
    originalLanguage: "es",
    jurisdiction: CL,
    authority: "演示来源·矿业主管部门",
    nature: "regulation",
    stage: "published",
    enforcement: "not_in_force",
    themes: ["tax_finance", "mineral_rights"],
    change: "substantive_change",
    published: "2026-10-02",
    firstPublic: "2026-10-03T01:20:00Z",
    summary: "演示数据。按铜、锂价格分档征收特许权费；在产项目设两年过渡期，新项目自 2027 年起适用，矿权续期需提交税费测算。",
    applicability: "演示数据。适用于年产量超过规定门槛的铜、锂开采项目；小规模矿山另有简化程序。",
    relatedItem: "demo-royalty",
    interpretation: {
      guide:
        "演示数据。这份条例把特许权费从单一税率改为按金属价格分档：价格越高，适用费率越高。已投产项目有两年过渡期，过渡期内仍按原税率缴纳；2027 年 1 月 1 日后获批的新项目直接适用新档位。矿权续期时，权利人还需一并提交未来五年的税费测算。",
      mainPoints: [
        { text: "特许权费按季度平均金属价格分为三档征收，费率随价格上升。", clause: "第3条" },
        { text: "已投产项目自生效日起享有两年过渡期，过渡期内维持原税率。", clause: "第7条" },
        { text: "矿权续期申请须附未来五年的特许权费测算。", clause: "第9条" },
      ],
      impacts: [
        {
          theme: "tax_finance",
          legalActor: "矿业主管部门",
          affected: "铜、锂开采企业",
          activity: "缴纳特许权费",
          condition: "年产量超过条例规定门槛",
          mode: "direct",
          impact: "演示数据。高价格区间内税费负担上升，需重新测算项目现金流。",
          deadline: "2027-01-01",
          exceptions: "小规模矿山适用简化程序",
        },
        {
          theme: "mineral_rights",
          legalActor: "矿权登记机关",
          affected: "申请续期的矿权人",
          activity: "矿权续期",
          condition: "续期申请在生效日之后提交",
          mode: "direct",
          impact: "演示数据。续期材料需增加五年税费测算，准备周期可能延长。",
          deadline: null,
          exceptions: null,
        },
      ],
      sections: [
        {
          title: "征收档位",
          text: "演示数据。条例按季度平均金属价格设三档费率，最低档维持原税率，最高档较原税率提高约一倍。",
          basis: "source_fact",
          conditions: ["以主管部门公布的季度平均价格为准"],
          exceptions: [],
        },
        {
          title: "过渡安排",
          text: "演示数据。已投产项目享有两年过渡期；过渡期届满后自动适用新档位。",
          basis: "source_fact",
          conditions: ["项目须在生效日前已取得生产许可"],
          exceptions: ["扩建部分产能不适用过渡期"],
        },
        {
          title: "对项目测算的影响",
          text: "演示数据。在高价格情景下，项目税后现金流可能明显下降；在建项目宜按三档分别做敏感性测算。",
          basis: "interpretation",
          conditions: [],
          exceptions: [],
        },
        {
          title: "尚待明确",
          text: "演示数据。条例未写明季度平均价格的具体计算口径，实施细则发布前存在不确定性。",
          basis: "uncertain",
          conditions: [],
          exceptions: [],
        },
      ],
      blocks: [
        { kind: "heading", zh: "第一章 总则", original: "Capítulo I. Disposiciones generales (ejemplo)" },
        {
          kind: "paragraph",
          zh: "第1条　（演示数据）本条例规定矿业特许权费的征收档位、过渡安排及矿权续期时应提交的材料。",
          original: "Artículo 1. (Ejemplo) Este reglamento establece los tramos de regalías, el régimen transitorio y los documentos de renovación.",
        },
        { kind: "heading", zh: "第二章 征收档位", original: "Capítulo II. Tramos (ejemplo)" },
        {
          kind: "paragraph",
          zh: "第3条　（演示数据）特许权费按季度平均金属价格分为三档征收：",
          original: "Artículo 3. (Ejemplo) La regalía se cobra en tres tramos según el precio trimestral promedio:",
        },
        { kind: "list_item", zh: "（一）价格低于基准价的，适用基础费率；", original: "a) por debajo del precio de referencia, tasa base;" },
        {
          kind: "list_item",
          zh: "（二）价格介于基准价与上限价之间的，适用中间费率；",
          original: "b) entre el precio de referencia y el precio tope, tasa intermedia;",
        },
        { kind: "list_item", zh: "（三）价格高于上限价的，适用最高费率。", original: "c) por encima del precio tope, tasa máxima." },
        { kind: "heading", zh: "第三章 过渡安排", original: "Capítulo III. Régimen transitorio (ejemplo)" },
        {
          kind: "paragraph",
          zh: "第7条　（演示数据）本条例生效前已取得生产许可的项目，自生效之日起两年内仍按原税率缴纳。",
          original: "Artículo 7. (Ejemplo) Los proyectos con permiso de producción previo mantienen la tasa anterior durante dos años.",
        },
        {
          kind: "paragraph",
          zh: "第9条　（演示数据）矿权人申请续期的，应一并提交未来五年的特许权费测算。",
          original: "Artículo 9. (Ejemplo) Toda solicitud de renovación incluirá una proyección de regalías a cinco años.",
        },
      ],
      effective: "2027-01-01",
      deadline: { text: "演示数据。已投产项目过渡期届满", date: "2028-12-31" },
    },
  },
  {
    id: "demo-policy-export",
    title: "示例：稀土中间品出口许可申请指引",
    originalTitle: "Contoh: Pedoman izin ekspor produk antara tanah jarang (demonstrasi)",
    originalLanguage: "id",
    jurisdiction: ID,
    authority: "演示来源·贸易主管部门",
    nature: "guidance",
    stage: "published",
    enforcement: "whole",
    themes: ["trade_transport"],
    change: "first_publication",
    published: "2026-09-29",
    firstPublic: "2026-09-30T02:05:00Z",
    summary: "演示数据。出口稀土中间品须提交最终用户声明，审批时限延长至四十五个工作日。",
    applicability: "演示数据。适用于出口指引附表所列稀土中间品的企业。",
    relatedItem: "demo-export",
    interpretation: {
      guide: "演示数据。指引要求出口商在申请许可时附上最终用户声明，并把审批时限延长到四十五个工作日。下游采购方需要预留更长的备货周期。",
      mainPoints: [
        { text: "出口附表所列稀土中间品须提交最终用户声明。", clause: "第2节" },
        { text: "许可审批时限为四十五个工作日。", clause: "第4节" },
      ],
      impacts: [
        {
          theme: "trade_transport",
          legalActor: "贸易主管部门",
          affected: "稀土中间品出口商",
          activity: "申请出口许可",
          condition: "出口产品列入指引附表",
          mode: "direct",
          impact: "演示数据。申请材料增加，单批次出口周期可能延长一个半月左右。",
          deadline: null,
          exceptions: "样品出口另行办理",
        },
      ],
      sections: [
        {
          title: "申请材料",
          text: "演示数据。申请人须提交最终用户声明、合同摘要和产品成分说明。",
          basis: "source_fact",
          conditions: [],
          exceptions: ["样品出口另行办理"],
        },
        { title: "对供应链的影响", text: "演示数据。下游采购方宜提前锁定订单并预留审批时间。", basis: "interpretation", conditions: [], exceptions: [] },
      ],
      blocks: [
        { kind: "heading", zh: "第一节 适用范围", original: "Bagian 1. Ruang lingkup (contoh)" },
        {
          kind: "paragraph",
          zh: "（演示数据）本指引适用于附表所列稀土中间品的出口许可申请。",
          original: "(Contoh) Pedoman ini berlaku untuk permohonan izin ekspor produk dalam lampiran.",
        },
        { kind: "heading", zh: "第二节 申请材料", original: "Bagian 2. Dokumen permohonan (contoh)" },
        {
          kind: "paragraph",
          zh: "（演示数据）申请人应提交最终用户声明、合同摘要和产品成分说明。",
          original: "(Contoh) Pemohon menyerahkan pernyataan pengguna akhir, ringkasan kontrak dan komposisi produk.",
        },
        { kind: "heading", zh: "第四节 审批时限", original: "Bagian 4. Jangka waktu (contoh)" },
        {
          kind: "paragraph",
          zh: "（演示数据）主管部门应在四十五个工作日内作出决定。",
          original: "(Contoh) Keputusan diberikan dalam empat puluh lima hari kerja.",
        },
      ],
      effective: "2026-09-29",
      deadline: null,
    },
  },
  {
    id: "demo-policy-brine",
    title: "示例：盐湖提锂用水管理办法（征求意见稿）",
    originalTitle: "Ejemplo: Proyecto de norma sobre el uso de agua en salares (demostración)",
    originalLanguage: "es",
    jurisdiction: AR,
    authority: "演示来源·省级环境部门",
    nature: "draft",
    stage: "consultation",
    enforcement: "not_in_force",
    themes: ["safety_environment", "labour_community"],
    change: "first_publication",
    published: "2026-09-26",
    firstPublic: "2026-09-27T03:40:00Z",
    summary: "演示数据。拟要求盐湖提锂项目按季度公开取水量，并在扩产前与周边社区开展协商。",
    applicability: null,
    relatedItem: "demo-brine",
    interpretation: null,
  },
  {
    id: "demo-policy-safety",
    title: "示例：地下矿山通风安全规程修正案",
    originalTitle: "Example: Underground Mine Ventilation Safety Code Amendment (demonstration)",
    originalLanguage: "en",
    jurisdiction: AU,
    authority: "演示来源·州矿山安全机构",
    nature: "amendment",
    stage: "adopted",
    enforcement: "partial",
    themes: ["safety_environment"],
    change: "substantive_change",
    published: "2026-09-18",
    firstPublic: "2026-09-19T06:10:00Z",
    summary: "演示数据。提高地下矿山通风监测频次，新增气体传感器校准记录要求，部分条款分阶段施行。",
    applicability: null,
    relatedItem: "demo-safety",
    interpretation: null,
  },
  {
    id: "demo-policy-investment",
    title: "示例：外资参与矿业项目登记通知",
    originalTitle: "Ejemplo: Aviso de registro de inversión extranjera en minería (demostración)",
    originalLanguage: "es",
    jurisdiction: CL,
    authority: "演示来源·投资促进机构",
    nature: "notice",
    stage: "published",
    enforcement: "whole",
    themes: ["investment_company"],
    change: "first_publication",
    published: "2026-09-10",
    firstPublic: "2026-09-11T01:00:00Z",
    summary: "演示数据。外资持股超过规定比例的矿业项目须在交割后三十日内完成登记。",
    applicability: null,
    relatedItem: null,
    interpretation: null,
  },
];

const policyUrl = (seed: PolicySeed, path = "") => `https://example.invalid/policies/${seed.id}${path}`;

function policyCard(seed: PolicySeed) {
  return {
    id: seed.id,
    title: seed.title,
    original_title: seed.originalTitle,
    jurisdictions: [seed.jurisdiction],
    authority: { id: `${seed.id}-authority`, name: seed.authority },
    instrument_number: null,
    nature: { code: seed.nature, label: NATURE_LABEL[seed.nature] },
    themes: seed.themes.map((code) => ({ code, label: THEME_LABEL[code] })),
    change_kind: { code: seed.change, label: CHANGE_LABEL[seed.change] },
    published_time: day("published", seed.published),
    sort_time: day("published", seed.published),
    sort_kind: "published" as const,
    first_public_at: instantAt("site_public", seed.firstPublic),
    first_public_basis: "live" as const,
    source_checked_at: instantAt("checked", seed.firstPublic),
    is_backfill: false,
    legal_brief: { stage: seed.stage, in_force: IN_FORCE[seed.enforcement], repeal: "unknown" as const },
    interpretation_state: seed.interpretation ? ("complete" as const) : ("basic_facts" as const),
    summary: seed.summary,
    applicability_summary: seed.applicability,
    thread_id: null,
    original_url: policyUrl(seed),
    attributions: [{ name: seed.authority, url: policyUrl(seed) }],
    ai_label: "ai_generated" as const,
  };
}

const POLICY_CARDS = POLICY_SEEDS.map((seed) => PolicyCard.parse(policyCard(seed)));

export function demoPolicies(page = 1) {
  const pageSize = 20,
    items = POLICY_CARDS.slice((page - 1) * pageSize, page * pageSize);
  return PolicyListResponse.parse({
    content_version: "demo-1",
    generated_at: FIXED_TIME,
    items,
    page,
    page_size: pageSize,
    total: POLICY_CARDS.length,
    has_more: page * pageSize < POLICY_CARDS.length,
  });
}

const SCOPE: Jurisdiction[] = [
  CL,
  AR,
  { code: "PE", label: "秘鲁", kind: "country" },
  AU,
  ID,
  { code: "CD", label: "刚果（金）", kind: "country" },
  { code: "ZA", label: "南非", kind: "country" },
  { code: "CA", label: "加拿大", kind: "country" },
  { code: "EU", label: "欧盟", kind: "organization" },
  { code: "OECD", label: "经济合作与发展组织", kind: "organization" },
];
export const demoPolicyScope = PolicyScopeList.parse({
  items: SCOPE.map((jurisdiction) => ({ jurisdiction, readable_count: POLICY_SEEDS.filter((s) => s.jurisdiction.code === jurisdiction.code).length })),
  note: "演示数据：篇数仅为示意，不代表来源或法域覆盖完成率。",
});

const expressionIds = (seed: PolicySeed) => ({ version: `${seed.id}-v1`, original: `${seed.id}-original`, zh: `${seed.id}-zh` });

/** The full public document; `expressionId` picks the reading language, as the API does. Null when unknown. */
export function demoPolicy(id: string, expressionId: string | null = null) {
  const seed = POLICY_SEEDS.find((s) => s.id === id);
  if (!seed) return null;
  const card = policyCard(seed);
  const ids = expressionIds(seed);
  const it = seed.interpretation;
  const checked = instantAt("checked", seed.firstPublic);
  const source = {
    source_id: `${seed.id}-source`,
    publisher: card.authority,
    title_original: seed.originalTitle,
    original_url: policyUrl(seed),
    insecure_transport: false,
    published_time: day("published", seed.published),
  };
  const evidence = it
    ? it.mainPoints.map((point, i) => ({
        evidence_id: `e${i + 1}`,
        source,
        locator: point.clause,
        excerpt: `（演示数据）${point.text}`,
        relation: "supports" as const,
      }))
    : [];
  const ev = (...n: number[]) => (it ? n.map((i) => `e${i}`) : []);
  const expressions = it
    ? [
        {
          id: ids.original,
          policy_version_id: ids.version,
          document_revision_id: `${ids.original}-r1`,
          language: seed.originalLanguage,
          kind: "original" as const,
          issuing_body: null,
          instrument_number: null,
          checked_at: checked,
          reading_state: "complete" as const,
        },
        {
          id: ids.zh,
          policy_version_id: ids.version,
          document_revision_id: `${ids.zh}-r1`,
          language: "zh-CN",
          kind: "ai_translation" as const,
          issuing_body: null,
          instrument_number: null,
          checked_at: checked,
          reading_state: "complete" as const,
        },
      ]
    : [];
  const selected = expressions.find((e) => e.id === expressionId) ?? expressions.find((e) => e.id === ids.zh) ?? null;
  const arrangement = (text: string, date: string, meaning: Meaning, occurrence: "planned" | "occurred" | "conditional", e: string[]) => ({
    text,
    time: day(meaning, date),
    occurrence,
    scope: null,
    condition: null,
    evidence_ids: e,
  });
  return Policy.parse({
    ...card,
    legal_state: {
      nature: { value: seed.nature, basis: it ? "演示数据：原文标题与发布机关" : null, evidence_ids: ev(1) },
      legislative_stage: { value: seed.stage, basis: it ? "演示数据：原文公布信息" : null, evidence_ids: ev(1) },
      publication: { value: "published", basis: "演示数据：来源发布页面", evidence_ids: ev(1), time: day("published", seed.published) },
      enforcement: {
        value: seed.enforcement,
        basis: it ? "演示数据：原文施行条款" : null,
        evidence_ids: ev(2),
        arrangements: it
          ? [arrangement("演示数据。条例自该日起施行", it.effective, "effective", seed.enforcement === "whole" ? "occurred" : "planned", ev(2))]
          : [],
      },
      applicability: [],
      deadlines: it?.deadline ? [arrangement(it.deadline.text, it.deadline.date, "deadline", "planned", ev(2))] : [],
      repeal: { value: "unknown", basis: null, evidence_ids: [] },
    },
    dates: [day("published", seed.published), ...(it ? [day("effective", it.effective)] : []), ...(it?.deadline ? [day("deadline", it.deadline.date)] : [])],
    attachment_inventory: it
      ? [{ title: "示例：附表（演示数据）", url: policyUrl(seed, "/annex.pdf"), decisive: true, rights: "public", status: "complete" }]
      : [],
    versions: it
      ? [{ id: ids.version, version_label: "演示版本一", expression_ids: [ids.original, ids.zh], current: true, legal_brief: card.legal_brief }]
      : [],
    expressions,
    selected_policy_version_id: selected ? ids.version : null,
    selected_expression_id: selected?.id ?? null,
    reading:
      it && selected
        ? {
            mode: selected.kind,
            state: "complete",
            completeness: "complete",
            completed_blocks: it.blocks.length,
            total_blocks: it.blocks.length,
            blocks: [],
            next_cursor: null,
            attribution: selected.kind === "original" ? "原文（演示数据）" : "AI 翻译（非官方译文），演示数据",
            limitation: null,
            language: selected.language,
            document_revision_id: selected.document_revision_id,
            expression_id: selected.id,
            redistribution: "allowed",
          }
        : null,
    main_points: it ? it.mainPoints.map((p, i) => ({ text: p.text, clause_ref: p.clause, evidence_ids: [`e${i + 1}`] })) : [],
    guide: it?.guide ?? null,
    gaps: it ? [] : ["演示数据：中文全文尚未完成，暂不提供解读。"],
    impacts: it
      ? it.impacts.map((m, i) => ({
          id: `${seed.id}-impact-${i + 1}`,
          theme: m.theme,
          region: seed.jurisdiction.label,
          legal_actor: m.legalActor,
          affected_actor: m.affected,
          activity: m.activity,
          condition: m.condition,
          effect_mode: m.mode,
          impact: m.impact,
          deadline: m.deadline ? day("deadline", m.deadline) : null,
          exceptions: m.exceptions,
          evidence_ids: [`e${Math.min(i + 1, it.mainPoints.length)}`],
        }))
      : [],
    sections: it ? it.sections.map((s, i) => ({ ...s, evidence_ids: s.basis === "uncertain" ? [] : [`e${(i % it.mainPoints.length) + 1}`] })) : [],
    relationships: [],
    related_items: seed.relatedItem ? DEMO_ITEMS.filter((item) => item.id === seed.relatedItem).map((item) => ({ id: item.id, title: item.title })) : [],
    evidence,
    limitation: "演示数据：不是真实法规，也不构成法律建议。",
    ai_metadata: { provider: "AI矿策（演示）", content_id: seed.id },
  });
}

/** Reading blocks of one expression; null when the expression or revision does not belong to the policy. */
export function demoPolicyReading(id: string, expressionId: string | null, revisionId: string | null) {
  const policy = demoPolicy(id, expressionId);
  const seed = POLICY_SEEDS.find((s) => s.id === id);
  const expression = policy?.expressions.find((e) => e.id === expressionId);
  if (!policy || !seed?.interpretation || !expression || expression.document_revision_id !== revisionId) return null;
  const original = expression.kind === "original";
  const blocks = seed.interpretation.blocks.map((b, i) => ({
    block_id: `node-${i + 1}`,
    kind: b.kind,
    text: original ? b.original : b.zh,
    table_rows: null,
    evidence_ids: [],
    links: [],
  }));
  return PolicyReadingPage.parse({
    content_version: "demo-1",
    generated_at: FIXED_TIME,
    subject_id: id,
    document_revision_id: expression.document_revision_id,
    expression_id: expression.id,
    language: expression.language,
    mode: expression.kind,
    resource_completeness: "complete",
    total_blocks: blocks.length,
    blocks,
    next_cursor: null,
  });
}
