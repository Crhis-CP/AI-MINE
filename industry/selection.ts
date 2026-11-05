// 精选的门槛与总分算法。评分标准（五轴的含义、品味规则、各轴上限）写在 prompts/selection-score.md；
// 评分模型只给出内容类型和五轴分（0–10，可到一位小数），总分由这里的权重表在代码里算出（0–100，一位小数）。
// 每篇资料独立打两次分，两次总分的平均 ≥ 门槛才进精选，卡片上显示这个平均分（一位小数）。
// 门槛按信源分级区分：官方一手信源的门槛低一些，媒体和个人的高一些。改了门槛、权重或评分提示词，
// AI 负责真实案例与边界验证；规则调整按 Issue #293 由 Owner 确认，生产继续绑定已确认的准确版本。

export const SELECTION = {
  /**
   * 信源分级 → 入选门槛（平均分）。分级在后台“信源”里给每个源设置：
   *   T1 官方一手（官网、官方博客、机构）· T1_5 官方账号、准官方创作者 · T2 媒体与个人
   * 分级 EXCLUDE_MP 以及这里没有列出的分级，不参与精选评分（只进“全部动态”）。
   */
  thresholds: { T1: 60, T1_5: 65, T2: 76 } as Record<string, number>,
  /**
   * 没入选、但平均分高于这个数的资料，也用精选的写法（内容理解：标题、摘要、推荐理由、标签）来写，
   * 其余用更便宜的“标题摘要翻译”。
   */
  understandFloor: 50,
  /**
   * 内容类型 → 五轴权重（sig 实质份量、nov 信息增量、cred 证据强度、reson 共振面、act 可用性）。
   * 每行之和为 10，所以总分天然在 0–100。与 Owner 已确认的评分标准表一致，只是从提示词搬到了代码里。
   */
  weights: {
    policy_regulation: [3, 1, 2, 2, 2],
    company_project: [3, 2, 2, 2, 1],
    commodity_market: [3, 2, 2, 1, 2],
    capital_ma: [3, 1, 2, 3, 1],
    supply_trade_controls: [3, 2, 2, 1, 2],
    esg_community_labor: [4, 1, 2, 3, 0],
    safety_incident: [4, 1, 2, 3, 0],
    technology_processing: [4, 3, 2, 1, 0],
    exploration_resource: [4, 3, 2, 1, 0],
  } as Record<string, readonly [number, number, number, number, number]>,
  /** 标题与正文明显不符、或正文残缺到无法辨认对象动作阶段时，总分不得高于这个数。 */
  unusableMaterialCap: 30,
} as const;

export const SCORE_AXES = ["sig", "nov", "cred", "reson", "act"] as const;
export type ScoreAxes = Record<(typeof SCORE_AXES)[number], number> & { type: string; materialUnusable?: boolean };

const tenth = (value: number) => Math.round(value * 10) / 10;

/** 一次评分的总分：按内容类型的权重加权五轴（各轴先截到 0–10、一位小数），结果保留一位小数。 */
export function attentionScore(axes: ScoreAxes): number {
  const weights = SELECTION.weights[axes.type];
  if (!weights) throw new Error(`Unknown selection type: ${axes.type}`);
  const total = SCORE_AXES.reduce((sum, axis, i) => sum + tenth(Math.min(10, Math.max(0, axes[axis]))) * weights[i]!, 0);
  return tenth(axes.materialUnusable ? Math.min(total, SELECTION.unusableMaterialCap) : total);
}
