import { useState } from "react";
import type { z } from "zod";
import type { MonthlyUsageEntry, UsageTotals } from "@amp/contracts/http/private";
import { Badge, Card, Select } from "./ui";
import { bj } from "./format";
type Entry = z.infer<typeof MonthlyUsageEntry>;
type Totals = z.infer<typeof UsageTotals>;
const number = (value: number | null) => (value === null ? "尚未提供" : value.toLocaleString("zh-CN"));
const amount = (value: string) => {
  const [whole, fraction] = value.split("."),
    tail = fraction?.replace(/0+$/, "");
  return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${tail ? `.${tail}` : ""}`;
};
const costs = (totals: Totals) =>
  totals.amounts.length ? (
    totals.amounts.map((a) => (
      <p key={a.currency} className="num whitespace-nowrap text-[12px]">
        {a.currency} · 实际 {amount(a.actual)} · 估算 {amount(a.estimated)}
      </p>
    ))
  ) : (
    <span className="text-ink-4">未记录金额</span>
  );

export function MonthlyUsage({ entries }: { entries: Entry[] | null }) {
  const [selected, setSelected] = useState(""),
    entry = entries?.find((e) => e.report.month === selected) ?? entries?.[0];
  if (!entries)
    return (
      <Card title="月度用量" className="mb-5 mt-5">
        <p role="status" className="text-[13px] text-amber-ink">
          月度用量暂时无法读取，请稍后刷新。
        </p>
      </Card>
    );
  if (!entry)
    return (
      <Card title="月度用量" className="mb-5 mt-5">
        <p className="text-[13px] text-ink-3">尚未生成月报。每个自然月结束后，北京时间次月1日09:00起汇总；数据和通知状态分别记录。</p>
      </Card>
    );
  const { report: r } = entry,
    delivery = { pending: "尚未发送", sending: "发送结果待确认", sent: "已发送", unknown: "发送结果待核实" };
  const groups = (label: string, rows: { key: string; label: string; totals: Totals }[]) => (
    <details className="mt-4 rounded-control border border-line p-3">
      <summary className="cursor-pointer text-[13px] font-semibold">{label}</summary>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[560px] table-fixed text-left text-[12px]">
          <colgroup>
            <col className="w-44" />
            <col className="w-24" />
            <col />
            <col className="w-20" />
          </colgroup>
          <thead>
            <tr className="border-b border-line text-ink-3">
              <th className="py-2 pr-3 font-medium">项目</th>
              <th className="w-20 px-3 py-2 text-right font-medium">调用尝试</th>
              <th className="px-3 py-2 font-medium">已记录费用</th>
              <th className="w-20 py-2 pl-3 text-right font-medium">缺金额</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-line/60 last:border-0">
                <td className="py-3 pr-3">{row.label}</td>
                <td className="num px-3 text-right">{number(row.totals.calls)}</td>
                <td className="px-3 py-3">{costs(row.totals)}</td>
                <td className="num pl-3 text-right">{number(row.totals.unpriced_calls)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
  return (
    <Card
      title="月度用量"
      className="mb-5 mt-5"
      right={
        <Select aria-label="用量报告月份" className="!w-36 !py-1" value={r.month} onChange={(e) => setSelected(e.target.value)}>
          {entries.map((e) => (
            <option key={e.report.month} value={e.report.month}>
              {e.report.month}
            </option>
          ))}
        </Select>
      }
    >
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <Badge tone={entry.notification_state === "sent" ? "ok" : entry.notification_state === "unknown" ? "warn" : "muted"}>
          {delivery[entry.notification_state]}
        </Badge>
        {entry.updated_after_issue && <Badge>对账后更新 · 第{entry.revision}版</Badge>}
        <span className="text-ink-4">报告生成于 {bj(r.generated_at, true)}（北京时间）</span>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 sm:gap-3">
        {[
          ["调用尝试", r.totals.calls],
          ["结果未知", r.totals.unknown],
          ["仍在途中", r.totals.pending],
        ].map(([label, value]) => (
          <div key={label} className="rounded-control bg-bg-sunk p-3">
            <p className="text-[12px] text-ink-3">{label}</p>
            <p className="num mt-1 text-[22px] font-semibold">{number(Number(value))}</p>
          </div>
        ))}
      </div>
      <div className={`mt-4 grid gap-3 ${r.totals.amounts.length > 1 ? "sm:grid-cols-2" : ""}`}>
        {r.totals.amounts.map((a) => (
          <section key={a.currency} className="rounded-control border border-line p-3">
            <h3 className="text-[12px] font-semibold text-ink-3">{a.currency}</h3>
            <dl className="mt-2 grid grid-cols-2 gap-3">
              <div>
                <dt className="text-[12px] text-ink-3">记录的实际费用</dt>
                <dd className="num mt-1 text-[20px] font-semibold">{amount(a.actual)}</dd>
              </div>
              <div>
                <dt className="text-[12px] text-ink-3">调用时的估算</dt>
                <dd className="num mt-1 text-[20px]">{amount(a.estimated)}</dd>
              </div>
            </dl>
          </section>
        ))}
      </div>
      <p className="mt-3 text-[12px] leading-5 text-ink-3">
        不同币种分别显示；{r.totals.unpriced_calls}次调用尝试缺少可用金额，未补成0。费用记录仅作核对，不设置月度金额上限。
      </p>
      <section className="mt-4 rounded-control border border-line p-3">
        <h3 className="text-[13px] font-semibold">本期调用仍占用的金额 · 人民币</h3>
        {r.totals.protection ? (
          <>
            <dl className="mt-2 grid grid-cols-2 gap-3 text-[13px]">
              <div>
                <dt className="text-ink-3">仍在预留</dt>
                <dd className="num mt-1">{r.totals.protection.reserved_amount === null ? "尚无记录" : amount(r.totals.protection.reserved_amount)}</dd>
              </div>
              <div>
                <dt className="text-ink-3">结果未知占用</dt>
                <dd className="num mt-1">{r.totals.protection.unknown_amount === null ? "尚无记录" : amount(r.totals.protection.unknown_amount)}</dd>
              </div>
            </dl>
            <p className="mt-2 text-[12px] leading-5 text-ink-3">
              截至本次对账，覆盖{r.totals.protection.tracked_calls}次调用；{r.totals.protection.untracked_calls}
              次缺少保护记录。占用不计为已花费用，缺记录不按零处理。
            </p>
          </>
        ) : (
          <p className="mt-2 text-[12px] text-ink-3">这版历史报告未记录预留与未知占用，后续对账按已有真实记录补充。</p>
        )}
      </section>
      <div className="mt-4 grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
        <section>
          <h3 className="text-[13px] font-semibold">供应商缓存</h3>
          <p className="mt-2 text-[12px] text-ink-2">
            命中token：{number(r.totals.provider_cache_tokens)}；未命中token：{number(r.totals.provider_cache_miss_tokens)}
          </p>
          <p className="mt-1 text-[12px] text-ink-3">
            命中率：{r.totals.cache_hit_rate === null ? "尚无完整记录" : `${(r.totals.cache_hit_rate * 100).toFixed(1)}%`}，基于
            {r.totals.cache_pair_reported_calls}次完整记录。
          </p>
        </section>
        <section>
          <h3 className="text-[13px] font-semibold">本站结果复用</h3>
          <p className="mt-2 text-[12px] text-ink-2">
            {r.local_reuse.recorded_count === null ? "这一期间尚未记录复用次数" : `已记录 ${number(r.local_reuse.recorded_count)} 次，不产生新的供应商调用`}
          </p>
          <p className="mt-1 text-[12px] text-ink-3">
            从 {bj(r.local_reuse.observed_since, true)} 起记录{r.local_reuse.coverage === "partial" ? "，本期前段数据缺失。" : "。"}
          </p>
        </section>
      </div>
      {groups("按业务线", r.by_lane)}
      {groups("按处理环节", r.by_capability)}
      {groups("按服务", r.by_service)}
      {groups("按来源", r.by_source)}
      {groups("按用途", r.by_usage_purpose)}
      <details className="mt-4 rounded-control border border-line p-3">
        <summary className="cursor-pointer text-[13px] font-semibold">单篇已记录费用与金额最高的任务</summary>
        <p className="mt-2 text-[12px] text-ink-3">
          只有明确归属及金额的记录才计入单篇平均；另有{r.material_unassigned_calls}次未能归到单篇材料。不跨币种比较排名。
        </p>
        {r.material_costs.map((m) => (
          <p key={`${m.kind}:${m.currency}`} className="mt-2 text-[12px]">
            {m.kind === "article" ? "资讯" : "法规"} · {m.currency} · {m.objects}份材料 · 单篇已记录平均：实际 {amount(m.average_actual)}，估算{" "}
            {amount(m.average_estimated)}
          </p>
        ))}
        {r.top_tasks.map((g) => (
          <section key={g.currency} className="mt-4">
            <h3 className="text-[13px] font-semibold">
              {g.currency} · 金额最高的{g.items.length}个任务
            </h3>
            <ol className="mt-2 space-y-2">
              {g.items.map((item, i) => (
                <li key={item.reference} className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-[12px]">
                  <span className="min-w-0 break-all text-ink-3">
                    {i + 1}. {item.reference}
                  </span>
                  <span className="num">
                    记录合计 {amount(item.amount)}（其中估算 {amount(item.estimated)}）
                  </span>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </details>
      <details className="mt-3 text-[12px] leading-5 text-ink-3">
        <summary className="cursor-pointer">统计口径与缺项</summary>
        {r.limitations.map((text) => (
          <p key={text} className="mt-2">
            {text}
          </p>
        ))}
      </details>
    </Card>
  );
}
