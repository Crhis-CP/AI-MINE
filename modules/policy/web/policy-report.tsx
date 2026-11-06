import { apiFetch, Link } from "@amp/web/extension";
import { useTr } from "@amp/web/i18n";
import { useState } from "react";
import { data as withHeaders, useLoaderData } from "react-router";
import type { LoaderFunctionArgs, MetaArgs } from "react-router";
import { schemas as publicSchemas } from "@amp/contracts/http/public";
import { PolicyReportDetailQuery } from "@amp/contracts/http/public";
import { PolicyReportFilters } from "./features/PolicyReportFilters";
import { apiBaseFor } from "@amp/web/extension.server";
import { pageMeta } from "@amp/web/extension";
import { PolicyError, policyCache, PolicyTabs, Section, policyHref, actionClass, useKnownLabels, usePolicyRecheck } from "./features/PolicyUI";
import { policyTitle, usePolicyText } from "./features/reader";
import { beijingDate, beijingTime } from "@amp/contracts/time";
export async function loader({ request, params }: LoaderFunctionArgs) {
  const parsed = PolicyReportDetailQuery.safeParse(
    Object.fromEntries([...new URL(request.url).searchParams].filter(([key, value]) => key !== "_routes" && value !== "")),
  );
  if (!parsed.success) throw withHeaders(null, { status: 400 });
  const result = await apiFetch("/api/site/policies/reports/{id}", {
    params: { path: { id: params.id! }, query: parsed.data },
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
    baseUrl: apiBaseFor(),
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
  const tr = useTr();
  const text = usePolicyText();
  const known = useKnownLabels();
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
  const currentHref = `/policies/reports/${encodeURIComponent(report.id)}${filters.size ? `?${filters}` : ""}`;
  // Readers see corrections, not the compilation's revisions (Owner 2026-11-06, as for the daily): the one thing worth
  // a line is documents that left this issue after it was out (a withdrawal or a lost permission). Documents joining
  // a later compilation, and the revision numbers themselves, stay in the internal record.
  const removed = report.edition > 1 && report.change && report.change.reason !== "initial" ? report.change.removed : 0;
  const kinds = { domestic: tr("境内"), foreign: tr("境外"), organizations: tr("欧盟与国际组织") };
  const labels = {
    period_change: tr("期间内来源变化"),
    source_date_unknown: tr("来源日期尚未确认"),
    backfill: tr("补录"),
    interpretation_update: tr("解读更新"),
  };
  const day = (v: string) => beijingDate(v);
  const moment = (v: string) => `${beijingDate(v)} ${beijingTime(v)}`;
  /** The period as days: it starts at 00:00 of its first day and ends before 00:00 of the day after its last. */
  const lastDay = (v: string) => beijingDate(new Date(Date.parse(v) - 1).toISOString());
  if (invalid)
    return (
      <div className="pt-6">
        <h1 className="text-[24px] font-semibold">{tr("汇总内容已更新")}</h1>
        <Link to="/policies/reports?kind=weekly" className="mt-4 inline-block text-accent">
          {tr("返回法规汇总重新读取")}
        </Link>
      </div>
    );
  return (
    <article className="mx-auto max-w-[var(--page-max-reading)] pb-10 pt-5">
      <Link
        to={`/policies/reports?${new URLSearchParams({ ...Object.fromEntries(filters), kind: report.type === "policy_weekly" ? "weekly" : "monthly" })}`}
        className="text-[13px] text-accent"
      >
        {tr("← 返回法规汇总")}
      </Link>
      <h1 className="mt-4 text-[26px] font-semibold">{report.title}</h1>
      <PolicyTabs active={report.type === "policy_weekly" ? "weekly" : "monthly"} />
      <PolicyReportFilters query={query} jurisdictions={report.coverage.map((row) => row.jurisdiction)} />
      {query.edition ? (
        // An old link to an earlier compilation still opens; the reader is told so once and offered the current issue.
        <p className="mt-3 text-[12.5px] text-ink-3" data-report-earlier>
          {tr("这是本期较早的一版。")}{" "}
          <Link to={currentHref} className="text-accent underline underline-offset-2">
            {tr("查看本期当前内容")}
          </Link>
        </p>
      ) : removed > 0 ? (
        <p className="mt-3 border-l-2 border-line pl-3 text-[12.5px] leading-relaxed text-ink-3" data-report-correction>
          <span className="font-semibold text-ink-2">{tr("更正说明")}</span>
          {" · "}
          {tr("本期有 {n} 份文书因来源撤回或公开资格变化已移除。", { n: removed })}
        </p>
      ) : null}
      <p className="mt-4 text-[13px] text-ink-3">
        {tr("覆盖期间：{from} 至 {to}（北京时间）", { from: day(report.period_start), to: lastDay(report.period_end) })}
      </p>
      <p className="mt-2 text-[12px] text-ink-4">
        {text.join([tr("出刊 {time}", { time: moment(report.issued_at) }), tr("{n} 份文书", { n: report.item_count })])}
      </p>
      <p className="mt-3 text-[13px] leading-6 text-ink-3">{text.coverage(report.coverage_note)}</p>
      {report.groups.map((group) => (
        <Section key={group.kind} title={kinds[group.kind]}>
          {group.documents.map(({ policy, versions }) => (
            <div key={policy.id} className="mb-5">
              <h3 className="text-[17px] font-semibold">{policyTitle(policy).title}</h3>
              <p className="mt-1 text-[12px] text-ink-3">
                {text.join([text.places(policy.jurisdictions), policy.themes.map((t) => known.theme(t.code, t.label)).join(text.english ? ", " : "、")])}
              </p>
              {versions.length > 1 && (
                <p className="mt-2 text-[12px] text-ink-4">
                  {tr("本期收录")} {versions.length} {tr("个公开版本记录，逐版列示；版本差异不自动等于法律修订。")}
                </p>
              )}
              {versions.map((v) => (
                <div key={`${v.expression_id}:${v.document_revision_id}`} className="mt-3 border-l-2 border-line pl-3 text-[13px] leading-6">
                  <p>
                    {text.join([
                      tr.maybe(labels[v.label]),
                      text.date(v.published_time) && tr("来源发布 {date}", { date: text.date(v.published_time)! }),
                      v.instrument_number,
                      text.language(v.language),
                    ])}
                  </p>
                  <p className="text-ink-3">
                    {text.join([
                      text.archiveCopy(v.original_version) ? null : v.original_version,
                      text.date(v.first_public_at) &&
                        (v.public_after_period_end
                          ? tr("期末后公开 {date}", { date: text.date(v.first_public_at)! })
                          : tr("本站公开 {date}", { date: text.date(v.first_public_at)! })),
                    ])}
                  </p>
                  {v.summary && <p>{v.summary}</p>}
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
                        {tr("适用对象：")}
                        {impact.legal_actor}
                        {tr("；范围：")}
                        {impact.region}
                      </p>
                      <p>
                        {impact.condition && tr("条件：{condition}", { condition: impact.condition })}
                        {tr("；活动：")}
                        {impact.activity}；{impact.effect_mode === "direct" ? tr("直接") : tr("间接")}
                        {tr("影响")}
                      </p>
                      {impact.exceptions && (
                        <p>
                          {tr("例外：")}
                          {impact.exceptions}
                        </p>
                      )}
                      {text.dateTime(impact.deadline) && (
                        <p>
                          {tr("期限：")}
                          {text.dateTime(impact.deadline)}
                        </p>
                      )}
                    </div>
                  ))}
                  {v.evidence_references?.length ? (
                    <details className="mt-2">
                      <summary>{tr("本版条款与影响依据")}</summary>
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
                    {tr("核对本版适用条件、完整中文及原文证据 →")}
                  </Link>
                </div>
              ))}
            </div>
          ))}
        </Section>
      ))}
      <Section title={tr("本期已发现但尚未完成解读的重要文件")}>
        {report.pending_interpretations.length ? (
          report.pending_interpretations.map((p) => (
            <p key={p.id} className="mb-2 text-[13px]">
              <Link to={policyHref(p.id)} className="text-accent">
                {policyTitle(p).title}
              </Link>
              <span className="text-ink-3">
                {" · "}
                {text.join([p.authority.name, text.date(p.published_time) && tr("来源发布 {date}", { date: text.date(p.published_time)! })])}
              </span>
            </p>
          ))
        ) : (
          <p className="text-[13px] text-ink-3">{tr("当前没有可列示的已核实基本事实，不代表没有新法规。")}</p>
        )}
      </Section>
      {failed && (
        <p role="status" className="mt-3 text-[13px] text-amber-ink">
          {tr("暂时无法继续读取本版汇总，已载入内容仍保留。")}
        </p>
      )}
      {report.next_cursor && (
        <button type="button" disabled={busy} className={`${actionClass} mt-4`} onClick={() => void more()}>
          {tr("继续读取本版汇总")}
        </button>
      )}
      <footer className="mt-6 border-t border-line pt-3 text-[12px] text-ink-4">
        {tr.maybe(report.limitation)} {tr("· AI 辅助生成/翻译")}
      </footer>
    </article>
  );
}
