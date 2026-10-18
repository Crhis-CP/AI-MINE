import { apiFetch } from "@amp/web/extension";
import { useState } from "react";
import { Link, data as withHeaders, useLoaderData } from "react-router";
import type { LoaderFunctionArgs, MetaArgs } from "react-router";
import { schemas as publicSchemas } from "@amp/contracts/http/public";
import { PolicyReportDetailQuery } from "@amp/contracts/http/public";
import { PolicyReportFilters } from "./features/PolicyReportFilters";
import { apiBaseFor } from "@amp/web/extension.server";
import { pageMeta } from "@amp/web/extension";
import { PolicyError, policyCache, PolicyTabs, Section, timeLabel, policyHref, actionClass, usePolicyRecheck } from "./features/PolicyUI";
export async function loader({ request, params }: LoaderFunctionArgs) {
  const parsed = PolicyReportDetailQuery.safeParse(
    Object.fromEntries([...new URL(request.url).searchParams].filter(([key, value]) => key !== "_routes" && value !== "")),
  );
  if (!parsed.success) throw withHeaders(null, { status: 400 });
  const result = await apiFetch("/api/site/policies/reports/{id}", {
    params: { path: { id: params.id! }, query: parsed.data },
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
    baseUrl: apiBaseFor("/api/site/policies"),
  });
  if (!result.ok) throw withHeaders(null, { status: [404, 409, 410].includes(result.status) ? result.status : 503 });
  return { report: publicSchemas.PolicyReport.parse(await result.json()), query: parsed.data };
}
export const headers = policyCache;
export const ErrorBoundary = PolicyError;
export function meta({ loaderData, params }: MetaArgs<typeof loader>) {
  return pageMeta({ title: loaderData?.report.title ?? "法规汇总", path: `/policies/reports/${params.id!}` });
}
export default function PolicyReportPage() {
  const { report, query } = useLoaderData<typeof loader>();
  return <Report key={`${report.content_version}:${JSON.stringify(query)}`} initial={report} query={query} />;
}
function Report({ initial, query }: { initial: Awaited<ReturnType<typeof loader>>["report"]; query: Awaited<ReturnType<typeof loader>>["query"] }) {
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
      const response = await apiFetch("/api/site/policies/reports/{id}", {
        params: { path: { id: report.id }, query: { ...query, cursor: report.next_cursor } },
        signal: AbortSignal.timeout(15_000),
        baseUrl: location.origin,
      });
      if ([404, 409, 410].includes(response.status)) return setInvalid(true);
      if (!response.ok) throw new Error("unavailable");
      const next = publicSchemas.PolicyReport.parse(await response.json());
      if (next.content_version !== report.content_version || next.id !== report.id || next.edition !== report.edition) return setInvalid(true);
      const groups = structuredClone(report.groups);
      for (const incoming of next.groups) {
        const existing = groups.find((g) => g.kind === incoming.kind);
        if (!existing) groups.push(incoming);
        else
          for (const document of incoming.documents) {
            const previous = existing.documents.find((d) => d.policy.id === document.policy.id);
            if (!previous) existing.documents.push(document);
            else
              for (const version of document.versions)
                if (
                  !previous.versions.some(
                    (v) =>
                      v.policy_version_id === version.policy_version_id &&
                      v.expression_id === version.expression_id &&
                      v.document_revision_id === version.document_revision_id,
                  )
                )
                  previous.versions.push(version);
          }
      }
      setReport({
        ...next,
        groups,
        pending_interpretations: [...new Map([...report.pending_interpretations, ...next.pending_interpretations].map((p) => [p.id, p])).values()],
      });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const filters = new URLSearchParams();
  if (query.jurisdiction) filters.set("jurisdiction", query.jurisdiction);
  if (query.theme) filters.set("theme", query.theme);
  const editionHref = (edition?: number) =>
    `/policies/reports/${encodeURIComponent(report.id)}?${new URLSearchParams({ ...Object.fromEntries(filters), ...(edition ? { edition: String(edition) } : {}) })}`;
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
      <Link
        to={`/policies/reports?${new URLSearchParams({ ...Object.fromEntries(filters), kind: report.type === "policy_weekly" ? "weekly" : "monthly" })}`}
        className="text-[13px] text-accent"
      >
        ← 返回法规汇总
      </Link>
      <h1 className="mt-4 text-[26px] font-semibold">{report.title}</h1>
      <PolicyTabs active={report.type === "policy_weekly" ? "weekly" : "monthly"} />
      <PolicyReportFilters query={query} jurisdictions={report.coverage.map((row) => row.jurisdiction)} />
      <nav aria-label="报告修订版本" className="mt-3 flex gap-4 text-[13px] text-accent">
        {report.edition > 1 && report.correction_of && <Link to={editionHref(report.edition - 1)}>核对上一修订版</Link>}
        {query.edition && <Link to={editionHref()}>查看最新修订</Link>}
      </nav>
      {report.change && (
        <p className="mt-2 text-[12px] text-ink-3">
          本次新增 {report.change.added} 条版本记录，移除 {report.change.removed} 条；
          {report.change.reason === "initial" ? "首次汇编" : "公开版本或来源检查依据发生变化"}。
        </p>
      )}
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
                  {v.main_points?.length ? (
                    <ul className="mt-2 list-disc pl-5">
                      {v.main_points.map((point) => (
                        <li key={`${point.clause_ref}:${point.text}`}>
                          {point.clause_ref}：{point.text}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {v.impacts?.map((impact) => (
                    <div key={impact.id} className="mt-2">
                      <p>
                        {impact.affected_actor}：{impact.impact}
                      </p>
                      <p>
                        适用对象：{impact.legal_actor}；范围：{impact.region}
                      </p>
                      <p>
                        {impact.condition && `条件：${impact.condition}`}；活动：{impact.activity}；{impact.effect_mode === "direct" ? "直接" : "间接"}影响
                      </p>
                      {impact.exceptions && <p>例外：{impact.exceptions}</p>}
                      {impact.deadline && <p>期限：{timeLabel(impact.deadline)}</p>}
                    </div>
                  ))}
                  {v.evidence_references?.length ? (
                    <details className="mt-2">
                      <summary>本版条款与影响依据</summary>
                      {v.evidence_references.map((e) => (
                        <p key={e.evidence_id}>
                          <a className="text-accent" href={e.source.original_url} target="_blank" rel="noopener noreferrer">
                            {e.source.title_original}
                          </a>{" "}
                          · {e.locator}：{e.excerpt}
                        </p>
                      ))}
                    </details>
                  ) : null}
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
