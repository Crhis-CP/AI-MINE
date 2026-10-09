import { useState } from "react";
import { Link, data as withHeaders, useLoaderData } from "react-router";
import type { Route } from "./+types/policy-report";
import { createPublicClient, publicSchemas } from "@amp/api-client/public";
import { apiBaseFor } from "../../api-target.ts";
import { pageMeta } from "../lib/seo.ts";
import { PolicyError, policyCache, PolicyTabs, Section, timeLabel, policyHref, actionClass, usePolicyRecheck } from "../features/policy/PolicyUI";
export async function loader({ request, params }: Route.LoaderArgs) {
  const result = await createPublicClient({ baseUrl: apiBaseFor("/api/site/policies") }).GET("/api/site/policies/reports/{id}", {
    params: { path: { id: params.id } },
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
  });
  if (!result.response.ok) throw withHeaders(null, { status: [404, 409, 410].includes(result.response.status) ? result.response.status : 503 });
  return publicSchemas.PolicyReport.parse(result.data);
}
export const headers = policyCache;
export const ErrorBoundary = PolicyError;
export function meta({ loaderData, params }: Route.MetaArgs) {
  return pageMeta({ title: loaderData?.title ?? "法规汇总", path: `/policies/reports/${params.id}` });
}
export default function PolicyReportPage() {
  const initial = useLoaderData<typeof loader>();
  return <Report key={initial.content_version} initial={initial} />;
}
function Report({ initial }: { initial: Awaited<ReturnType<typeof loader>> }) {
  const [report, setReport] = useState(initial),
    [failed, setFailed] = useState(false),
    [invalid, setInvalid] = useState(false),
    [busy, setBusy] = useState(false);
  usePolicyRecheck();
  const more = async () => {
    if (!report.next_cursor || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const response = await createPublicClient({ baseUrl: location.origin }).GET("/api/site/policies/reports/{id}", {
        params: { path: { id: report.id }, query: { cursor: report.next_cursor, limit: 20 } },
      });
      if ([404, 409, 410].includes(response.response.status)) return setInvalid(true);
      if (!response.response.ok) throw new Error("unavailable");
      const next = publicSchemas.PolicyReport.parse(response.data);
      if (next.content_version !== report.content_version || next.id !== report.id || next.edition !== report.edition) return setInvalid(true);
      const groups = structuredClone(report.groups);
      for (const incoming of next.groups) {
        const existing = groups.find((g) => g.kind === incoming.kind);
        if (existing) existing.documents.push(...incoming.documents);
        else groups.push(incoming);
      }
      setReport({ ...next, groups });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const kinds = { domestic: "境内", foreign: "境外", organizations: "欧盟与国际组织" };
  const labels = { period_change: "期间内来源变化", source_date_unknown: "来源日期尚未确认", backfill: "补录", interpretation_update: "解读更新" };
  const systemTime = (v: string) => new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  if (invalid)
    return (
      <div className="pt-6">
        <h1 className="text-[24px] font-semibold">汇总内容已更新</h1>
        <Link to="/policies/reports?kind=weekly" className="mt-4 inline-block text-accent">
          返回法规汇总重新读取
        </Link>
      </div>
    );
  return (
    <article className="mx-auto max-w-[var(--page-max-reading)] pb-10 pt-5">
      <Link to={`/policies/reports?kind=${report.type === "policy_weekly" ? "weekly" : "monthly"}`} className="text-[13px] text-accent">
        ← 返回法规汇总
      </Link>
      <h1 className="mt-4 text-[26px] font-semibold">{report.title}</h1>
      <PolicyTabs active={report.type === "policy_weekly" ? "weekly" : "monthly"} />
      <p className="mt-4 text-[13px] text-ink-3">
        覆盖期间：{systemTime(report.period_start)} 至 {systemTime(report.period_end)}（右开，北京时间）
      </p>
      <p className="mt-2 text-[12px] text-ink-4">
        出刊：{systemTime(report.issued_at)} · 第 {report.edition} 版 · {report.item_count} 份文书
      </p>
      <p className="mt-3 text-[13px] leading-6 text-ink-3">{report.coverage_note}</p>
      {report.groups.map((group) => (
        <Section key={group.kind} title={kinds[group.kind]}>
          {group.documents.map(({ policy, versions }) => (
            <div key={policy.id} className="mb-5">
              <h3 className="text-[17px] font-semibold">{policy.title}</h3>
              <p className="mt-1 text-[12px] text-ink-3">
                {policy.jurisdictions.map((j) => j.label).join("、")} · {policy.themes.map((t) => t.label).join("、")}
              </p>
              {versions.length > 1 && (
                <p className="mt-2 text-[12px] text-ink-4">本期收录 {versions.length} 个公开版本记录，逐版列示；版本差异不自动等于法律修订。</p>
              )}
              {versions.map((v) => (
                <div key={`${v.expression_id}:${v.document_revision_id}`} className="mt-3 border-l-2 border-line pl-3 text-[13px] leading-6">
                  <p>
                    {labels[v.label]} · {timeLabel(v.published_time)} · {v.instrument_number ?? "文号尚未确认"} · {v.language}
                  </p>
                  <p>
                    原文版本：{v.original_version}；本站公开：{timeLabel(v.first_public_at)}；原件留存核对：{timeLabel(v.checked_at)}
                  </p>
                  {v.public_after_period_end && <p>期末后公开：{timeLabel(v.first_public_at)}</p>}
                  <p>{v.summary}</p>
                  <Link
                    className="text-accent"
                    to={`${policyHref(policy.id)}?${new URLSearchParams({ policy_version_id: v.policy_version_id, expression_id: v.expression_id, document_revision_id: v.document_revision_id })}`}
                  >
                    核对本版适用条件、完整中文及原文证据 →
                  </Link>
                </div>
              ))}
            </div>
          ))}
        </Section>
      ))}
      <Section title="本期已发现但尚未完成解读的重要文件">
        {report.pending_interpretations.length ? (
          report.pending_interpretations.map((p) => (
            <p key={p.id} className="mb-2 text-[13px]">
              <Link to={policyHref(p.id)} className="text-accent">
                {p.title}
              </Link>{" "}
              · {p.authority.name} · {timeLabel(p.published_time)} · 基本事实
            </p>
          ))
        ) : (
          <p className="text-[13px] text-ink-3">当前没有可列示的已核实基本事实，不代表没有新法规。</p>
        )}
      </Section>
      <details className="mt-6 text-[12px] text-ink-3">
        <summary className="cursor-pointer font-semibold">本期来源检查说明</summary>
        <p className="mt-3">一次结构完整回执不代表该来源已全量覆盖或持续供给；未取得回执不能理解为没有新法规。</p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left">
            <caption className="sr-only">来源检查统计</caption>
            <thead>
              <tr>
                {["国家与组织", "登记来源", "完整回执", "不完整回执", "缺完整回执"].map((t) => (
                  <th key={t} className="whitespace-nowrap border-b border-line p-2">
                    {t}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.coverage.map((c) => (
                <tr key={c.jurisdiction.code}>
                  <td className="p-2">{c.jurisdiction.label}</td>
                  {[c.registered_source_count, c.complete_receipt_count, c.incomplete_receipt_count, c.missing_receipt_count].map((n, i) => (
                    <td key={`${c.jurisdiction.code}:${["registered", "complete", "incomplete", "missing"][i]}`} className="p-2">
                      {n}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {report.coverage.flatMap((c) =>
          c.failures.map((f) => (
            <p key={`${c.jurisdiction.code}:${f.category}:${f.start}`} className="mt-2">
              {c.jurisdiction.label} · {f.category} · {systemTime(f.start)} 至 {f.end ? systemTime(f.end) : "仍未恢复"}
            </p>
          )),
        )}
      </details>
      {failed && (
        <p role="status" className="mt-3 text-[13px] text-amber-ink">
          暂时无法继续读取本版汇总，已载入内容仍保留。
        </p>
      )}
      {report.next_cursor && (
        <button type="button" disabled={busy} className={`${actionClass} mt-4`} onClick={() => void more()}>
          继续读取本版汇总
        </button>
      )}
      <footer className="mt-6 border-t border-line pt-3 text-[12px] text-ink-4">{report.limitation} · AI 辅助生成/翻译</footer>
    </article>
  );
}
