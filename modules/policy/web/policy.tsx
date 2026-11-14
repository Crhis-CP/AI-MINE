import { apiFetch } from "@amp/web/extension";
import { useTr } from "@amp/web/i18n";
import { useState } from "react";
import { data as withHeaders, useLoaderData } from "react-router";
import type { LoaderFunctionArgs, MetaArgs } from "react-router";
import { schemas as publicSchemas } from "@amp/contracts/http/public";
import { PolicyDetailQuery } from "@amp/contracts/http/public";
import { apiBaseFor } from "@amp/web/extension.server";
import { pageMeta } from "@amp/web/extension";
import { PolicySource } from "./features/PolicyReading";
import { PolicyReviewProvider, useReview, type ReviewView } from "./features/PolicyReview";
import { PolicyBack, PolicyError, policyCache, policyHref, usePolicyRecheck } from "./features/PolicyUI";
import { PolicyHead, PolicyInterpretation } from "./features/PolicyDetail";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  url.searchParams.delete("_routes"); // React Router data transport, not a public query filter.
  // The page's own comparison choice (from the version history), not a detail filter.
  const compareFrom = url.searchParams.get("compare_from") || undefined,
    compareTo = url.searchParams.get("compare_to") || undefined;
  url.searchParams.delete("compare_from");
  url.searchParams.delete("compare_to");
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
    const history = !!parsed.data.document_revision_id;
    // The comparison is optional: no two comparable versions, or a failed read, only leaves its section and the marks out.
    const comparing = history
      ? Promise.resolve(null)
      : apiFetch("/api/site/policies/{id}/compare", {
          params: { path: { id: policy.id }, query: { from: compareFrom, to: compareTo } },
          headers: { accept: "application/json", "x-amp-ssr": "1" },
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
          baseUrl: apiBaseFor(),
        })
          .then(async (response) => {
            if (!response.ok) return null;
            const comparison = publicSchemas.PolicyComparison.safeParse(await response.json());
            return comparison.success && comparison.data.policy_id === policy.id ? comparison.data : null;
          })
          // Never rejects: the loader may already have thrown for the reading, and an aborted request needs no section.
          .catch(() => null);
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
    return { policy, history, initialReading, initialReadingFailed, comparison: await comparing, compareRequested: !!(compareFrom || compareTo) };
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
const FIRST_VIEW: ReviewView = { pane: "read", redline: false };

export default function PolicyPage() {
  const data = useLoaderData<typeof loader>();
  // The phone tab and the revision marks stay as the reader set them while the language changes; another document starts afresh.
  const [view, setView] = useState({ policy: data.policy.id, ...FIRST_VIEW });
  const current = view.policy === data.policy.id ? view : { policy: data.policy.id, ...FIRST_VIEW };
  return (
    <PolicyDocument
      key={`${data.policy.id}:${data.policy.selected_expression_id}:${data.policy.reading?.document_revision_id}:${data.history}`}
      {...data}
      view={current}
      onView={(next) => setView((now) => ({ ...(now.policy === data.policy.id ? now : { policy: data.policy.id, ...FIRST_VIEW }), ...next }))}
    />
  );
}

/** The two sides under the head. Narrow space shows them as two tabs; the bar is plain anchors until scripts run. */
function Panes({ compareRequested }: { compareRequested: boolean }) {
  const tr = useTr();
  const { source, pane, setPane } = useReview();
  const tab = (key: ReviewView["pane"], label: string) => (
    <a
      href={`#pr-${key}`}
      role="tab"
      aria-selected={pane === key}
      aria-controls={`pr-${key}`}
      onClick={(event) => {
        event.preventDefault();
        setPane(key);
      }}
    >
      {label}
    </a>
  );
  // Without any text to show there is one column and no tab that would lead nowhere.
  if (source.kind === "none")
    return (
      <div className="pr-panes">
        <PolicyInterpretation compareRequested={compareRequested} />
      </div>
    );
  return (
    <div className="pr-panes">
      <div className="pr-ptab" role="tablist" aria-label={tr("解读与原文")}>
        {tab("read", tr("解读"))}
        {tab("src", tr("原文"))}
      </div>
      <PolicyInterpretation compareRequested={compareRequested} />
      <PolicySource />
    </div>
  );
}

function PolicyDocument({
  policy,
  history,
  initialReading,
  initialReadingFailed,
  comparison,
  compareRequested,
  view,
  onView,
}: Awaited<ReturnType<typeof loader>> & { view: ReviewView; onView: (next: Partial<ReviewView>) => void }) {
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
  return (
    <PolicyReviewProvider
      policy={policy}
      history={history}
      comparison={comparison}
      initialPage={initialReading}
      initialFailed={initialReadingFailed}
      onInvalid={() => setInvalid(true)}
      view={view}
      onView={onView}
    >
      <div className="pr-prog" aria-hidden="true" />
      <PolicyHead policy={policy} history={history} />
      <Panes compareRequested={compareRequested} />
    </PolicyReviewProvider>
  );
}
