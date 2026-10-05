// 这个行业的分类体系：类别、标签词表、公司（主体）名录，以及防止张冠李戴的身份词典。
// 模型按这里的词表打标签，主题页（topics.json）按标签归类，筛选栏按类别分组。
// 换行业时：类别的 key 会出现在网址里（/all?category=…），上线后就不要再改；标签和名录可以随时增减。

import { MINING_CATEGORIES } from "./mining-taxonomy.ts";

/** Stable mining categories; unknown classifications have no report section. */
export const CATEGORIES = MINING_CATEGORIES;

/** Display labels stay in the industry pack; integration checks bind their keys to contracts. */
export const CATEGORY_LABELS = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label])) as Record<(typeof CATEGORIES)[number]["key"], string>;
export const CHANNEL_LABELS: Record<"all" | "news" | "firstParty", string> = {
  all: "全部",
  news: "资讯",
  firstParty: "一手",
};

/**
 * 内容理解一步给每篇资料判的“内容类型”（写在 prompts/content-understanding.md 里，改了类型要同步改那份提示词）。
 * 评分提示词（prompts/selection-score.md）按类型给五个维度不同的权重。
 */
export const ITEM_TYPES = [
  "model_release",
  "product_launch",
  "tool_or_prompt",
  "research_paper",
  "industry_event",
  "opinion_analysis",
  "tutorial_explainer",
] as const;

// ── 标签词表 ────────────────────────────────────────────────────────────────────────────

/** 已有明确主分类时使用该类的显示名；无法判断时不补标签。 */
export const CATEGORY_TAGS = CATEGORIES.map((c) => c.label);

/**
 * 金属（矿种）标签：Owner 2026-10-03，金属矿业为重点，六种金属只是例举；独立煤、铀、砂石不作正向标签。
 * 铁与铁矿石、铝与铝土矿分立（Q-37 的默认做法）；整份词表是交 Owner 审定的草案（I-16，不答复就按此执行）。
 */
export const MINERAL_TAGS = [
  "铜",
  "金",
  "银",
  "锌",
  "铅",
  "锂",
  "镍",
  "钴",
  "钼",
  "铁矿石",
  "铁",
  "铝土矿",
  "铝",
  "稀土",
  "钨",
  "锑",
  "锡",
  "锰",
  "铬",
  "铂族金属",
] as const;

/** 国家与地区标签：法规线 36 个对象里的 33 国（资讯线 18 国在前），另加巴西（铁矿石第二大产国、淡水河谷所在国）；数量不是上限。 */
export const COUNTRY_TAGS = [
  "中国",
  "美国",
  "澳大利亚",
  "阿根廷",
  "苏里南",
  "哥伦比亚",
  "圭亚那",
  "加纳",
  "南非",
  "刚果（金）",
  "赞比亚",
  "蒙古",
  "吉尔吉斯斯坦",
  "塔吉克斯坦",
  "哈萨克斯坦",
  "塞尔维亚",
  "智利",
  "加拿大",
  "秘鲁",
  "俄罗斯",
  "莫桑比克",
  "津巴布韦",
  "印度尼西亚",
  "坦桑尼亚",
  "委内瑞拉",
  "厄瓜多尔",
  "新加坡",
  "乌兹别克斯坦",
  "英国",
  "伊朗",
  "瑞士",
  "玻利维亚",
  "马里",
  "巴西",
] as const;

/** 可选的主题标签：金属与国家两轴（主题页的“金属”“国家与地区”按这些标签归类）。 */
export const TOPIC_TAGS = [...MINERAL_TAGS, ...COUNTRY_TAGS] as const;

/** 可选的实体标签（矿企），与下面 ENTITIES 的显示名一致。 */
export const ENTITY_TAGS = [
  "紫金矿业",
  "洛阳钼业",
  "江西铜业",
  "中国五矿",
  "五矿资源",
  "中国铝业",
  "山东黄金",
  "赣锋锂业",
  "天齐锂业",
  "华友钴业",
  "必和必拓",
  "力拓",
  "嘉能可",
  "淡水河谷",
  "英美资源",
  "自由港麦克莫兰",
  "纽蒙特",
  "巴里克",
  "智利国家铜业公司",
  "第一量子",
  "艾芬豪矿业",
  "雅宝",
  "智利化工矿业",
  "南方铜业",
] as const;

// ── 公司与主体 ──────────────────────────────────────────────────────────────────────────

/** 矿企主题：id → 显示名、卡片上显示的标签（null 表示只用 entity:<id> 归类）、别名。 */
export const ENTITIES: Record<string, { name: string; displayTag: string | null; aliases: string[] }> = {
  zijin: { name: "紫金矿业", displayTag: "紫金矿业", aliases: ["紫金矿业", "紫金集团", "Zijin Mining", "Zijin"] },
  cmoc: { name: "洛阳钼业", displayTag: "洛阳钼业", aliases: ["洛阳钼业", "洛钼", "CMOC", "China Molybdenum"] },
  "jiangxi-copper": { name: "江西铜业", displayTag: "江西铜业", aliases: ["江西铜业", "江铜", "Jiangxi Copper"] },
  minmetals: { name: "中国五矿", displayTag: "中国五矿", aliases: ["中国五矿", "五矿集团", "China Minmetals", "Minmetals"] },
  mmg: { name: "五矿资源", displayTag: "五矿资源", aliases: ["五矿资源", "MMG"] },
  chalco: { name: "中国铝业", displayTag: "中国铝业", aliases: ["中国铝业", "中铝", "Chalco", "Chinalco"] },
  "shandong-gold": { name: "山东黄金", displayTag: "山东黄金", aliases: ["山东黄金", "Shandong Gold"] },
  ganfeng: { name: "赣锋锂业", displayTag: "赣锋锂业", aliases: ["赣锋锂业", "赣锋", "Ganfeng Lithium", "Ganfeng"] },
  tianqi: { name: "天齐锂业", displayTag: "天齐锂业", aliases: ["天齐锂业", "天齐", "Tianqi Lithium", "Tianqi"] },
  huayou: { name: "华友钴业", displayTag: "华友钴业", aliases: ["华友钴业", "Huayou Cobalt", "Huayou"] },
  bhp: { name: "必和必拓", displayTag: "必和必拓", aliases: ["必和必拓", "BHP"] },
  "rio-tinto": { name: "力拓", displayTag: "力拓", aliases: ["力拓", "Rio Tinto"] },
  glencore: { name: "嘉能可", displayTag: "嘉能可", aliases: ["嘉能可", "Glencore"] },
  vale: { name: "淡水河谷", displayTag: "淡水河谷", aliases: ["淡水河谷", "Vale"] },
  "anglo-american": { name: "英美资源", displayTag: "英美资源", aliases: ["英美资源", "Anglo American"] },
  freeport: { name: "自由港麦克莫兰", displayTag: "自由港麦克莫兰", aliases: ["自由港麦克莫兰", "Freeport-McMoRan", "FCX"] },
  newmont: { name: "纽蒙特", displayTag: "纽蒙特", aliases: ["纽蒙特", "Newmont"] },
  barrick: { name: "巴里克", displayTag: "巴里克", aliases: ["巴里克", "巴里克黄金", "Barrick"] },
  codelco: { name: "智利国家铜业公司", displayTag: "智利国家铜业公司", aliases: ["智利国家铜业公司", "智利国家铜业", "Codelco"] },
  "first-quantum": { name: "第一量子", displayTag: "第一量子", aliases: ["第一量子", "First Quantum"] },
  ivanhoe: { name: "艾芬豪矿业", displayTag: "艾芬豪矿业", aliases: ["艾芬豪矿业", "艾芬豪", "Ivanhoe Mines"] },
  albemarle: { name: "雅宝", displayTag: "雅宝", aliases: ["雅宝", "Albemarle"] },
  sqm: { name: "智利化工矿业", displayTag: "智利化工矿业", aliases: ["智利化工矿业", "SQM"] },
  "southern-copper": { name: "南方铜业", displayTag: "南方铜业", aliases: ["南方铜业", "Southern Copper"] },
};

/**
 * 模型常写的近义写法 → 词表里的标签：分类只认术语表的正式短称（不从内容类型、主体或模糊动词猜类别）；
 * 金属与国家收常见的另一种写法；矿企收名录里的别名（英文按小写比对）。
 */
export const TAG_SYNONYMS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(CATEGORIES.map((c) => [c.shortLabel, c.label])),
  黄金: "金",
  金矿: "金",
  白银: "银",
  银矿: "银",
  铜矿: "铜",
  锌矿: "锌",
  铅矿: "铅",
  锂矿: "锂",
  碳酸锂: "锂",
  氢氧化锂: "锂",
  镍矿: "镍",
  钴矿: "钴",
  钼矿: "钼",
  铁矿: "铁矿石",
  铝矾土: "铝土矿",
  电解铝: "铝",
  氧化铝: "铝",
  稀土元素: "稀土",
  稀土矿: "稀土",
  钨矿: "钨",
  锑矿: "锑",
  锡矿: "锡",
  锰矿: "锰",
  铬矿: "铬",
  铂: "铂族金属",
  钯: "铂族金属",
  铂金: "铂族金属",
  钯金: "铂族金属",
  铂族: "铂族金属",
  刚果金: "刚果（金）",
  "刚果(金)": "刚果（金）",
  刚果民主共和国: "刚果（金）",
  民主刚果: "刚果（金）",
  澳洲: "澳大利亚",
  印尼: "印度尼西亚",
  吉尔吉斯: "吉尔吉斯斯坦",
  哈萨克: "哈萨克斯坦",
  塔吉克: "塔吉克斯坦",
  乌兹别克: "乌兹别克斯坦",
  俄罗斯联邦: "俄罗斯",
  蒙古国: "蒙古",
  ...Object.fromEntries(Object.values(ENTITIES).flatMap((e) => (e.displayTag ? e.aliases.map((a) => [a.toLowerCase(), e.displayTag]) : []))),
};

/**
 * 身份词典：摘要和标题里出现的公司，必须在原文里也出现过，否则退回原标题、丢掉摘要（防止模型张冠李戴）。
 * 中英文写法都要列：原文常是英文，摘要是中文。容易和普通词混淆的写法不列（如单独的“自由港”“紫金”）。
 */
// 双字简称常是普通中文的一部分（大力拓展、其中铝产量、黑龙江铜山、长江铜价），只在前后文不像普通词时才算公司；
// 其他中文译名（智利国营铜业公司、科德尔科、智利矿业化工公司……）也要认，否则模型写出的通行译名会被当成编造。
// 单独的“天齐”不收：“今天齐聚”会误认。
export const IDENTITY_LEXICON: ReadonlyArray<{ id: string; name: string; patterns: RegExp[] }> = [
  { id: "zijin", name: "紫金矿业", patterns: [/紫金矿业|紫金集团|\bzijin\b/i] },
  { id: "cmoc", name: "洛阳钼业", patterns: [/洛阳钼业|洛钼|\bCMOC\b|(?:china|luoyang)\s+molybdenum/i] },
  {
    id: "jiangxi-copper",
    name: "江西铜业",
    patterns: [/江西铜业|(?<![长珠浙龙镇九湛内吴晋松丹漓嫩乌闽赣湘汉沅绿沙怒沧布塘浦岷陵渠涪沱綦曲阳廉清柳邕盘东西南北椒瓯灵])江铜|jiangxi\s+copper/i],
  },
  { id: "minmetals", name: "中国五矿", patterns: [/中国五矿|五矿集团|minmetals/i] },
  { id: "mmg", name: "五矿资源", patterns: [/五矿资源|\bMMG\b/] },
  {
    id: "chalco",
    name: "中国铝业",
    patterns: [/中国铝业|(?<![其场集高口量存费构业])中铝(?![土价库锭材箔板棒]|合金)|\bchalco\b|chinalco|alumin(?:i)?um\s+corp(?:oration)?\s+of\s+china/i],
  },
  { id: "shandong-gold", name: "山东黄金", patterns: [/山东黄金矿业|山东黄金(?![产储资矿市])|shandong\s+gold/i] },
  { id: "ganfeng", name: "赣锋锂业", patterns: [/赣锋|\bganfeng\b/i] },
  { id: "tianqi", name: "天齐锂业", patterns: [/天齐锂业|\btianqi\b/i] },
  { id: "huayou", name: "华友钴业", patterns: [/华友钴业|\bhuayou\b/i] },
  { id: "bhp", name: "必和必拓", patterns: [/必和必拓|\bBHP\b/] },
  {
    id: "rio-tinto",
    name: "力拓",
    patterns: [/联合力拓|(?<![大全着努致助合发奋实能动潜活争人财物精魄势权压电风水火马推张拉外内效智尽极竭鼎协戮用卖出省借聚蓄])力拓|rio[\s-]?tinto/i],
  },
  { id: "glencore", name: "嘉能可", patterns: [/嘉能可|glencore/i] },
  { id: "vale", name: "淡水河谷", patterns: [/淡水河谷(?!地带|地区|流域)|\bVale\b|\bVALE\b/] },
  { id: "anglo-american", name: "英美资源", patterns: [/英美资源(?![竞争博合])|anglo[\s-]+american/i] },
  { id: "freeport", name: "自由港麦克莫兰", patterns: [/自由港[-·・]?麦克莫兰|自由港迈克墨伦|freeport[-\s]?mcmoran|\bFCX\b/i] },
  { id: "newmont", name: "纽蒙特", patterns: [/纽蒙特|newmont/i] },
  { id: "barrick", name: "巴里克", patterns: [/巴里克|\bbarrick\b/i] },
  { id: "codelco", name: "智利国家铜业公司", patterns: [/智利国家铜业|智利国营铜业|科德尔科|codelco/i] },
  { id: "first-quantum", name: "第一量子", patterns: [/第一量子(?![计科信通力点比])|first\s+quantum/i] },
  { id: "ivanhoe", name: "艾芬豪矿业", patterns: [/艾芬豪(?!电气|大西洋)|ivanhoe(?!\s+(?:electric|atlantic))/i] },
  { id: "albemarle", name: "雅宝", patterns: [/雅宝(?!路)|albemarle/i] },
  { id: "sqm", name: "智利化工矿业", patterns: [/智利化工矿业|智利矿业化工|智利化学矿业|\bSQM\b/] },
  { id: "southern-copper", name: "南方铜业", patterns: [/南方铜业|southern\s+copper/i] },
];

/** 这些域名上的文章，发布方就是对应的公司。 */
export const PUBLISHER_DOMAINS: ReadonlyArray<{ entityId: string; domains: readonly string[] }> = [
  { entityId: "zijin", domains: ["zijinmining.com"] },
  { entityId: "cmoc", domains: ["cmoc.com"] },
  { entityId: "jiangxi-copper", domains: ["jxcc.com"] },
  { entityId: "minmetals", domains: ["minmetals.com.cn"] },
  { entityId: "mmg", domains: ["mmg.com"] },
  { entityId: "chalco", domains: ["chalco.com.cn"] },
  { entityId: "shandong-gold", domains: ["sd-gold.com"] },
  { entityId: "ganfeng", domains: ["ganfenglithium.com"] },
  { entityId: "tianqi", domains: ["tianqilithium.com"] },
  { entityId: "huayou", domains: ["huayou.com"] },
  { entityId: "bhp", domains: ["bhp.com"] },
  { entityId: "rio-tinto", domains: ["riotinto.com"] },
  { entityId: "glencore", domains: ["glencore.com"] },
  { entityId: "vale", domains: ["vale.com"] },
  { entityId: "anglo-american", domains: ["angloamerican.com"] },
  { entityId: "freeport", domains: ["fcx.com"] },
  { entityId: "newmont", domains: ["newmont.com"] },
  { entityId: "barrick", domains: ["barrick.com"] },
  { entityId: "codelco", domains: ["codelco.com"] },
  { entityId: "first-quantum", domains: ["first-quantum.com"] },
  { entityId: "ivanhoe", domains: ["ivanhoemines.com"] },
  { entityId: "albemarle", domains: ["albemarle.com"] },
  { entityId: "sqm", domains: ["sqm.com"] },
  { entityId: "southern-copper", domains: ["southerncopper.com"] },
];

/** 原文里的这些写法也算提到了对应公司。 */
export const IDENTITY_CONTEXT_ALIASES: ReadonlyArray<{ entityId: string; pattern: RegExp }> = [];
