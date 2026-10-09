import { SITE } from "@amp/industry/site";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { adminGet } from "../../lib/admin.server";
import { bj, num, pct } from "../../features/admin/format";
import { AdminPage, Badge, Card, Empty } from "../../features/admin/ui";
import { SelectionToolControl, SelectionSampleLabels, SelectionStandardReviewForm } from "../../features/admin/SelectionCalibration";
import { readSelectionTool, readSelectionSamples, readSelectionStandards } from "../../features/admin/SelectionApi.server";
import { useSelectionActions } from "../../features/admin/SelectionActions";
interface RunRow {
  id: string;
  label: string;
  split: string | null;
  sample_size: number;
  prompt_version: string | null;
  models: string[];
  summary: Record<string, Record<string, number>>;
  created_at: string;
  imported_by: string | null;
  cases: number;
  calibration?: {
    standardVersion: string;
    prefilterVersion: string;
    thresholdVersion: string;
    modelConfigurations: Record<string, string | null>;
    synthetic: boolean;
  } | null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const control = await readSelectionTool(request),
    tab = new URL(request.url).searchParams.get("tab") ?? "samples";
  if (!control.enabled) return { control, tab, runs: [] as RunRow[], samples: null, standards: null };
  const [runs, samples, standards] = await Promise.all([
    tab === "runs" ? adminGet<{ runs: RunRow[] }>(request, "/api/admin/selectbench") : Promise.resolve({ runs: [] }),
    tab === "samples" ? readSelectionSamples(request) : Promise.resolve(null),
    tab === "review" ? readSelectionStandards(request) : Promise.resolve(null),
  ]);
  return { control, tab, runs: runs.runs, samples, standards };
}
export const meta: MetaFunction<typeof loader> = () => [{ title: `精选校准 · ${SITE.name} 后台` }];
export default function SelectBench({ loaderData: d }: { loaderData: Awaited<ReturnType<typeof loader>> }) {
  const { execute } = useSelectionActions(),
    [sp] = useSearchParams(),
    navigate = useNavigate();
  const select = (tab: string) => {
    const next = new URLSearchParams(sp);
    next.set("tab", tab);
    next.delete("page");
    navigate(`?${next}`);
  };
  return (
    <AdminPage title="建设期精选校准" subtitle="仅负责人使用，默认关闭。标注、结果浏览与版本确认在这里完成；页面不会运行评测或产生模型费用。">
      <div className="space-y-5">
        {!d.control.enabled ? (
          <Card>
            <Empty>建设期抽样工具未开启。开启后可查看样本与运行记录。</Empty>
          </Card>
        ) : (
          <>
            <div className="flex flex-wrap gap-2" role="tablist" aria-label="精选校准">
              {[
                ["samples", "样本标注"],
                ["runs", "运行结果"],
                ["review", "标准审阅"],
              ].map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  role="tab"
                  aria-selected={d.tab === value}
                  onClick={() => select(value!)}
                  className={`rounded-control px-4 py-2 text-sm ${d.tab === value ? "bg-ink text-bg" : "bg-surface text-ink ring-1 ring-line"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            {d.samples && (
              <SelectionSampleLabels
                data={d.samples}
                onPage={(page) => {
                  const next = new URLSearchParams(sp);
                  next.set("page", String(page));
                  navigate(`?${next}`);
                }}
                onSave={(sample, input) =>
                  execute(
                    "label",
                    { ...input, expectedRevision: sample.label?.revision ?? 0, sampleRevision: sample.sampleRevision },
                    { datasetId: sample.datasetId, caseId: sample.caseId },
                  )
                }
              />
            )}
            {d.standards && <SelectionStandardReviewForm data={d.standards} onSave={(input) => execute("review", input)} />}
            {d.tab === "runs" && (
              <>
                <p className="text-sm text-ink-3">运行结果只读。旧报告中的标签、分数或模型名字不等于真实Owner标注、模型配置证据或校准确认。</p>
                <RunList runs={d.runs} />
              </>
            )}
          </>
        )}
        <SelectionToolControl state={d.control} onChange={(input) => execute("tool", input)} />
      </div>
    </AdminPage>
  );
}
function RunList({ runs }: { runs: RunRow[] }) {
  return (
    <>
      {runs.length ? (
        <div className="space-y-4">
          {runs.map((r) => {
            const best = r.models.filter((m) => Number.isFinite(r.summary[m]?.f1)).sort((a, b) => (r.summary[b]?.f1 ?? 0) - (r.summary[a]?.f1 ?? 0))[0];
            return (
              <Card
                key={r.id}
                title={
                  <Link to={`/admin/selectbench/${r.id}`} className="hover:text-accent">
                    {r.label}
                  </Link>
                }
                right={
                  <span>
                    {bj(r.created_at, true)} · {r.split ?? "—"} · {num(r.sample_size)} 条 · {r.prompt_version ?? "提示版本未记录"}
                  </span>
                }
                pad={false}
              >
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-[13px]">
                    <thead>
                      <tr className="border-b border-line text-left text-[12px] text-ink-3">
                        {["模型", "准确率", "精确率", "召回率", "F1", "入选比例", "金标入选", "失败", "平均耗时", "输入/输出 tokens"].map((h) => (
                          <th key={h} className="px-3 py-2 font-medium">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {r.models.map((m) => {
                        const s = r.summary[m] ?? {};
                        return (
                          <tr key={m} className="border-b border-line/70 last:border-0">
                            <td className="px-3 py-2 font-medium text-ink">
                              {m} {m === best && r.models.length > 1 && <Badge tone="accent">F1 最高</Badge>}
                            </td>
                            <td className="num px-3 py-2">{pct(s.accuracy)}</td>
                            <td className="num px-3 py-2">{pct(s.precision)}</td>
                            <td className="num px-3 py-2">{pct(s.recall)}</td>
                            <td className="num px-3 py-2 font-semibold text-ink">{pct(s.f1)}</td>
                            <td className="num px-3 py-2">{pct(s.selectedRate)}</td>
                            <td className="num px-3 py-2">{pct(s.goldSelectRate)}</td>
                            <td className="num px-3 py-2">{s.errors ? <span className="text-hot">{s.errors}</span> : s.errors === 0 ? 0 : "未记录"}</td>
                            <td className="num px-3 py-2">{s.avgLatencyMs ? `${(s.avgLatencyMs / 1000).toFixed(1)}s` : "—"}</td>
                            <td className="num px-3 py-2 text-ink-3">
                              {num(s.tokensIn)} / {num(s.tokensOut)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="border-t border-line px-4 py-2 text-xs leading-relaxed text-ink-3">
                  评分标准：{r.calibration?.standardVersion ?? "缺可信版本记录"} · 预筛：{r.calibration?.prefilterVersion ?? "未记录"} · 门槛：
                  <span title={r.calibration?.thresholdVersion}>{r.calibration?.thresholdVersion.slice(0, 16) ?? "未记录"}</span>
                  {r.calibration?.synthetic ? " · 合成运行" : ""}
                </div>
                <div className="flex items-center justify-between border-t border-line px-4 py-2 text-[12.5px] text-ink-3">
                  <span>{r.cases ? `${num(r.cases)} 条逐条结果` : "只有汇总（旧格式报告）"}</span>
                  {r.cases > 0 && (
                    <Link className="text-accent" to={`/admin/selectbench/${r.id}`}>
                      逐条浏览
                    </Link>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <Empty>还没有校准运行。建设环境的评测运行器运行后会自动出现在这里。</Empty>
        </Card>
      )}
    </>
  );
}
