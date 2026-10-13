import { Link, data as withHeaders, useLoaderData } from "react-router";
import type { Route } from "./+types/policy-thread";
import { createPublicClient, publicSchemas } from "@amp/api-client/public";
import { apiBaseFor } from "../../api-target.ts";
import { pageMeta } from "../lib/seo.ts";
import { PolicyBack, PolicyCardView, PolicyError, policyCache, policyHref, timeLabel, usePolicyRecheck } from "../features/policy/PolicyUI";
export async function loader({ request, params }: Route.LoaderArgs) {
  const result = await createPublicClient({ baseUrl: apiBaseFor("/api/site/policy-threads") }).GET("/api/site/policy-threads/{id}", {
    params: { path: { id: params.id } },
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
  });
  if (!result.response.ok) throw withHeaders(null, { status: [400, 404, 409, 410].includes(result.response.status) ? result.response.status : 503 });
  return publicSchemas.PolicyThread.parse(result.data);
}
export const headers = policyCache;
export const ErrorBoundary = PolicyError;
export function meta({ params }: Route.MetaArgs) {
  return pageMeta({ title: "政策脉络", path: `/policy-threads/${encodeURIComponent(params.id)}`, noindex: true });
}
export default function PolicyThreadPage() {
  const thread = useLoaderData<typeof loader>();
  usePolicyRecheck();
  return (
    <article className="mx-auto max-w-[var(--page-max-reading)] pb-12 pt-5">
      <PolicyBack />
      <header className="mb-7 mt-5 border-b border-line pb-6">
        <p className="mb-2 text-[12px] font-medium tracking-wide text-accent">{thread.jurisdictions.map((j) => j.label).join(" · ")} · 原文明示关系</p>
        <h1 className="text-[28px] font-semibold leading-tight text-ink">{thread.title}</h1>
        <p className="mt-3 max-w-[70ch] text-[14px] leading-7 text-ink-3">{thread.summary}</p>
        <p className="mt-3 text-[12px] text-ink-4">不是完整法定沿革。每份文书的效力、适用条件和施行安排，请进入文书分别查看。</p>
      </header>
      <nav aria-label="政策文书脉络" className="mb-8">
        <ol className="ml-2 border-l border-line-strong pl-6">
          {thread.stages.map((stage) => {
            const policy = thread.policies.find((p) => p.id === stage.policy_id);
            return (
              <li key={stage.policy_id ?? stage.event_id ?? stage.relation} className="relative pb-6 last:pb-0">
                <span aria-hidden="true" className="absolute -left-[29px] top-1.5 h-2 w-2 rounded-full bg-accent" />
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12px] text-ink-3">
                  <time>{stage.time.precision === "unknown" ? "来源日期尚未确认" : timeLabel(stage.time)}</time>
                  <span className="rounded-mark bg-accent/5 px-2 py-0.5 text-accent">{stage.relation}</span>
                </div>
                {policy && (
                  <Link className="mt-2 block text-[16px] font-semibold leading-7 hover:text-accent" to={policyHref(policy.id)}>
                    {policy.title}
                  </Link>
                )}
                {policy?.instrument_number && <p className="mt-1 text-[12px] text-ink-4">{policy.instrument_number}</p>}
              </li>
            );
          })}
        </ol>
      </nav>
      <section aria-labelledby="documents">
        <h2 id="documents" className="text-[18px] font-semibold">
          相关文书 <span className="text-[13px] font-normal text-ink-4">{thread.policies.length} 份</span>
        </h2>
        {thread.policies.map((policy) => (
          <PolicyCardView key={policy.id} policy={policy} />
        ))}
      </section>
    </article>
  );
}
