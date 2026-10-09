import { Link, data as withHeaders, useLoaderData } from "react-router";
import type { Route } from "./+types/policy-reports";
import { createPublicClient, publicSchemas } from "@amp/api-client/public";
import { PolicyReportQuery } from "@amp/contracts/http/public";
import { apiBaseFor } from "../../api-target.ts";
import { pageMeta } from "../lib/seo.ts";
import { EmptyState } from "../components/ui/Page";
import { PolicyTabs, PolicyError, policyCache, usePolicyRecheck } from "../features/policy/PolicyUI";
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url),
    parsed = PolicyReportQuery.safeParse({ kind: "weekly", ...Object.fromEntries(url.searchParams) });
  if (!parsed.success) throw withHeaders(null, { status: 400 });
  const result = await createPublicClient({ baseUrl: apiBaseFor("/api/site/policies") }).GET("/api/site/policies/reports", {
    params: { query: parsed.data },
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
  });
  if (!result.response.ok) throw withHeaders(null, { status: 503 });
  return { listing: publicSchemas.PolicyReportList.parse(result.data), kind: parsed.data.kind };
}
export const headers = policyCache;
export const ErrorBoundary = PolicyError;
export function meta({ location }: Route.MetaArgs) {
  return pageMeta({ title: "法规周报与月报", path: location.pathname + location.search });
}
export default function PolicyReportsPage() {
  const { listing, kind } = useLoaderData<typeof loader>();
  usePolicyRecheck();
  return (
    <article className="mx-auto max-w-[var(--page-max-reading)] pb-10 pt-5">
      <h1 className="text-[24px] font-semibold">法规政策动态</h1>
      <PolicyTabs active={kind} />
      {listing.items.length ? (
        <ul className="mt-5 divide-y divide-line">
          {listing.items.map((report) => (
            <li key={report.id} className="py-4">
              <Link to={`/policies/reports/${encodeURIComponent(report.id)}`} className="text-[18px] font-semibold text-accent">
                {report.title}
              </Link>
              <p className="mt-2 text-[13px] text-ink-3">{report.summary}</p>
              <p className="mt-2 text-[12px] text-ink-4">{report.coverage_note}</p>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title={`暂未生成可公开的法规${kind === "weekly" ? "周报" : "月报"}`}>没有汇总不代表有关法域没有新法规。</EmptyState>
      )}
    </article>
  );
}
