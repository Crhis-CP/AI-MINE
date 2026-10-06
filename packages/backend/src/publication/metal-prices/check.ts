// Plausibility check of one fetched period (TASK-0057): a pure function of the period, the source's enabled series, what
// is stored before it and the time, giving every reason to hold the period back whole. The refresh (TASK-0069) reads the
// stored values and passes them in. Nothing here estimates or fills in a value.
import { beijingDate } from "@amp/contracts/time";
import { type MetalPriceSourceKey, onSourceHost } from "./registry.ts";
import type { PeriodCheckInput, PeriodCheckResult } from "./types.ts";

/** The leading cells of each source's price table header, NFKC with no whitespace; later cells are not read. */
export const TABLE_HEADER: Partial<Record<MetalPriceSourceKey, string[]>> = { nbs: ["产品名称", "单位", "本期价格(元)"] };
/** How far a value may move from the previous period's: ten-day prices; monthly ones from the World Bank (TASK-0046). */
const RATIO = { ten_day: [0.67, 1.5], month: [0.5, 2] } as const;

export function checkPeriod({ fetched, source, items, previous, newest, now }: PeriodCheckInput): PeriodCheckResult {
  const { period, release, title, header, rows } = fetched;
  const held = [...fetched.held];
  const expected = TABLE_HEADER[source.key] ?? [];
  if (expected.some((cell, i) => header[i] !== cell)) held.push(`价格表表头是“${header.slice(0, expected.length).join("、")}”，应为“${expected.join("、")}”`);
  if (!onSourceHost(source, release.url)) held.push(`发布页链接 ${release.url} 不在登记的主机上或不是 https`);
  if (title !== release.label) held.push(`发布页标题“${title}”与列表页标题“${release.label}”不一致`);
  // A period still running has no price yet: its last day must be before today in Beijing (a day stricter than "not future").
  const today = beijingDate(now);
  if (period.end >= today) held.push(`所属期${period.label}还没结束（最后一天 ${period.end}，北京时间今天 ${today}）`);
  if (newest && period.start < newest) held.push(`所属期${period.label}比库里最新一期（${newest} 开始）旧`);
  // With nothing stored before (the first run), the row count and ratio checks have nothing to compare with.
  const notes = previous?.size ? [] : ["没有上一期"];
  // Counted over the series still enabled, so stopping a few never holds every later period back.
  const before = items.filter((item) => previous?.has(item.key)).length;
  if (rows.length * 2 < before) held.push(`只有 ${rows.length} 行，不到上一期仍启用的 ${before} 个品种的一半`);
  const [low, high] = RATIO[source.frequency];
  for (const item of items) {
    const found = rows.filter((row) => row.key === item.key);
    if (found.length !== 1) {
      held.push(`${item.key} 出现 ${found.length} 次`);
      continue;
    }
    const { unit, value } = found[0]!;
    if (unit !== item.sourceUnit) held.push(`${item.key} 的单位是“${unit}”，不是“${item.sourceUnit}”`);
    if (!/^-?\d+(\.\d+)?$/.test(value)) held.push(`${item.key} 的数值“${value}”不是数字`);
    else if (Number(value) <= 0) held.push(`${item.key} 的数值 ${value} 不大于 0`);
    else if (previous?.has(item.key)) {
      const ratio = Number(value) / Number(previous.get(item.key));
      if (ratio < low || ratio > high)
        held.push(`${item.key} 是 ${value}，是上一期 ${previous.get(item.key)} 的 ${ratio.toFixed(2)} 倍，超出 ${low}–${high} 倍`);
    }
  }
  return { held, notes };
}
