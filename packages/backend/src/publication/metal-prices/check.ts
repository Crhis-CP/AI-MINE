// Plausibility check of one fetched period (TASK-0057): a pure function of the period, the source's enabled series, what
// is stored before it and the time, giving the reasons to hold the period back whole that hold for any source. Its
// fetcher gives the source's own (a release title, two tables); the refresh (TASK-0069) holds the period on either and
// passes the stored values in. Nothing here estimates or fills in a value.
import { beijingDate } from "@amp/contracts/time";
import { onSourceHost } from "./registry.ts";
import type { PeriodCheckInput, PeriodCheckResult } from "./types.ts";

/** How far a value may move from the previous period's: daily (Bank of Russia), ten-day (the bureau), monthly (World Bank, IMF). */
const RATIO = { day: [0.5, 2], week: [0.67, 1.5], ten_day: [0.67, 1.5], month: [0.5, 2] } as const;

export function checkPeriod({ fetched, source, items, previous, newest, compareWithPrevious = true, now }: PeriodCheckInput): PeriodCheckResult {
  const { period, release, rows } = fetched;
  const reasons: string[] = [];
  const notes: string[] = [];
  if (!onSourceHost(source, release.url)) reasons.push(`发布页链接 ${release.url} 不在登记的主机上或不是 https`);
  // A period still running has no price yet: its last day must be before today in Beijing (a day stricter than "not future").
  const today = beijingDate(now);
  if (period.end >= today) reasons.push(`所属期${period.label}还没结束（最后一天 ${period.end}，北京时间今天 ${today}）`);
  // With nothing stored for the source (the first run) there is nothing to be older than.
  if (newest && period.start < newest) reasons.push(`所属期${period.label}比库里最新一期（${newest} 开始）旧`);
  // With no period stored before this one, the row count and ratio checks have nothing to compare with.
  const compare = compareWithPrevious && Boolean(previous?.size);
  if (compareWithPrevious && !compare) notes.push("没有上一期");
  // Counted over the series still enabled, so stopping a few never holds every later period back.
  const before = items.filter((item) => previous?.has(item.key)).length;
  if (compare && rows.length * 2 < before) reasons.push(`只有 ${rows.length} 行，不到上一期仍启用的 ${before} 个品种的一半`);
  const [low, high] = RATIO[source.frequency];
  for (const item of items) {
    const found = rows.filter((row) => row.key === item.key);
    if (found.length !== 1) {
      reasons.push(`${item.key} 出现 ${found.length} 次`);
      continue;
    }
    const { unit, value } = found[0]!;
    const was = previous?.get(item.key);
    if (unit !== item.sourceUnit) reasons.push(`${item.key} 的单位是“${unit}”，不是“${item.sourceUnit}”`);
    if (!/^-?\d+(\.\d+)?$/.test(value)) reasons.push(`${item.key} 的数值“${value}”不是数字`);
    else if (Number(value) <= 0) reasons.push(`${item.key} 的数值 ${value} 不大于 0`);
    else if (compare && was === undefined) notes.push(`上一期没有 ${item.key}，跳过它的倍数检查`);
    else if (compare) {
      const ratio = Number(value) / Number(was);
      if (ratio < low || ratio > high) reasons.push(`${item.key} 是 ${value}，是上一期 ${was} 的 ${ratio.toFixed(2)} 倍，超出 ${low}–${high} 倍`);
    }
  }
  return { reasons, notes };
}
