// ADR-0022 data: glossary §3 / DR-100 definitions and DR-89 report sections.
// guide is the current glossary definition; shortLabel is only a compact label/alias.
export const MINING_CATEGORIES = [
  {
    key: "policy_regulation",
    label: "政策监管",
    shortLabel: "法规政策",
    section: "政策与安全",
    guide: "政府或有法定职能的机构对矿业权利义务、许可、税费、准入、执法作出的规则与程序变化",
  },
  {
    key: "company_project",
    label: "企业与项目",
    shortLabel: "企业项目",
    section: "企业与项目",
    guide: "矿企、矿山、冶炼加工资产、基础设施项目的建设、运营、产能、融资与关键里程碑",
  },
  {
    key: "commodity_market",
    label: "商品与市场",
    shortLabel: "商品市场",
    section: "市场与技术",
    guide: "矿产品价格、基准、库存、供需、交易场所与市场结构的可核验变化",
  },
  {
    key: "capital_ma",
    label: "投资并购",
    shortLabel: "资本交易",
    section: "企业与项目",
    guide: "投资、合资、收购、出售、交割等权益或控制权交易",
  },
  {
    key: "supply_trade_controls",
    label: "供应链、贸易与制裁",
    shortLabel: "供应链贸易制裁",
    section: "政策与安全",
    guide: "出口限制、关税、配额、禁运、制裁、供应链准入与中断",
  },
  {
    key: "esg_community_labor",
    label: "ESG、社区与劳工",
    shortLabel: "ESG社区劳工",
    section: "政策与安全",
    guide: "环境、社区权利、原住民咨询、劳工关系、罢工、利益相关方冲突",
  },
  {
    key: "safety_incident",
    label: "矿山安全",
    shortLabel: "矿山安全",
    section: "政策与安全",
    guide: "伤亡事故、救援、重大设备失效、停产与事故调查",
  },
  {
    key: "technology_processing",
    label: "技术与冶炼",
    shortLabel: "技术冶炼",
    section: "市场与技术",
    guide: "采矿、选冶、回收、尾矿处理技术的研发、验证与商业部署",
  },
  {
    key: "exploration_resource",
    label: "勘探与资源",
    shortLabel: "勘探资源",
    section: "企业与项目",
    guide: "勘查、钻探、资源量、储量与技术报告披露",
  },
] as const;

export const MINING_CATEGORY_LABELS = Object.fromEntries(MINING_CATEGORIES.map((c) => [c.key, c.label])) as Record<
  (typeof MINING_CATEGORIES)[number]["key"],
  string
>;
export const MINING_REPORT_SECTIONS = [...new Set(MINING_CATEGORIES.map((c) => c.section))];
export const MINING_CATEGORY_GUIDE = [
  "按本条新增可证事实的核心动作唯一归类；无法稳定判断时返回 null。不要按发布方、热度、评分内容类型或标签数组位置猜类。",
  ...MINING_CATEGORIES.map((c) => `- ${c.key}（${c.label}）：${c.guide}`),
].join("\n");

/** Only the three category-based report sections; domestic/overseas require country evidence. */
export function miningReportSection(category: unknown) {
  return MINING_CATEGORIES.find((c) => c.key === category)?.section ?? null;
}
