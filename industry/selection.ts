// 精选的门槛与总分算法。评分标准（五轴的含义、品味规则）写在评分提示词里，用哪一份由规则组决定（见下方 SELECTION_RULESETS）；
// 评分模型给出内容类型、五轴分（0–10，可到一位小数）和噪声类型，总分由这里的权重表和封顶在代码里算出（0–100，一位小数）。
// 第一次分数离门槛较远时只打一次；靠近门槛的再独立打一次，取平均（Owner 2026-11-05：降低模型成本）。
// 平均分 ≥ 门槛才进精选，卡片上显示这个分数（一位小数）。
// 2026-11-05 按 Owner 对 119 篇线上文章的标注改写（docs/design/taxonomy-scoring-202611/）：读者是关注海外矿业投资、
// 贸易与合规的中国读者；与中国读者的关系（共振面）权重提高，证据强度不再是主要加分项；小矿企的例行项目新闻封顶。
// 2026-11-13（TASK-0670）起缺省用 global 规则组：读者改为全球矿业投资者与从业者，第四轴 reson 的含义由“共振面”改为
// “影响面”（波及多少市场、国家和公司）；字段名、权重、门槛和封顶都不变。上面这段是 classic 规则组的口径。
// 门槛按信源分级区分：官方一手信源的门槛低一些，媒体和个人的高一些。改了门槛、权重或评分提示词，
// AI 负责真实案例与边界验证；规则调整按 Issue #293 由 Owner 确认，生产继续绑定已确认的准确版本。

/**
 * Selection rule sets: which prompt files (industry/prompts/<name>.md) hold the score rules and the prefilter rules.
 * SELECTION_RULESET picks one per process (packages/backend/src/config.ts); both sets share the weights, thresholds
 * and caps below.
 *   global   the default (Owner 2026-11-13, TASK-0670): 精选 is scored by how widely an event matters to mining
 *            worldwide, and the prefilter also passes four more layers (resource-country law and policy, political and
 *            security risk, Chinese outbound investment, downstream and macro news that states its effect on a metal).
 *   classic  the rules production ran before, kept byte for byte so a rollback is this switch plus the confirmed
 *            version; tests/selection-ruleset.test.ts locks its prompts and versions.
 */
export const SELECTION_RULESETS = {
  global: { score: "selection-score-global", prefilter: "prefilter-four-layers" },
  classic: { score: "selection-score", prefilter: "prefilter" },
} as const;
export type SelectionRuleset = keyof typeof SELECTION_RULESETS;
export const DEFAULT_SELECTION_RULESET: SelectionRuleset = "global";

export const SELECTION = {
  /**
   * 信源分级 → 入选门槛（平均分）。分级在后台“信源”里给每个源设置：
   *   T1 官方一手（官网、官方博客、机构）· T1_5 官方账号、准官方创作者 · T2 媒体与个人
   * 分级 EXCLUDE_MP 以及这里没有列出的分级，不参与精选评分（只进“全部动态”）。
   */
  thresholds: { T1: 62, T1_5: 64, T2: 66 } as Record<string, number>,
  /**
   * 没入选、但平均分高于这个数的资料，也用精选的写法（内容理解：标题、摘要、推荐理由、标签）来写，
   * 其余用更便宜的“标题摘要翻译”。
   */
  understandFloor: 50,
  /**
   * 内容类型 → 五轴权重（sig 实质份量、nov 信息增量、cred 证据强度、reson 共振面、act 可用性）。
   * 每行之和为 10，所以总分天然在 0–100。2026-11-05 每行把证据强度的 1 份移给共振面：
   * 官方例行文件证据天然满分，曾把分数抬高；与中国读者的关系才是 Owner 标注里最强的规律。
   * 2026-11-05 分类重切（ADR-0031）：贸易制裁并入政策监管，用政策监管行；矿山安全与 ESG 原行相同，合为安全环境；
   * 生产经营、项目建设沿用原“企业与项目”行；会议观点照上游观点类（opinion_analysis）的 [1, 3, 1, 4, 1]，
   * 是评论性内容（日报不把它算作新进展，见 mining-taxonomy.ts 的 commentary）。
   */
  weights: {
    policy_regulation: [3, 1, 1, 3, 2],
    operations_output: [3, 2, 1, 3, 1],
    project_development: [3, 2, 1, 3, 1],
    exploration_resource: [4, 3, 1, 2, 0],
    capital_ma: [3, 1, 1, 4, 1],
    commodity_market: [3, 2, 1, 2, 2],
    technology_processing: [4, 3, 1, 2, 0],
    safety_environment: [4, 1, 1, 4, 0],
    events_opinion: [1, 3, 1, 4, 1],
  } as Record<string, readonly [number, number, number, number, number]>,
  /**
   * 噪声类型 → 总分上限。只封一个轴压不住总分（煤矿 42 分、钢厂技改 40–55 分曾因其他轴照样加分），
   * 所以由模型判类型、代码封总分。none 不封顶。
   */
  noiseCaps: {
    none: 100,
    out_of_scope: 30,
    event_routine: 35,
    price_tick: 40,
    general_gov: 40,
    junior_routine: 55,
  } as Record<string, number>,
  /** 第一次分数与门槛相差超过这个数时，不再打第二次。 */
  secondScoreMargin: 15,
  /** 标题与正文明显不符、或正文残缺到无法辨认对象动作阶段时，总分不得高于这个数。 */
  unusableMaterialCap: 30,
  /**
   * 低于这个分数的稿件不送归组（降本，Owner 2026-11-05）：它们是被封顶的噪声（范围外、例行、残缺），
   * 读者默认看不到，也不会入选，归组只花调用。未打分（模型拒评、尚未定分）的照常归组。
   */
  groupFloor: 20,
  /**
   * 浏览下限（Owner 2026-11-05）：没有搜索词的“全部”列表（网页、接口、RSS）默认不显示低于这个分数的稿件；
   * 精选和未定分的照常显示，搜索仍能搜到全部。
   */
  browseFloor: 20,
} as const;

export const SCORE_AXES = ["sig", "nov", "cred", "reson", "act"] as const;
export const NOISE_TYPES = ["none", "out_of_scope", "event_routine", "price_tick", "general_gov", "junior_routine"] as const;
export type ScoreAxes = Record<(typeof SCORE_AXES)[number], number> & { type: string; materialUnusable?: boolean; noise?: (typeof NOISE_TYPES)[number] };

/**
 * 大型矿企与贸易商：它们的业绩、产量指引、战略、并购与重大项目属于“必须正常评价”；名单之外的小矿企，
 * 例行的钻探、资源量更新、融资配售、季度报告封顶（junior_routine）。注入评分提示词，名单变化也会改变评分版本。
 */
export const MAJOR_COMPANIES = [
  "紫金矿业 Zijin Mining",
  "洛阳钼业 CMOC",
  "江西铜业 Jiangxi Copper",
  "中国五矿 China Minmetals",
  "五矿资源 MMG",
  "中国铝业 Chalco",
  "中国宝武 China Baowu",
  "山东黄金 Shandong Gold",
  "赣锋锂业 Ganfeng Lithium",
  "天齐锂业 Tianqi Lithium",
  "华友钴业 Huayou Cobalt",
  "必和必拓 BHP",
  "力拓 Rio Tinto",
  "嘉能可 Glencore",
  "淡水河谷 Vale",
  "英美资源 Anglo American",
  "自由港麦克莫兰 Freeport-McMoRan",
  "纽蒙特 Newmont",
  "巴里克 Barrick",
  "智利国家铜业公司 Codelco",
  "第一量子 First Quantum",
  "艾芬豪矿业 Ivanhoe Mines",
  "雅宝 Albemarle",
  "智利化工矿业 SQM",
  "南方铜业 Southern Copper",
  "泰克资源 Teck Resources",
  "安托法加斯塔 Antofagasta",
  "福蒂斯丘 Fortescue",
  "南32 South32",
  "诺里尔斯克镍业 Nornickel",
  "伊格尔矿业 Agnico Eagle",
  "金田 Gold Fields",
  "盎格鲁黄金阿散蒂 AngloGold Ashanti",
  "金罗斯 Kinross",
  "西班耶-斯蒂尔沃特 Sibanye-Stillwater",
  "托克 Trafigura",
  "摩科瑞 Mercuria",
] as const;

const tenth = (value: number) => Math.round(value * 10) / 10;

/** 一次评分的总分：按内容类型的权重加权五轴（各轴先截到 0–10、一位小数），再按噪声类型和材料残缺封顶，保留一位小数。 */
export function attentionScore(axes: ScoreAxes): number {
  const weights = SELECTION.weights[axes.type];
  if (!weights) throw new Error(`Unknown selection type: ${axes.type}`);
  const total = SCORE_AXES.reduce((sum, axis, i) => sum + tenth(Math.min(10, Math.max(0, axes[axis]))) * weights[i]!, 0);
  const cap = Math.min(SELECTION.noiseCaps[axes.noise ?? "none"] ?? 100, axes.materialUnusable ? SELECTION.unusableMaterialCap : 100);
  return tenth(Math.min(total, cap));
}

/** 已有的分数够不够下结论：两次都打了，或者第一次离门槛足够远。 */
export function scoreSettled(values: readonly number[], threshold: number, calls = 2): boolean {
  return values.length >= calls || (values.length === 1 && Math.abs(values[0]! - threshold) > SELECTION.secondScoreMargin);
}

/** 入选：已打分数之和（一位小数）不低于门槛乘以分数个数，即平均分达到门槛，但不让平均分的四舍五入抬过门槛。 */
export function meetsThreshold(values: readonly number[] | null | undefined, threshold: number | null): boolean {
  if (!values?.length || threshold === null) return false;
  return Math.round(values.reduce((sum, value) => sum + value, 0) * 10) >= Math.round(threshold * values.length * 10);
}

/** 显示用的分数：已打分数的平均，一位小数；没有分数时为 null。 */
export function scoreMean(values: readonly number[] | null | undefined): number | null {
  if (!values?.length) return null;
  return tenth(values.reduce((sum, value) => sum + value, 0) / values.length);
}
