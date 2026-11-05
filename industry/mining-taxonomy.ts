// ADR-0031 data (re-cut of ADR-0022): glossary §3 / DR-100 definitions and DR-89 report sections.
// guide is the current glossary definition; shortLabel is only a compact label/alias (all current names are four characters).
export const MINING_CATEGORIES = [
  {
    key: "policy_regulation",
    label: "政策监管",
    shortLabel: "法规政策",
    section: "政策与安全",
    commentary: false,
    guide: "法规、许可、税费、准入、执法与矿权制度的规则和程序变化；出口管制、关税、配额、禁运与制裁等贸易措施",
  },
  {
    key: "operations_output",
    label: "生产经营",
    shortLabel: "生产经营",
    section: "企业与项目",
    commentary: false,
    guide: "在产矿山、冶炼厂与矿企的产量、业绩、指引、成本、分红、停产与复产",
  },
  {
    key: "project_development",
    label: "项目建设",
    shortLabel: "项目建设",
    section: "企业与项目",
    commentary: false,
    guide: "矿山、冶炼与配套项目的审批、可行性研究、开工、扩建、投产与工程合同",
  },
  {
    key: "exploration_resource",
    label: "勘探资源",
    shortLabel: "勘探资源",
    section: "企业与项目",
    commentary: false,
    guide: "勘查、钻探结果、资源量、储量与技术报告披露",
  },
  {
    key: "capital_ma",
    label: "并购融资",
    shortLabel: "并购融资",
    section: "企业与项目",
    commentary: false,
    guide: "收购、出售、合资、融资配售、上市、包销协议等权益、控制权与资金交易",
  },
  {
    key: "commodity_market",
    label: "市场价格",
    shortLabel: "市场价格",
    section: "市场与技术",
    commentary: false,
    guide: "矿产品价格、库存、供需、官方统计与行情分析",
  },
  {
    key: "technology_processing",
    label: "技术装备",
    shortLabel: "技术装备",
    section: "市场与技术",
    commentary: false,
    guide: "采矿、选矿、冶炼与回收工艺，装备和数字化的研发、验证与应用",
  },
  {
    key: "safety_environment",
    label: "安全环境",
    shortLabel: "安全环境",
    section: "政策与安全",
    commentary: false,
    guide: "事故伤亡、救援、环境事件、社区与劳资冲突、ESG",
  },
  {
    key: "events_opinion",
    label: "会议观点",
    shortLabel: "会议观点",
    section: "市场与技术",
    commentary: true,
    guide: "会议论坛、致辞、访谈、研报观点与人事变动，本身不带来新的事实进展",
  },
] as const;

export const MINING_CATEGORY_LABELS = Object.fromEntries(MINING_CATEGORIES.map((c) => [c.key, c.label])) as Record<
  (typeof MINING_CATEGORIES)[number]["key"],
  string
>;
export const MINING_REPORT_SECTIONS = [...new Set(MINING_CATEGORIES.map((c) => c.section))];
export const MINING_CATEGORY_GUIDE = [
  "按本条新增可证事实的核心动作唯一归类；只是会议、讲话、访谈、观点或人事、没有新事实动作的归 events_opinion；仍无法稳定判断时返回 null。不要按发布方、热度、评分内容类型或标签数组位置猜类。",
  ...MINING_CATEGORIES.map((c) => `- ${c.key}（${c.label}）：${c.guide}`),
].join("\n");

/** Commentary classes (AIHOT 评论性): reports do not count them as a new development. */
export function isCommentaryCategory(category: unknown): boolean {
  return MINING_CATEGORIES.some((c) => c.key === category && c.commentary);
}

/**
 * Category names an item may still carry as its first tag from before a change: the renames of 2026-10-05
 * (TASK-0041) and the re-cut of 2026-11-05 (ADR-0031). Publication shows the current one.
 */
const RENAMED_CATEGORY_TAGS: Readonly<Record<string, string>> = {
  人身与生产安全: MINING_CATEGORY_LABELS.safety_environment,
  安全事故: MINING_CATEGORY_LABELS.safety_environment,
  矿山安全: MINING_CATEGORY_LABELS.safety_environment,
  "ESG、社区与劳工": MINING_CATEGORY_LABELS.safety_environment,
  ESG社区劳工: MINING_CATEGORY_LABELS.safety_environment,
  "供应链、贸易与制裁": MINING_CATEGORY_LABELS.policy_regulation,
  供应链贸易制裁: MINING_CATEGORY_LABELS.policy_regulation,
  商品与市场: MINING_CATEGORY_LABELS.commodity_market,
  商品市场: MINING_CATEGORY_LABELS.commodity_market,
  投资并购: MINING_CATEGORY_LABELS.capital_ma,
  技术与加工: MINING_CATEGORY_LABELS.technology_processing,
  技术加工: MINING_CATEGORY_LABELS.technology_processing,
  技术与冶炼: MINING_CATEGORY_LABELS.technology_processing,
  技术冶炼: MINING_CATEGORY_LABELS.technology_processing,
  勘探与资源: MINING_CATEGORY_LABELS.exploration_resource,
};
/** 企业与项目 split in two: the name alone does not say which, so it is dropped (its item is reclassified). */
const RETIRED_CATEGORY_TAGS: readonly string[] = ["企业与项目", "企业项目"];

/** The old names (full and short) that publication replaces or drops. */
export const OLD_CATEGORY_TAGS: readonly string[] = [...Object.keys(RENAMED_CATEGORY_TAGS), ...RETIRED_CATEGORY_TAGS];

/** Tags with the old category names replaced by the current ones, without duplicates. */
export function renameCategoryTags(tags: readonly string[]): string[] {
  return [...new Set(tags.filter((t) => !RETIRED_CATEGORY_TAGS.includes(t)).map((t) => RENAMED_CATEGORY_TAGS[t] ?? t))];
}

const CATEGORY_NAMES = new Set<string>([...MINING_CATEGORIES.map((c) => c.label), ...OLD_CATEGORY_TAGS]);

/** Analysed tags led by the name of the item's category (none without one); any other category name is dropped. */
export function categoryLedTags(category: unknown, tags: readonly string[]): string[] {
  const label = MINING_CATEGORIES.find((c) => c.key === category)?.label;
  return [...new Set([...(label ? [label] : []), ...tags.filter((t) => !CATEGORY_NAMES.has(t))])];
}

/** Only the three category-based report sections; domestic/overseas require country evidence. */
export function miningReportSection(category: unknown) {
  return MINING_CATEGORIES.find((c) => c.key === category)?.section ?? null;
}
