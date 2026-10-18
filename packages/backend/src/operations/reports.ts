// The Monday source-health report for the ops chat. It goes through the same gated channel as the
// alerts (off unless FEISHU_INTERNAL_ENABLED).
import { sourceWeeklyItems } from "../content/source-health.ts";
import { weeklySelectedCount } from "../publication/operational-snapshot.ts";
import { sourceWeeklyCounts, sourceHealth, SOURCE_PROBLEMS, rhythmText } from "../sources/health.ts";
import { sendAlert } from "../notify/feishu.ts";

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
    for (const problem of SOURCE_PROBLEMS)
      if (group[problem.problem].length)
        lines.push(`${problem.title}：${group[problem.problem].map((s) => `${s.name}（${s.id}）：${problem.describe(s)}`).join("；")}`);
    if (group.overdue.length) lines.push(`超出自身更新节奏（先核对原站）：${group.overdue.map((s) => `${s.name}：${rhythmText(s)}`).join("；")}`);
    if (group.unknown.length)
      lines.push(`7 天没有新内容（历史不足，尚不能判断是否异常）：${group.unknown.map((s) => `${s.name}：${rhythmText(s)}`).join("；")}`);
  }
  const overdue = groups.reduce((sum, g) => sum + g.overdue.length, 0),
    silent = overdue + groups.reduce((sum, g) => sum + g.unknown.length, 0);
  const followUp = counts.failing > 0 || silent > 0 || groups.some((g) => SOURCE_PROBLEMS.some((p) => g[p.problem].length));
  lines.push("", followUp ? "需要处理的话，把这条转给 AI；详情在后台“信源”与“运行”页。" : "没有需要处理的信源。");
  await sendAlert("📊 信源周报", lines);
  return { failing: counts.failing, silent, overdue };
}

export { refreshOperationalSnapshots } from "./operational-snapshots.ts";
export { readOperationalSnapshot, OperationsReadUnavailable } from "./read-snapshots.ts";
export { usageProtectionTick, deliverUsageProtectionEvents } from "./usage-protection.ts";
