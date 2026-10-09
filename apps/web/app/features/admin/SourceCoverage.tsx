import { useState } from "react";
import type { z } from "zod";
import type { privateSchemas } from "@amp/api-client/private";
import { Card, Empty, Badge } from "./ui";
import { bj } from "./format";
export type CoverageData = z.infer<typeof privateSchemas.SourceCoverage>;
export function SourceCoverage({ data }: { data: CoverageData | null }) {
  const [selected, setSelected] = useState<{ matrix: string; row: string; column: string } | null>(null);
  if (!data)
    return (
      <Card title="来源覆盖矩阵" className="mt-5">
        <Empty>覆盖记录暂时无法读取，请稍后刷新。</Empty>
      </Card>
    );
  return (
    <div className="mt-5 space-y-5">
      {data.matrices.map((matrix) => {
        const cell = selected?.matrix === matrix.id ? matrix.cells.find((c) => c.row === selected.row && c.column === selected.column) : undefined;
        return (
          <Card key={matrix.id} title={matrix.title} pad={false}>
            <p className="px-4 pt-3 text-[12px] leading-5 text-ink-3">{matrix.explanation}</p>
            <p className="px-4 py-2 text-[12px] text-ink-3">数字依次为：目录线索 / 已匹配配置 / 已有运行记录。读取于 {bj(data.asOf, true)}</p>
            <div className="max-h-[520px] overflow-auto border-y border-line">
              <table className="w-full border-collapse text-[12px]">
                <caption className="sr-only">{matrix.title}，点击单元格查看来源和缺口依据</caption>
                <thead className="sticky top-0 z-20 bg-bg-sunk">
                  <tr>
                    <th scope="col" className="sticky left-0 z-30 min-w-[100px] border-r border-line bg-bg-sunk px-3 py-3 text-left">
                      地区 / 类别
                    </th>
                    {matrix.columns.map((column) => (
                      <th key={column.id} scope="col" className="min-w-[114px] whitespace-nowrap border-r border-line/60 px-3 py-3 font-medium">
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrix.rows.map((row) => (
                    <tr key={row.id} className="border-t border-line/60">
                      <th scope="row" className="sticky left-0 z-10 whitespace-nowrap border-r border-line bg-raised px-3 py-2 text-left font-medium">
                        {row.label}
                      </th>
                      {matrix.columns.map((column) => {
                        const c = matrix.cells.find((item) => item.row === row.id && item.column === column.id)!;
                        const active = cell === c;
                        return (
                          <td key={column.id} className="border-r border-line/60 p-1 text-center">
                            <button
                              type="button"
                              aria-label={`${row.label} · ${column.label}，${c.entries.length}条线索`}
                              aria-pressed={active}
                              onClick={() => setSelected({ matrix: matrix.id, row: row.id, column: column.id })}
                              className={`w-full rounded-control px-2 py-3 transition-colors hover:bg-accent/10 focus-visible:outline-2 focus-visible:outline-accent ${active ? "bg-accent/10 text-accent" : c.entries.length ? "bg-bg-sunk/60 text-ink-2" : "text-ink-4"}`}
                            >
                              {c.entries.length ? (
                                <span className="num">
                                  {c.entries.length} / {c.configured} / {c.observed}
                                </span>
                              ) : matrix.id === "china" ? (
                                "原表未列"
                              ) : (
                                "待研究"
                              )}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {cell && (
              <section aria-live="polite" className="space-y-3 px-4 py-4">
                <h3 className="text-[14px] font-semibold">
                  {matrix.rows.find((r) => r.id === cell.row)?.label} · {matrix.columns.find((c) => c.id === cell.column)?.label}
                </h3>
                {!cell.entries.length ? (
                  <p className="text-[13px] text-ink-3">
                    {matrix.id === "china" ? "原表未列此类机构，不能标成已经处理。" : "尚无本项目目录线索，保留为研究缺口，不能标成不适用。"}
                  </p>
                ) : (
                  <ul className="divide-y divide-line">
                    {cell.entries.map((entry) => (
                      <li key={entry.id} className="space-y-2 py-3 text-[13px]">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{entry.name}</span>
                          <Badge tone={entry.identity === "verified" ? "accent" : "muted"}>
                            {entry.identity === "verified" ? "目录身份已有核验记录" : "身份待研究"}
                          </Badge>
                        </div>
                        {entry.url && (
                          <a className="block break-all text-[12px] text-accent underline" href={entry.url} target="_blank" rel="noreferrer">
                            {entry.url}
                          </a>
                        )}
                        {entry.note && <p className="text-[12px] leading-5 text-ink-3">{entry.note}</p>}
                        <div className="flex flex-wrap gap-3 text-[12px]">
                          {entry.kind === "target" && (
                            <a className="text-accent underline" href={`/admin/sources/targets?q=${encodeURIComponent(entry.url ?? entry.name)}`}>
                              查看原表记录
                            </a>
                          )}
                          {entry.sourceIds.map((id) => (
                            <a key={id} className="text-accent underline" href={`/admin/sources/${encodeURIComponent(id)}`}>
                              查看关联来源
                            </a>
                          ))}
                          {!entry.sourceIds.length && <span className="text-ink-3">尚无匹配的运行配置</span>}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </Card>
        );
      })}
      <Card title="表外补充来源">
        <p className="mb-3 text-[12px] text-ink-3">以下配置没有与原表入口精确对应，独立展示，不计入320个目标的进度。</p>
        {!data.supplemental.length ? (
          <Empty>目前没有表外配置。</Empty>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {data.supplemental.map((source) => (
              <li key={source.id} className="flex items-center justify-between gap-3 rounded-control bg-bg-sunk p-3 text-[13px]">
                <a className="min-w-0 break-words text-accent underline" href={`/admin/sources/${encodeURIComponent(source.id)}`}>
                  {source.name}
                </a>
                <span className="shrink-0 text-[12px] text-ink-3">
                  {source.lane === "news" ? "资讯" : "法规"} · {source.enabled ? "启用" : "停用"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <ul className="list-disc space-y-2 pl-5 text-[12px] leading-5 text-ink-3">
        {data.limitations.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </div>
  );
}
