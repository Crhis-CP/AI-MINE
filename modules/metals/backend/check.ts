// Plausibility check of one fetched period (TASK-0057): a pure function of the period, the source's enabled series, what
// is stored before it and the time, giving the reasons to hold the period back whole that hold for any source. Its
// fetcher gives the source's own (a release title, two tables); the refresh (TASK-0069) holds the period on either and
// passes the stored values in. Nothing here estimates or fills in a value.
//
// A price jump holds that series alone (DEC-78补充·五项决定 item 4): a value outside the ratio band of the one it is
// compared with is not published, the period's other series are. The next period of the source decides it: within the
// band of the held value the market stayed at the new level, so the held value and the new one both go in; outside it
// the held value was a one-off, is discarded, and the new value is checked against the last value that went in.
// Reasons that say the page was read wrong (a missing or doubled row, a unit, a host, too few rows, two tables or
// titles that disagree, most series jumping at once) still hold the whole period.
import { beijingDate } from "@amp/contracts/time";
import { onSourceHost } from "./registry.ts";
import type { PeriodCheckInput, PeriodCheckResult, PriceHold } from "./types.ts";

/** How far a value may move from the previous period's: daily (Bank of Russia), ten-day (the bureau), monthly (World Bank, IMF). */
const RATIO = { day: [0.5, 2], week: [0.67, 1.5], ten_day: [0.67, 1.5], month: [0.5, 2] } as const;

export function checkPeriod({
  fetched,
  source,
  items,
  previous,
  newest,
  compareWithPrevious = true,
  holds,
  accepted,
  current,
  now,
}: PeriodCheckInput): PeriodCheckResult {
  const { period, release, rows } = fetched;
  const reasons: string[] = [];
  const notes: string[] = [];
  const jumps: NonNullable<PeriodCheckResult["jumps"]> = [];
  const releases: NonNullable<PeriodCheckResult["releases"]> = [];
  const discards: NonNullable<PeriodCheckResult["discards"]> = [];
  const still: PriceHold[] = [];
  if (!onSourceHost(source, release.url)) reasons.push(`发布页链接 ${release.url} 不在登记的主机上或不是 https`);
  // Period averages need a completed period; published daily fixings may belong to today.
  const today = beijingDate(now);
  // Daily fetchers (Bank of Russia, Cochilco, the RMB central parity) verify the source date: a fixing of today may be
  // published today; a future one is still refused.
  if (period.end > today || (period.end === today && source.frequency !== "day"))
    reasons.push(`所属期${period.label}还没结束（最后一天 ${period.end}，北京时间今天 ${today}）`);
  // With nothing stored for the source (the first run) there is nothing to be older than.
  if (newest && period.start < newest) reasons.push(`所属期${period.label}比库里最新一期（${newest} 开始）旧`);
  // With no period stored before this one, the row count and ratio checks have nothing to compare with.
  const compare = compareWithPrevious && Boolean(previous?.size);
  if (compareWithPrevious && !compare) notes.push("没有上一期");
  // Counted over the series still enabled, so stopping a few never holds every later period back.
  const before = items.filter((item) => previous?.has(item.key)).length;
  if (compare && rows.length * 2 < before) reasons.push(`只有 ${rows.length} 行，不到上一期仍启用的 ${before} 个品种的一半`);
  const [low, high] = RATIO[source.frequency];
  const within = (ratio: number) => ratio >= low && ratio <= high;
  const band = `${low}–${high} 倍`;
  let compared = 0;
  /** The value against a base: a jump held alone when outside the band. */
  const judge = (key: string, value: string, was: string, what: string) => {
    compared += 1;
    const ratio = Number(value) / Number(was);
    if (!within(ratio)) jumps.push({ key, value, was, reason: `${key} 是 ${value}，是${what} ${was} 的 ${ratio.toFixed(2)} 倍，超出 ${band}` });
  };
  for (const item of items) {
    const found = rows.filter((row) => row.key === item.key);
    if (found.length !== 1) {
      reasons.push(`${item.key} 出现 ${found.length} 次`);
      continue;
    }
    const { unit, value } = found[0]!;
    const was = previous?.get(item.key);
    if (unit !== item.sourceUnit) reasons.push(`${item.key} 的单位是“${unit}”，不是“${item.sourceUnit}”`);
    if (!/^-?\d+(\.\d+)?$/.test(value)) {
      reasons.push(`${item.key} 的数值“${value}”不是数字`);
      continue;
    }
    if (Number(value) <= 0) {
      reasons.push(`${item.key} 的数值 ${value} 不大于 0`);
      continue;
    }
    const hold = holds?.get(item.key);
    if (hold && hold.periodStart < period.start) {
      // The next period decides a value held in an earlier one, compared with that value, whatever else is skipped.
      compared += 1;
      const ratio = Number(value) / Number(hold.value);
      const against = `${period.label} 是 ${value}，是被扣下的${hold.periodLabel} ${hold.value} 的 ${ratio.toFixed(2)} 倍`;
      if (within(ratio)) {
        releases.push({ key: item.key, hold, reason: `${against}，在 ${band}内：新水平得到确认，两期一起入库` });
        continue;
      }
      discards.push({ key: item.key, hold, reason: `${against}，超出 ${band}：被扣下的值不补入，本期按上次入库的值检查` });
      if (!compareWithPrevious) continue;
      const base = accepted?.get(item.key);
      if (base === undefined) notes.push(`${item.key} 没有入库过的值，跳过它的倍数检查`);
      else judge(item.key, value, base, "上次入库的");
      continue;
    }
    // A value already in the table for this period (stored by force, or before) went in once; it is not held again.
    if (current?.has(item.key) && Number(current.get(item.key)) === Number(value) && !hold) continue;
    if (compare && was === undefined) notes.push(`上一期没有 ${item.key}，跳过它的倍数检查`);
    else if (compare) judge(item.key, value, was!, "上一期");
    // The held period read again: the same value stays held; another value, or one now within the band, replaces it.
    if (hold && hold.periodStart === period.start) {
      const jump = jumps.find((one) => one.key === item.key);
      if (jump && Number(jump.value) === Number(hold.value)) {
        jumps.splice(jumps.indexOf(jump), 1);
        still.push(hold);
      } else {
        const why = !compare
          ? `同一期这次不作倍数比较，按读到的 ${value} 入库`
          : jump
            ? `同一期重读为 ${value}，仍超出 ${band}，改按新值扣下`
            : `同一期重读为 ${value}，已在 ${band}内`;
        discards.push({ key: item.key, hold, reason: `${why}：原扣下的 ${hold.value} 作废` });
      }
    }
  }
  // Most series jumping together is a misread (a unit or column shift), not the market: the period is held whole.
  if (jumps.length >= 2 && jumps.length * 2 > compared) {
    reasons.push(`${jumps.length} 个品种同时超出 ${band}（共比较 ${compared} 个），像是读错了而不是行情变化：${jumps.map((jump) => jump.reason).join("；")}`);
    jumps.length = 0;
  }
  return {
    reasons,
    notes,
    ...(jumps.length ? { jumps } : {}),
    ...(releases.length ? { releases } : {}),
    ...(discards.length ? { discards } : {}),
    ...(still.length ? { still } : {}),
  };
}
