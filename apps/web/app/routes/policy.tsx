import { useState } from "react";
import { Link, data as withHeaders, useLoaderData } from "react-router";
import type { Route } from "./+types/policy";
import { createPublicClient, publicSchemas } from "@amp/api-client/public";
import { PolicyDetailQuery } from "@amp/contracts/http/public";
import { apiBaseFor } from "../../api-target.ts";
import { pageMeta } from "../lib/seo.ts";
import { ArticleLayout } from "../components/ui/Page";
import { PolicyReading } from "../features/policy/PolicyReading";
import { PolicySaveButton } from "../features/policy/PolicySaved";
import {
  PolicyBack,
  PolicyError,
  Section,
  EvidenceLinks,
  natures,
  stages,
  stateText,
  timeLabel,
  actionClass,
  policyCache,
  policyHref,
  usePolicyRecheck,
} from "../features/policy/PolicyUI";

export async function loader({ request, params }: Route.LoaderArgs) {
  const url = new URL(request.url);
  url.searchParams.delete("_routes"); // React Router data transport, not a public query filter.
  const parsed = PolicyDetailQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) throw withHeaders(null, { status: 400 });
  try {
    const result = await createPublicClient({ baseUrl: apiBaseFor("/api/site/policies") }).GET("/api/site/policies/{id}", {
      params: { path: { id: params.id }, query: parsed.data },
      headers: { accept: "application/json", "x-amp-ssr": "1" },
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
    });
    if (!result.response.ok) throw withHeaders(null, { status: [400, 404, 409, 410].includes(result.response.status) ? result.response.status : 503 });
    return { policy: publicSchemas.Policy.parse(result.data), history: !!parsed.data.document_revision_id };
  } catch (error) {
    if (error && typeof error === "object" && "init" in error) throw error;
    throw withHeaders(null, { status: 503 });
  }
}
export const headers = policyCache;
export const ErrorBoundary = PolicyError;
export function meta({ loaderData, params }: Route.MetaArgs) {
  return pageMeta({
    title: loaderData?.policy.title ?? "法规文书",
    description: loaderData?.policy.summary,
    path: policyHref(params.id),
    noindex: loaderData?.history ?? true,
  });
}
export default function PolicyPage() {
  const data = useLoaderData<typeof loader>();
  return (
    <PolicyDocument key={`${data.policy.id}:${data.policy.selected_expression_id}:${data.policy.reading?.document_revision_id}:${data.history}`} {...data} />
  );
}
function PolicyDocument({ policy, history }: Awaited<ReturnType<typeof loader>>) {
  const [invalid, setInvalid] = useState(false),
    [copied, setCopied] = useState(false);
  usePolicyRecheck();
  if (invalid)
    return (
      <div className="pt-6">
        <PolicyBack />
        <h1 className="mt-6 text-[22px] font-semibold">当前内容已变化或暂不可查看</h1>
        <p className="mt-3 text-[14px] text-ink-3">请返回列表重新读取，避免混用不同版本。</p>
      </div>
    );
  const current = policy.versions.find((v) => v.id === policy.selected_policy_version_id);
  const original = policy.expressions.find((e) => e.id === policy.selected_expression_id);
  const legal = policy.legal_state;
  const labels = { published: "已公布", not_published: "尚未公布", unknown: "尚未确认", repealed: "已废止", partly_repealed: "部分废止" };
  const occurrence = { occurred: "原文确认已发生", planned: "计划", conditional: "附条件", unknown: "发生状态未确认" };
  return (
    <div className="pb-12 pt-5 lg:pt-0" data-policy>
      <div className="sticky top-0 z-20 mb-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line bg-bg/95 py-3 backdrop-blur">
        <PolicyBack />
        <PolicySaveButton id={policy.id} />
        {policy.thread_id && (
          <Link to={`/policy-threads/${encodeURIComponent(policy.thread_id)}`} className="text-[13px] text-accent">
            政策脉络 →
          </Link>
        )}
        <Link to={`${policyHref(policy.id)}/history`} className="text-[13px] text-accent">
          版本记录
        </Link>
        <a href={policy.original_url} target="_blank" rel="noopener noreferrer" className="text-[13px] text-accent">
          {history ? "留存来源地址" : "查看官方原文"} ↗
        </a>
        <button
          type="button"
          className="text-[13px] text-accent"
          onClick={() => {
            void navigator.clipboard
              .writeText(location.href)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? "链接已复制" : "复制链接"}
        </button>
      </div>
      {history && (
        <p className="mb-5 rounded-control bg-bg-sunk p-3 text-[13px] text-ink-3">
          历史公开快照 · {current?.current ? "亦为当前可读版本" : "非当前公开版本"}。本站于 {timeLabel(policy.first_public_at)}{" "}
          公开的正文与解读，不代表完整法定沿革。
          <Link to={policyHref(policy.id)} className="ml-2 text-accent underline">
            查看当前可读版本
          </Link>
        </p>
      )}
      <ArticleLayout
        left={
          <div className="space-y-2 text-[12px] text-ink-3">
            <p>{policy.jurisdictions.map((j) => j.label).join("、")}</p>
            <p>{policy.authority.name}</p>
            <p>{policy.nature.label}</p>
          </div>
        }
        right={
          <nav aria-label="文书目录" className="space-y-3 text-[13px] text-ink-3">
            {[
              ["facts", "基础事实"],
              ["analysis", "重点解读"],
              ["legal", "法律状态与适用时间"],
              ["reading", "完整正文"],
              ["evidence", "原文证据"],
            ].map(([id, label]) => (
              <a key={id} href={`#${id}`} className="block hover:text-accent">
                {label}
              </a>
            ))}
          </nav>
        }
      >
        <header id="facts" className="scroll-mt-20">
          <p className="text-[12px] text-ink-3">
            {policy.jurisdictions.map((j) => j.label).join("、")} · {policy.authority.name}
          </p>
          <h1 className="mt-3 text-[26px] font-semibold leading-snug text-ink sm:text-[30px]">{policy.title}</h1>
          <p className="mt-3 break-words text-[13px] text-ink-3">{policy.original_title}</p>
          <p className="mt-2 text-[13px] text-ink-3">{[policy.instrument_number, policy.nature.label, current?.version_label].filter(Boolean).join(" · ")}</p>
          <dl className="mt-4 grid gap-2 text-[12px] text-ink-3">
            <div>
              <dt className="inline">来源发布日期：</dt>
              <dd className="inline">{timeLabel(policy.published_time)}</dd>
            </div>
            <div>
              <dt className="inline">本站公开：</dt>
              <dd className="inline">{timeLabel(policy.first_public_at)}（北京时间）</dd>
            </div>
            <div>
              <dt className="inline">{history ? "该原件留存时核对" : "原文最近核对"}：</dt>
              <dd className="inline">{timeLabel(policy.source_checked_at)}</dd>
            </div>
            {policy.sort_kind === "substantive_change" && (
              <div>
                <dt className="inline">原文确认的变化日期：</dt>
                <dd className="inline">{timeLabel(policy.sort_time)}</dd>
              </div>
            )}
          </dl>
          {policy.is_backfill && <p className="mt-2 text-[12px] text-amber-ink">补录 · 按原文真实日期呈现</p>}
        </header>
        <p
          className={`mt-5 rounded-control border px-4 py-3 text-[14px] ${policy.interpretation_state === "complete" ? "border-accent/20 bg-accent/5 text-accent" : "border-line bg-bg-sunk text-ink-2"}`}
        >
          {stateText(policy)}
        </p>
        {policy.expressions.length > 0 && (
          <nav aria-label="阅读语言" className="mt-4 flex flex-wrap gap-2">
            {policy.expressions.map((e) => (
              <Link
                key={e.id}
                className={actionClass}
                aria-current={e.id === original?.id ? "page" : undefined}
                to={`${policyHref(policy.id)}?expression_id=${encodeURIComponent(e.id)}`}
              >
                {e.kind === "ai_translation" ? "AI 中文" : e.kind === "official_translation" ? "官方中文译本" : `原文 ${e.language}`}
              </Link>
            ))}
          </nav>
        )}
        {policy.summary && <p className="mt-5 text-[15px] leading-7 text-ink-2">{policy.summary}</p>}
        {policy.interpretation_state === "complete" && (
          <Section id="analysis" title="重点解读">
            <p className="whitespace-pre-wrap text-[15px] leading-7 text-ink-2">{policy.guide}</p>
            <h3 className="mt-5 text-[15px] font-semibold">主要条款</h3>
            <ul className="mt-2 space-y-3">
              {policy.main_points.map((p) => (
                <li key={p.clause_ref} className="text-[14px] leading-6 text-ink-2">
                  {p.text}
                  <span className="ml-2 text-[12px] text-ink-4">{p.clause_ref}</span>
                  <EvidenceLinks ids={p.evidence_ids} />
                </li>
              ))}
            </ul>
            <h3 className="mt-5 text-[15px] font-semibold">经营影响</h3>
            <div className="mt-3 space-y-4">
              {policy.impacts.map((i) => (
                <div key={i.id} className="rounded-control border border-line p-4 text-[13px] leading-6">
                  <p className="font-semibold text-ink">
                    {policy.themes.find((t) => t.code === i.theme)?.label} · {i.effect_mode === "direct" ? "直接影响" : "间接影响"}
                  </p>
                  <p>适用区域：{i.region}</p>
                  <p>
                    法定主体：{i.legal_actor}；受影响主体：{i.affected_actor}
                  </p>
                  <p>经营活动：{i.activity}</p>
                  <p>条件：{i.condition}</p>
                  <p>
                    {i.impact}
                    <EvidenceLinks ids={i.evidence_ids} />
                  </p>
                  {i.exceptions && <p>例外：{i.exceptions}</p>}
                  {i.deadline && <p>期限：{timeLabel(i.deadline)}</p>}
                </div>
              ))}
            </div>
          </Section>
        )}
        <Section id="legal" title="法律状态与适用时间">
          <dl className="grid gap-3 text-[13px] sm:grid-cols-2">
            {[
              ["文件性质", natures[legal.nature.value], legal.nature.evidence_ids],
              ["制定阶段", stages[legal.legislative_stage.value], legal.legislative_stage.evidence_ids],
              ["公布状态", labels[legal.publication.value], legal.publication.evidence_ids],
              ["废止状态", labels[legal.repeal.value], legal.repeal.evidence_ids],
            ].map(([name, value, ids]) => (
              <div key={name as string} className="rounded-control bg-bg-sunk p-3">
                <dt className="text-[12px] text-ink-4">{name as string}</dt>
                <dd className="mt-1 font-medium text-ink-2">
                  {value as string}
                  <EvidenceLinks ids={ids as string[]} />
                </dd>
              </div>
            ))}
          </dl>
          <h3 className="mt-4 text-[14px] font-semibold">公布与变化记录</h3>
          <ul className="mt-2 space-y-2 text-[13px] text-ink-3">
            {policy.dates
              .filter((t) => ["published", "updated", "signed", "registered", "formally_published", "compiled", "public_inspection"].includes(t.meaning))
              .map((t) => (
                <li key={`${t.meaning}:${t.raw}`}>
                  {t.meaning_label}：{timeLabel(t)}
                  {t.condition_text && ` · 条件：${t.condition_text}`}
                </li>
              ))}
          </ul>
          {policy.dates.length === 0 && <p className="mt-2 text-[13px] text-ink-3">原文中尚未确认具体安排。</p>}
          {[
            ["施行安排", legal.enforcement.arrangements],
            ["适用范围与时间", legal.applicability],
            ["截止要求", legal.deadlines],
          ].map(([title, rows]) => (
            <div key={title as string} className="mt-4">
              <h3 className="text-[14px] font-semibold">{title as string}</h3>
              {(rows as typeof legal.applicability).length ? (
                (rows as typeof legal.applicability).map((row) => (
                  <p key={row.text} className="mt-2 text-[13px] leading-6 text-ink-3">
                    {timeLabel(row.time)} · {occurrence[row.occurrence]} · {row.text}
                    {row.scope && ` · ${row.scope}`}
                    {row.condition && ` · 条件：${row.condition}`}
                    <EvidenceLinks ids={row.evidence_ids} />
                  </p>
                ))
              ) : (
                <p className="mt-2 text-[13px] text-ink-3">原文中尚未确认具体安排。</p>
              )}
            </div>
          ))}
        </Section>
        {(policy.gaps.length > 0 || policy.attachment_inventory.length > 0) && (
          <Section title="待核实事项与附件">
            <ul className="space-y-2 text-[13px] leading-6 text-ink-3">
              {policy.gaps.map((g) => (
                <li key={g}>{g}</li>
              ))}
              {policy.attachment_inventory.map((a) => (
                <li key={a.url}>
                  <a href={a.url} target="_blank" rel="noopener noreferrer" className="text-accent underline">
                    {a.title} ↗
                  </a>{" "}
                  ·{" "}
                  {
                    { complete: "已取得", missing: "尚未取得", restricted: "暂无展示许可", not_required: "非必要附件", blocked_capacity: "尚未完成处理" }[
                      a.status
                    ]
                  }
                  {a.decisive && " · 决定性附件"}
                </li>
              ))}
            </ul>
          </Section>
        )}
        <Section id="reading" title="完整正文">
          <PolicyReading
            key={`${policy.selected_expression_id}:${policy.reading?.document_revision_id}`}
            policy={policy}
            history={history}
            onInvalid={() => setInvalid(true)}
          />
        </Section>
        <Section id="evidence" title="原文证据">
          {policy.evidence.length ? (
            <ol className="space-y-4">
              {policy.evidence.map((e) => (
                <li id={`evidence-${e.evidence_id}`} key={e.evidence_id} className="scroll-mt-20 border-l-2 border-line pl-3 text-[13px] leading-6 text-ink-3">
                  <p>{e.locator}</p>
                  {e.excerpt && <blockquote>{e.excerpt}</blockquote>}
                  <a href={e.source.original_url} target="_blank" rel="noopener noreferrer" className="text-accent underline">
                    {e.source.publisher.name} · 官方原文 ↗
                  </a>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-[13px] text-ink-3">当前仅提供基础事实与官方原文入口。</p>
          )}
        </Section>
        {policy.relationships.length > 0 && (
          <Section title="关联文件">
            <ul className="space-y-2 text-[13px]">
              {policy.relationships.map((r) => (
                <li key={`${r.relation}:${r.target_citation}`}>
                  {r.target_citation} ·{" "}
                  {r.target_policy_id ? (
                    <Link to={policyHref(r.target_policy_id)} className="text-accent">
                      查看关联文件当前解读 →
                    </Link>
                  ) : (
                    "目标文件尚无可确认的公开解读链接"
                  )}
                  <EvidenceLinks ids={r.evidence_ids} />
                </li>
              ))}
            </ul>
          </Section>
        )}
        {policy.related_items.length > 0 && (
          <Section title="相关报道">
            <ul>
              {policy.related_items.map((item) => (
                <li key={item.id}>
                  <Link to={`/items/${encodeURIComponent(item.id)}`} className="text-[13px] text-accent">
                    {item.title}
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        )}
        <footer className="mt-7 border-t border-line pt-4 text-[12px] leading-6 text-ink-4">
          <p>AI 辅助生成/翻译 · 解读是通用说明，不构成法律意见或经营建议，以官方原文为准。</p>
          <p>{policy.limitation}</p>
          <div>
            {policy.attributions.map((a) => (
              <a key={a.url} href={a.url} target="_blank" rel="noopener noreferrer" className="mr-3 text-accent">
                {a.name} ↗
              </a>
            ))}
          </div>
        </footer>
      </ArticleLayout>
    </div>
  );
}
