import type { z } from "zod";
import type { privateSchemas } from "@amp/api-client/private";
import { Badge, Card, Empty } from "./ui";
import { bj, num } from "./format";
export type SourceTargetsData = z.infer<typeof privateSchemas.SourceTargetsResponse>;
const labels = { unmatched: "尚无匹配配置", configured: "已匹配配置", observed: "已有新系统记录", needs_address: "原表地址待核" };
/** Each evidence dimension stays separate; no manually set “connected” state exists. */
export function SourceTargets({ data }: { data: SourceTargetsData }) {
  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ["原始记录", data.total_original_records],
          ["去重目标", data.total_targets],
          ["已匹配配置", data.counts.configured + data.counts.observed],
          ["尚待匹配或核址", data.counts.unmatched + data.counts.needs_address],
        ].map(([label, value]) => (
          <Card key={label}>
            <p className="text-[12px] text-ink-3">{label}</p>
            <p className="num mt-1 text-[24px] font-semibold">{num(Number(value))}</p>
          </Card>
        ))}
      </div>
      <Card title="原表目标与现有记录" pad={false} right={<span>本次读取 {bj(data.as_of, true)}</span>}>
        {!data.items.length ? (
          <Empty>没有符合筛选条件的原表目标。</Empty>
        ) : (
          <div className="divide-y divide-line">
            {data.items.map((target) => (
              <details key={target.id} className="group px-4 py-4">
                <summary className="cursor-pointer list-none">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-[14px] font-semibold leading-6">{target.institutions.join(" / ") || "原表未注明机构"}</h3>
                      <p className="mt-1 text-[12px] text-ink-3">
                        {[target.country_names.join(" / "), target.subnational.filter(Boolean).join(" / "), target.source_types.join(" / ")]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                    <Badge tone={target.state === "needs_address" ? "warn" : target.state === "unmatched" ? "muted" : "accent"}>{labels[target.state]}</Badge>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-ink-3">
                    <span>原表记录 {target.record_ids.length}</span>
                    <span>关联配置 {target.sources.length}</span>
                    <span>7天成功抓取 {num(target.sources.reduce((n, s) => n + s.fetch_successes_7d, 0))}</span>
                    <span className="ml-auto text-accent group-open:hidden">查看依据 ↓</span>
                  </div>
                </summary>
                <div className="mt-4 space-y-4 border-t border-line pt-4">
                  <p className="break-all text-[12px]">
                    原表网址：
                    {target.url ? (
                      <a href={target.url} target="_blank" rel="noreferrer" className="text-accent underline">
                        {target.url}
                      </a>
                    ) : (
                      "未取得可用地址"
                    )}
                  </p>
                  <ul className="space-y-1 text-[12px] text-ink-3">
                    {target.records.map((record) => (
                      <li key={record.id}>
                        {record.sheet} · 第{record.row}行 · {record.name}（{record.id}）
                      </li>
                    ))}
                  </ul>
                  {target.sources.length ? (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[760px] text-[12px]">
                        <thead className="border-b border-line text-left text-ink-3">
                          <tr>
                            <th className="w-[250px] py-2">新系统来源</th>
                            <th className="w-[110px] py-2 text-right">7天抓取成功/失败</th>
                            <th className="w-[100px] py-2 text-right">材料记录</th>
                            <th className="w-[110px] py-2 text-right">正文 / 法规原件</th>
                            <th className="w-[100px] py-2 text-right">发布投影记录</th>
                            <th className="px-3 py-2">最近成功</th>
                          </tr>
                        </thead>
                        <tbody>
                          {target.sources.map((source) => (
                            <tr key={source.source_id} className="border-b border-line/60 last:border-0">
                              <td className="py-3 pr-3">
                                <a href={`/admin/sources/${encodeURIComponent(source.source_id)}`} className="font-medium text-accent">
                                  {source.name}
                                </a>
                                <p className="mt-1 text-ink-3">
                                  {source.lane === "news" ? "资讯线" : "法规线"} · {source.enabled ? "已启用" : "未启用"}
                                </p>
                              </td>
                              <td className="num py-3 text-right">
                                {source.fetch_successes_7d} / {source.fetch_failures_7d}
                              </td>
                              <td className="num py-3 text-right">{source.material_records}</td>
                              <td className="num py-3 text-right">
                                {source.body_records} / {source.original_records}
                              </td>
                              <td className="num py-3 text-right">{source.publication_records}</td>
                              <td className="px-3 py-3 whitespace-nowrap">
                                {source.last_fetch_success ? bj(source.last_fetch_success, true) : "尚无成功记录"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="rounded-control bg-bg-sunk p-3 text-[12px] text-ink-3">
                      当前尚未找到同一规范化入口地址的采集配置。原表的旧配置和历史观察不会算作新系统进度。
                    </p>
                  )}
                  <p className="text-[12px] leading-5 text-ink-3">
                    以上为不同阶段的记录，不能相互替代；来源改过配置、权限或发生过撤回时，历史记录仍可能保留。当前配置、目录完整性及持续运行须分别核验。
                  </p>
                </div>
              </details>
            ))}
          </div>
        )}
      </Card>
      <details className="mt-5 rounded-control border border-line bg-raised p-4">
        <summary className="cursor-pointer text-[13px] font-medium">按国家查看原表覆盖</summary>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[440px] text-[12px]">
            <thead className="border-b border-line text-left text-ink-3">
              <tr>
                <th className="py-2">国家</th>
                <th className="py-2 text-right">原表目标</th>
                <th className="py-2 text-right">匹配配置</th>
                <th className="py-2 text-right">观察到记录</th>
              </tr>
            </thead>
            <tbody>
              {data.coverage.map((row) => (
                <tr key={row.country} className="border-b border-line/60">
                  <td className="py-2">{row.name}</td>
                  <td className="num py-2 text-right">{row.total}</td>
                  <td className="num py-2 text-right">{row.configured}</td>
                  <td className="num py-2 text-right">{row.observed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <details className="mt-3 rounded-control border border-line p-4">
        <summary className="cursor-pointer text-[13px] font-medium">对账口径与缺项</summary>
        <ul className="mt-3 list-disc space-y-2 pl-4 text-[12px] leading-5 text-ink-3">
          {data.limitations.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </details>
    </>
  );
}
