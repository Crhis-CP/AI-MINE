// The Monday source-health report for the ops chat. It goes through the same gated channel as the
// alerts (off unless FEISHU_INTERNAL_ENABLED).
import { sourceWeeklyItems } from "../content/source-health.ts";
import { weeklySelectedCount } from "../publication/operational-snapshot.ts";
import { sourceWeeklyCounts, sourceHealth, SOURCE_PROBLEMS, rhythmText } from "../sources/health.ts";
import { sendAlert } from "../notify/feishu.ts";
import { previousRecordedRun } from "../admin/runs.ts";
import { z } from "zod";
import { addDays, beijingDate } from "@amp/contracts/time";

export { usageWeekly } from "./usage-weekly.ts";
export { usageMonthly } from "./usage-monthly.ts";

const pct = (a: number, b: number) => (b ? `${a >= b ? "+" : ""}${(((a - b) / b) * 100).toFixed(0)}%` : "—");
const n = (v: number) => v.toLocaleString("en-US");

/** Monday 09:00: how the sources did over the last seven days. */
export async function sourceHealthWeekly(now = Date.now()) {
  const since = new Date(now - 7 * 86400_000);
  const before = new Date(now - 14 * 86400_000);
  const [counts, items, selected, groups] = await Promise.all([
    sourceWeeklyCounts(since),
    sourceWeeklyItems(since, before, new Date(now)),
    weeklySelectedCount(since, new Date(now)),
    sourceHealth(now),
  ]);
  const lines = [
    `本周收录 ${n(items!.week)} 条（上周 ${n(items!.prev)}，${pct(items!.week, items!.prev)}），其中精选 ${n(selected)} 条`,
    `在用信源 ${counts!.enabled} 个，本周新增 ${counts!.added} 个；抓取失败 ${counts!.failing} 个，不太稳定 ${counts!.degraded} 个`,
  ];
  for (const group of groups) {
    lines.push("", `${group.name}：${group.sources.length} 个在用信源；本周归属条目 ${n(group.sources.reduce((sum, s) => sum + s.items, 0))} 条`);
    for (const problem of SOURCE_PROBLEMS) if (group[problem.problem].length) lines.push(`${problem.title}：${group[problem.problem].length} 个信源`);
    const dailySources = new Set(SOURCE_PROBLEMS.flatMap((problem) => group[problem.problem].map((source) => source.id)));
    for (const [sources, title] of [
      [group.overdue, "超出自身更新节奏（先核对原站）"],
      [group.unknown, "7 天没有新内容（历史不足，尚不能判断是否异常）"],
    ] as const) {
      if (!sources.length) continue;
      const details = sources.filter((source) => !dailySources.has(source.id)).map((source) => `${source.name}（${source.id}）：${rhythmText(source)}`);
      lines.push(`${title}：${sources.length} 个信源${details.length ? `；${details.join("；")}` : "（已有故障明细见日报）"}`);
    }
  }
  const overdue = groups.reduce((sum, g) => sum + g.overdue.length, 0),
    silent = overdue + groups.reduce((sum, g) => sum + g.unknown.length, 0);
  const last = await previousRecordedRun("reports.source-health");
  const previous = z
    .object({ failing: z.number().int().nonnegative(), silent: z.number().int().nonnegative(), overdue: z.number().int().nonnegative() })
    .safeParse(last?.detail);
  const recent =
    last &&
    last.started_at.getTime() <= now &&
    last.finished_at &&
    last.finished_at.getTime() <= now &&
    last.finished_at.getTime() >= last.started_at.getTime() &&
    beijingDate(last.started_at) >= addDays(beijingDate(now), -7);
  if (last?.status === "ok" && recent && previous.success) {
    const change = (value: number, prior: number) => `${value >= prior ? "+" : ""}${value - prior}`;
    lines.push(
      "",
      `较上次成功运行记录的统计：抓取失败 ${change(counts.failing, previous.data.failing)} 个，超出自身节奏 ${change(overdue, previous.data.overdue)} 个，合计静默 ${change(silent, previous.data.silent)} 个。该记录不等同消息送达或质量复核完成。`,
    );
  } else {
    lines[0] = `本周收录 ${n(items!.week)} 条，其中精选 ${n(selected)} 条`;
    lines.push("", "无可比基准：最近记录未成功、未完成、缺失或超过7天的北京时间日期边界；仅列本期数量。");
  }
  const followUp = counts.failing > 0 || silent > 0 || groups.some((g) => SOURCE_PROBLEMS.some((p) => g[p.problem].length));
  lines.push(
    "",
    followUp
      ? "故障明细由系统日报发送，未送达的仍保留待发送；本报另保留未列入日报的更新节奏资料，不据静默判断故障。后台“信源”可查最近抓取错误和等待记录，“运行”可查任务状态。质量统计变化不代表问题已核实修复。"
      : "没有需要处理的信源。",
  );
  await sendAlert("📊 信源周报", lines);
  return { failing: counts.failing, silent, overdue };
}

export { refreshOperationalSnapshots } from "./operational-snapshots.ts";
export { readOperationalSnapshot, OperationsReadUnavailable } from "./read-snapshots.ts";
export { usageProtectionTick, deliverUsageProtectionEvents } from "./usage-protection.ts";
