// The Monday usage report for the ops chat (TASK-0064; BR-COST-18 item 6): last week's paid calls by service and by
// capability against the week before, the days the request meter stopped a service, and the requests still to be
// reconciled. It reads the receipts only and calls no model. Amounts stay in their own currency; a call with no amount
// and no registered price is said to be unpriced, never 0. Sent once per week: the week sent is kept in this job's run.
import { addDays, beijingDate, beijingMidnight, isoWeekLabel, isoWeekRange } from "@amp/contracts/time";
import { latestSuccessfulRunResult } from "../admin/runs.ts";
import { dbOf } from "../db.ts";
import { CAPABILITIES } from "../editorial/models.ts";
import { beijingDay, sendAlert } from "../notify/feishu.ts";
import { autoStopsBetween, providerName } from "./alerts.ts";

const sql = dbOf("ai-gateway");

interface Row {
  service: string;
  model: string;
  purpose: string;
  current: boolean;
  basis: "actual" | "estimated" | null;
  currency: string | null;
  ok: number;
  failed: number;
  unknown: number;
  tokens_in: string;
  tokens_out: string;
  cost: string | null;
}
interface Price {
  service: string;
  model: string;
  currency: string;
  input_per_mtok: string | null;
  output_per_mtok: string | null;
  per_request: string | null;
}
interface Tally {
  ok: number;
  failed: number;
  unknown: number;
  tokensIn: number;
  tokensOut: number;
  /** By currency: the whole amount, and the part of it that is an estimate. */
  amounts: Record<string, { total: number; estimated: number }>;
  unpriced: number;
}

// As in reports.ts: no percentage against a week with nothing.
const pct = (a: number, b: number) => (b ? `${a >= b ? "+" : ""}${(((a - b) / b) * 100).toFixed(0)}%` : "—");
const n = (v: number) => v.toLocaleString("en-US");
const calls = (t: Tally) => t.ok + t.failed + t.unknown;
const money = (currency: string, v: number) => `${{ CNY: "¥", USD: "$" }[currency] ?? `${currency} `}${v.toFixed(2)}`;
const empty = (): Tally => ({ ok: 0, failed: 0, unknown: 0, tokensIn: 0, tokensOut: 0, amounts: {}, unpriced: 0 });
const capabilityOf = (purpose: string) =>
  Object.values(CAPABILITIES)
    .find((c) => (c.purposes as readonly string[]).includes(purpose))
    ?.label.split("（")[0] ?? "其他";

/** One row's calls, tokens and amount: the recorded amount, else the registered price, else unpriced. */
function add(t: Tally, row: Row, price: Price | undefined) {
  const count = row.ok + row.failed + row.unknown;
  const tokensIn = Number(row.tokens_in),
    tokensOut = Number(row.tokens_out);
  Object.assign(t, {
    ok: t.ok + row.ok,
    failed: t.failed + row.failed,
    unknown: t.unknown + row.unknown,
    tokensIn: t.tokensIn + tokensIn,
    tokensOut: t.tokensOut + tokensOut,
  });
  let amount: { currency: string; value: number; estimated: boolean } | null = null;
  if (row.basis) amount = { currency: row.currency ?? "?", value: Number(row.cost ?? 0), estimated: row.basis === "estimated" };
  else if (price && (price.input_per_mtok || price.output_per_mtok))
    amount = {
      currency: price.currency,
      value: (tokensIn / 1e6) * Number(price.input_per_mtok ?? 0) + (tokensOut / 1e6) * Number(price.output_per_mtok ?? 0),
      estimated: true,
    };
  else if (price?.per_request) amount = { currency: price.currency, value: count * Number(price.per_request), estimated: true };
  if (!amount) {
    t.unpriced += count;
    return;
  }
  t.amounts[amount.currency] ??= { total: 0, estimated: 0 };
  const slot = t.amounts[amount.currency]!;
  slot.total += amount.value;
  if (amount.estimated) slot.estimated += amount.value;
}

function line(name: string, t: Tally, before: Tally) {
  const amounts = Object.entries(t.amounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cur, a]) => {
      const change = pct(a.total, before.amounts[cur]?.total ?? 0);
      // Actual and estimated apart: all one or the other says so, a mix gives both parts.
      if (!a.estimated) return `${money(cur, a.total)}（${change}）`;
      if (a.estimated === a.total) return `估算 ${money(cur, a.total)}（${change}）`;
      return `${money(cur, a.total)}（${change}；实际 ${money(cur, a.total - a.estimated)}、估算 ${money(cur, a.estimated)}）`;
    });
  if (t.unpriced) amounts.push(`另有 ${n(t.unpriced)} 次未登记单价`);
  return (
    `· ${name}：${n(calls(t))} 次（${pct(calls(t), calls(before))}；成功 ${n(t.ok)}、失败 ${n(t.failed)}、结果未知 ${n(t.unknown)}），` +
    `输入 ${n(t.tokensIn)} token（${pct(t.tokensIn, before.tokensIn)}）、输出 ${n(t.tokensOut)} token（${pct(t.tokensOut, before.tokensOut)}），金额 ${amounts.join("、") || "无"}`
  );
}

/** Monday 09:05: last ISO week (Beijing Monday 00:00 to the next Monday 00:00) against the one before. */
export async function usageWeekly(now = Date.now()) {
  const week = isoWeekLabel(addDays(beijingDate(now), -7));
  const { start, end } = isoWeekRange(week)!;
  const from = beijingMidnight(start),
    to = beijingMidnight(addDays(end, 1)),
    before = beijingMidnight(addDays(start, -7));
  const [rows, prices, [unknown]] = await Promise.all([
    sql<Row[]>`
      SELECT a.service, coalesce(a.model, '') AS model, r.purpose, a.started_at >= ${from} AS current, a.cost_basis AS basis, a.currency,
             count(*) FILTER (WHERE a.status = 'received')::int AS ok, count(*) FILTER (WHERE a.status = 'failed')::int AS failed,
             count(*) FILTER (WHERE a.status IN ('pending', 'unknown'))::int AS unknown,
             coalesce(sum((a.usage->>'prompt_tokens')::bigint), 0) AS tokens_in, coalesce(sum((a.usage->>'completion_tokens')::bigint), 0) AS tokens_out,
             sum(a.cost) AS cost
      FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id
      WHERE a.origin = 'live' AND a.started_at >= ${before} AND a.started_at < ${to}
      GROUP BY 1, 2, 3, 4, 5, 6`,
    sql<Price[]>`SELECT service, model, currency, input_per_mtok, output_per_mtok, per_request FROM service_prices`,
    sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipts WHERE status = 'unknown'`,
  ]);
  const groups = { service: new Map<string, [Tally, Tally]>(), capability: new Map<string, [Tally, Tally]>() };
  const total: [Tally, Tally] = [empty(), empty()];
  for (const row of rows) {
    const price = prices.find((p) => p.service === row.service && p.model === row.model) ?? prices.find((p) => p.service === row.service && p.model === "");
    const at = row.current ? 0 : 1;
    for (const [map, key] of [
      [groups.service, providerName(row.service)],
      [groups.capability, capabilityOf(row.purpose)],
    ] as const) {
      if (!map.has(key)) map.set(key, [empty(), empty()]);
      add(map.get(key)![at], row, price);
    }
    add(total[at], row, price);
  }
  const listed = (map: Map<string, [Tally, Tally]>) =>
    [...map].sort(([, a], [, b]) => calls(b[0]) - calls(a[0]) || calls(b[1]) - calls(a[1])).map(([name, [t, b]]) => line(name, t, b));
  const lines = calls(total[0])
    ? [
        `上周付费调用 ${n(calls(total[0]))} 次（前一周 ${n(calls(total[1]))} 次，${pct(calls(total[0]), calls(total[1]))}）`,
        "",
        "按服务：",
        ...listed(groups.service),
        "",
        "按能力：",
        ...listed(groups.capability),
      ]
    : [`上周没有付费调用（前一周 ${n(calls(total[1]))} 次）`];
  const stops = await autoStopsBetween(from, to);
  let stopped = !stops.coveredFrom
    ? "自动暂停：上周还没有这项记录"
    : stops.days
      ? `自动暂停：上周有 ${stops.days} 天出现过自动暂停（${Object.entries(stops.byService)
          .map(([service, days]) => `${providerName(service)} ${days} 天`)
          .join("、")}）`
      : "自动暂停：上周没有出现过自动暂停";
  if (stops.coveredFrom && stops.coveredFrom.getTime() > from.getTime() + 3_600_000) stopped += `（从 ${beijingDay(stops.coveredFrom)}起才有记录）`;
  const pending = unknown?.n ?? 0;
  lines.push(
    "",
    stopped,
    pending ? `待核对：还有 ${n(pending)} 笔付费请求结果未知，请到后台“用量与模型密钥”里的“费用与投递核对”核对。` : "待核对：没有待核对的。",
    "括号里是和前一周比，“—”表示前一周是 0、没法比；金额按记录的币种分开写，不换算；“估算”是调用时记下的估算，或按登记的单价算的。",
  );
  const last = (await latestSuccessfulRunResult("reports.usage-weekly")) as { lastSentWeek?: unknown } | null;
  const lastSentWeek = typeof last?.lastSentWeek === "string" ? last.lastSentWeek : null;
  const totals = { calls: calls(total[0]), previousCalls: calls(total[1]), unpriced: total[0].unpriced, unknownReceipts: pending, autoStopDays: stops.days };
  if (lastSentWeek === week) return { week, sent: false, lastSentWeek, ...totals };
  const sent = (await sendAlert(`📈 用量周报 · ${beijingDay(from)}至${beijingDay(beijingMidnight(end))}`, lines)) === "sent";
  return { week, sent, lastSentWeek: sent ? week : lastSentWeek, ...totals };
}
