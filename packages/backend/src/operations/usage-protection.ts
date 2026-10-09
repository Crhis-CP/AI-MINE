import { config } from "../config.ts";
import { UsageBreaker, UsageConfigRecord } from "@amp/contracts/http/private";
import { sweepModelConnectionProbes } from "../providers/model-probe.ts";
import { dbOf } from "../db.ts";
import { newUuid } from "../lib/ids.ts";
import { sendAlert } from "../notify/feishu.ts";
import { evaluateUsageProtection, usageLock } from "../providers/usage-protection.ts";
const sql = dbOf("ai-gateway");
type EventRow = { id: string; kind: string; lane: string | null; capability: string | null; payload: Record<string, unknown>; created_at: Date };
type Sender = (title: string, lines: string[]) => Promise<"sent" | "disabled" | "failed">;
/** Alert groups use the existing transport. A delivery with an unknown outcome is retained, never blindly resent. */
export async function deliverUsageProtectionEvents(now = new Date(), send: Sender = sendAlert) {
  const groups = await sql.begin(async (db) => {
    await usageLock(db);
    const rows = await db<
      EventRow[]
    >`SELECT id,kind,lane,capability,payload,created_at FROM ai.usage_protection_events WHERE delivery_status IN ('pending','disabled') ORDER BY created_at LIMIT 500`;
    const groups = new Map<string, EventRow[]>();
    for (const r of rows) {
      const key = ["warning", "opened"].includes(r.kind) ? `${r.kind}:${r.lane}:${r.capability}` : r.id;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const claimed: Array<{
      ids: string[];
      delivery: string;
      kind: string;
      payloads: Record<string, unknown>[];
      lane: string | null;
      capability: string | null;
    }> = [];
    for (const rows of groups.values()) {
      const first = rows[0]!;
      if (["warning", "opened"].includes(first.kind)) {
        const [recent] =
          await db`SELECT id FROM ai.usage_protection_events WHERE kind=${first.kind} AND lane IS NOT DISTINCT FROM ${first.lane} AND capability IS NOT DISTINCT FROM ${first.capability} AND delivery_status='sent' AND sent_at>${new Date(now.getTime() - 3600000)} LIMIT 1`;
        if (recent) continue;
      }
      const ids = rows.map((r) => r.id),
        delivery = newUuid();
      await db`UPDATE ai.usage_protection_events SET delivery_status='unknown',delivery_id=${delivery} WHERE id=ANY(${ids}::text[]) AND delivery_status IN ('pending','disabled')`;
      claimed.push({ ids, delivery, kind: first.kind, payloads: rows.map((r) => r.payload), lane: first.lane, capability: first.capability });
    }
    return claimed;
  });
  for (const g of groups) {
    const titles: Record<string, string> = {
      warning: "费用异常预警",
      opened: "费用异常熔断",
      recovered: "费用熔断已恢复",
      usage_notice: "用量提示",
      configuration_changed: "用量保护配置已修改",
      configuration_missing: "费用保护需要补配置",
      unknown_usage: "未知费用需要核对",
    };
    let state: "sent" | "pending" | "disabled" | "unknown" = "unknown";
    try {
      const sent = await send(titles[g.kind] ?? "用量保护", [
        `范围：${g.lane ?? "全站记账"}${g.capability ? ` / ${g.capability}` : ""}`,
        ...g.payloads.flatMap((p) => usageEventLines(g.kind, p)),
        g.kind === "warning"
          ? "这是预警，尚未暂停任何处理；达到阈值将暂停该范围的新付费调用。"
          : g.kind === "usage_notice"
            ? "这只是提示，没有暂停任何处理。"
            : g.kind === "opened"
              ? "只暂停命中范围的新付费调用，公开阅读和已有回执复用保持可用。"
              : "变更记录已保留。",
        `查看及恢复：${config.siteUrl}/admin/usage-models/settings`,
      ]);
      state = sent === "failed" ? "pending" : sent;
    } catch {
      /* Unknown delivery is not automatically repeated. */
    }
    await sql`UPDATE ai.usage_protection_events SET delivery_status=${state},sent_at=${state === "sent" ? now : null} WHERE id=ANY(${g.ids}::text[]) AND delivery_id=${g.delivery}`;
  }
  return groups.length;
}
/** Existing worker scheduling root runs this every five minutes; never called by a reader request. */
export async function usageProtectionTick(now = new Date(), send: Sender = sendAlert) {
  const result = await evaluateUsageProtection(now);
  await deliverUsageProtectionEvents(now, send);
  await sweepModelConnectionProbes();
  return result;
}

const money = (value: unknown) =>
  typeof value === "string" && /^\d+$/.test(value)
    ? `${BigInt(value) / 1000000n}.${
        String(BigInt(value) % 1000000n)
          .padStart(6, "0")
          .replace(/0+$/, "") || "0"
      }元`
    : "金额未确认";
function usageEventLines(kind: string, p: Record<string, unknown>): string[] {
  const breaker = UsageBreaker.safeParse(p);
  if (breaker.success) {
    const b = breaker.data;
    return [
      `指标：${{ repeated_input: "同一输入重复付费", object_cost: "单对象累计费用", daily_total: "单日费用异常" }[b.trigger]}`,
      `涉及：${b.scope.lane === "policy" ? "法规" : "资讯"} / ${b.scope.capability ?? b.scope.object_id ?? "对象"}${b.scope.source_id ? ` / 来源 ${b.scope.source_id}` : ""}`,
      b.trigger === "repeated_input"
        ? `当前重复${b.current.repeats}次，预警${b.threshold.warning}次，熔断${b.threshold.limit}次。`
        : `当前${money(b.current.micros)}；${b.trigger === "object_cost" ? `预警${money(b.threshold.warning_micros)}，熔断>${money(b.threshold.micros)}` : `历史${b.current.history_days}天合计${money(b.current.history_micros)}，日均倍数${b.threshold.multiple}，绝对额>${money(b.threshold.floor_micros)}，无历史>${money(b.threshold.no_history_micros)}`}`,
      ...(kind === "recovered" ? [`恢复人：${b.recovered_by}；备注：${b.recovery_reason}`] : []),
    ];
  }
  if (kind === "usage_notice")
    return [
      `本月累计${money(p.cumulative_micros)}，距上次提示增加${money(p.increment_micros)}。`,
      `已跨过${money(p.previous_threshold_micros)}之后至${money(p.crossed_through_micros)}的提示档位。`,
      ...(Array.isArray(p.top)
        ? p.top.map((v) => {
            const r = v as { kind: string; context: Record<string, unknown>; micros: string };
            return `${r.kind === "lane_month" ? "业务线" : r.kind === "capability_month" ? "能力" : "来源"}：${r.context.capability ?? (Array.isArray(r.context.source_ids) ? r.context.source_ids.join("、") || "未归属" : r.context.lane)} ${money(r.micros)}`;
          })
        : []),
    ];
  if (kind === "unknown_usage") return [`未确认占用${money(p.micros)}；最早记录：${p.oldest ?? "未提供"}。`];
  const after = UsageConfigRecord.safeParse(p.after);
  if (after.success) {
    const b = after.data.config.breaker;
    return [
      `原因：${after.data.reason}`,
      `配置版本${after.data.version}：重复${b.repeat_count}次/${b.repeat_window_seconds}秒；资讯${money(b.news_object_micros)}；法规${money(b.policy_object_micros)}；日费用${b.daily_multiple}倍且>${money(b.daily_floor_micros)}，无历史>${money(b.daily_no_history_micros)}；预警比例${Number(b.warning_ratio) * 100}%。`,
    ];
  }
  return [String(p.reason ?? "人民币价格配置已更新，历史费用记录保持原依据。")];
}
