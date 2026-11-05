import { apiFetch } from "@amp/web/extension";
import { useTr } from "@amp/web/i18n";
import { useState } from "react";
import { Link, data as withHeaders, useLoaderData } from "react-router";
import type { LoaderFunctionArgs, MetaArgs } from "react-router";
import { schemas as publicSchemas } from "@amp/contracts/http/public";
import { PolicyDetailQuery } from "@amp/contracts/http/public";
import { apiBaseFor } from "@amp/web/extension.server";
import { pageMeta } from "@amp/web/extension";
import { ArticleLayout } from "@amp/web/page";
import { PolicyReading } from "./features/PolicyReading";
import { PolicyBack, PolicyError, Section, timeLabel, policyCache, policyHref, usePolicyRecheck } from "./features/PolicyUI";
import {
  PolicyAnalysis,
  PolicyEvidence,
  PolicyFacts,
  PolicyFooter,
  PolicyGaps,
  PolicyGlance,
  PolicyJumpBar,
  PolicyLegal,
  PolicyLinks,
  PolicyReadingState,
  PolicyToc,
  PolicyToolbar,
  policySections,
} from "./features/PolicyDetail";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  url.searchParams.delete("_routes"); // React Router data transport, not a public query filter.
  const parsed = PolicyDetailQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) throw withHeaders(null, { status: 400 });
  try {
    const result = await apiFetch("/api/site/policies/{id}", {
      params: { path: { id: params.id! }, query: parsed.data },
      headers: { accept: "application/json", "x-amp-ssr": "1" },
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
      baseUrl: apiBaseFor(),
    });
    if (!result.ok) throw withHeaders(null, { status: [400, 404, 409, 410].includes(result.status) ? result.status : 503 });
    const policy = publicSchemas.Policy.parse(await result.json());
    const selected = policy.expressions.find((expression) => expression.id === policy.selected_expression_id);
    let initialReading: ReturnType<typeof publicSchemas.PolicyReadingPage.parse> | null = null;
    let initialReadingFailed = false;
    if (policy.reading && selected && ["complete", "partial"].includes(selected.reading_state)) {
      if (policy.reading.expression_id !== selected.id || policy.reading.document_revision_id !== selected.document_revision_id)
        throw withHeaders(null, { status: 409 });
      try {
        const page = await apiFetch("/api/site/policies/{id}/reading", {
          params: {
            path: { id: policy.id },
            query: {
              expression_id: selected.id,
              document_revision_id: selected.document_revision_id,
              limit: 20,
              ...(policy.reading.next_cursor ? { cursor: policy.reading.next_cursor } : {}),
            },
          },
          headers: { accept: "application/json", "x-amp-ssr": "1" },
          cache: "no-cache",
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
          baseUrl: apiBaseFor(),
        });
        if ([400, 404, 409, 410].includes(page.status)) throw withHeaders(null, { status: page.status });
        if (!page.ok) throw new Error("Policy reading temporarily unavailable");
        const reading = publicSchemas.PolicyReadingPage.parse(await page.json());
        if (
          reading.subject_id !== policy.id ||
          reading.expression_id !== selected.id ||
          reading.document_revision_id !== selected.document_revision_id ||
          reading.language !== selected.language ||
          reading.mode !== selected.kind
        )
          throw withHeaders(null, { status: 409 });
        initialReading = reading;
      } catch (error) {
        if (request.signal.aborted || (error && typeof error === "object" && "init" in error)) throw error;
        initialReadingFailed = true;
      }
    }
    return { policy, history: !!parsed.data.document_revision_id, initialReading, initialReadingFailed };
  } catch (error) {
    if (error && typeof error === "object" && "init" in error) throw error;
    throw withHeaders(null, { status: 503 });
  }
}
export const headers = policyCache;
export const ErrorBoundary = PolicyError;
export function meta({ loaderData, params }: MetaArgs<typeof loader>) {
  return pageMeta({
    title: loaderData?.policy.title ?? "法规文书",
    description: loaderData?.policy.summary,
    path: policyHref(params.id!),
    noindex: loaderData?.history ?? true,
  });
}
export default function PolicyPage() {
  const data = useLoaderData<typeof loader>();
  return (
    <PolicyDocument key={`${data.policy.id}:${data.policy.selected_expression_id}:${data.policy.reading?.document_revision_id}:${data.history}`} {...data} />
  );
}
function PolicyDocument({ policy, history, initialReading, initialReadingFailed }: Awaited<ReturnType<typeof loader>>) {
  const tr = useTr();
  const [invalid, setInvalid] = useState(false);
  usePolicyRecheck();
  if (invalid)
    return (
      <div className="pt-6">
        <PolicyBack />
        <h1 className="mt-6 text-[22px] font-semibold">{tr("当前内容已变化或暂不可查看")}</h1>
        <p className="mt-3 text-[14px] text-ink-3">{tr("请返回列表重新读取，避免混用不同版本。")}</p>
      </div>
    );
  const current = policy.versions.find((v) => v.id === policy.selected_policy_version_id);
  const sections = policySections(policy, tr);
  return (
    <div className="pb-12 pt-3 lg:pt-0" data-policy>
      <PolicyToolbar policy={policy} history={history} />
      {history && (
        <p className="mb-5 rounded-control bg-bg-sunk p-3 text-[13px] text-ink-3">
          {tr("历史公开快照 ·")} {current?.current ? tr("亦为当前可读版本") : tr("非当前公开版本")}
          {tr("。本站于")} {timeLabel(policy.first_public_at)} {tr("公开的正文与解读，不代表完整法定沿革。")}
          <Link to={policyHref(policy.id)} className="ml-2 text-accent underline">
            {tr("查看当前可读版本")}
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
        right={<PolicyToc sections={sections} />}
      >
        <PolicyFacts policy={policy} history={history} />
        <PolicyGlance policy={policy} />
        <PolicyReadingState policy={policy} />
        <PolicyJumpBar sections={sections} />
        {policy.summary && <p className="mt-5 text-[15px] leading-7 text-ink-2">{policy.summary}</p>}
        <PolicyAnalysis policy={policy} />
        <PolicyLegal policy={policy} />
        <PolicyGaps policy={policy} />
        <Section id="reading" title={tr("正文阅读")}>
          <PolicyReading
            key={`${policy.selected_expression_id}:${policy.reading?.document_revision_id}`}
            policy={policy}
            history={history}
            initialPage={initialReading}
            initialFailed={initialReadingFailed}
            onInvalid={() => setInvalid(true)}
          />
        </Section>
        <PolicyEvidence policy={policy} />
        <PolicyLinks policy={policy} />
        <PolicyFooter policy={policy} />
      </ArticleLayout>
    </div>
  );
}
