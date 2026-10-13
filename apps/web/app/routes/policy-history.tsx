import { useState } from "react";
import { Link, data as withHeaders, useLoaderData } from "react-router";
import type { Route } from "./+types/policy-history";
import { createPublicClient, publicSchemas } from "@amp/api-client/public";
import { apiBaseFor } from "../../api-target.ts";
import { pageMeta } from "../lib/seo.ts";
import { PolicyBack, PolicyError, policyCache, policyHref, timeLabel, actionClass, usePolicyRecheck } from "../features/policy/PolicyUI";
export async function loader({ request, params }: Route.LoaderArgs) {
  const result = await createPublicClient({ baseUrl: apiBaseFor("/api/site/policies") }).GET("/api/site/policies/{id}/history", {
    params: { path: { id: params.id }, query: { limit: 20 } },
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
  });
  if (!result.response.ok) throw withHeaders(null, { status: [400, 404, 409, 410].includes(result.response.status) ? result.response.status : 503 });
  return publicSchemas.PolicyHistoryPage.parse(result.data);
}
export const headers = policyCache;
export const ErrorBoundary = PolicyError;
export function meta({ params }: Route.MetaArgs) {
  return pageMeta({ title: "法规版本记录", path: `${policyHref(params.id)}/history`, noindex: true });
}
export default function PolicyHistoryPage() {
  const initial = useLoaderData<typeof loader>();
  return <History key={initial.content_version} initial={initial} />;
}
function History({ initial }: { initial: Awaited<ReturnType<typeof loader>> }) {
  const [data, setData] = useState(initial),
    [failed, setFailed] = useState(false),
    [invalid, setInvalid] = useState(false),
    [busy, setBusy] = useState(false);
  usePolicyRecheck();
  const more = async () => {
    if (!data.next_cursor || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const next = await createPublicClient({ baseUrl: location.origin }).GET("/api/site/policies/{id}/history", {
        params: { path: { id: data.policy_id }, query: { cursor: data.next_cursor, limit: 20 } },
      });
      if ([404, 409, 410].includes(next.response.status)) return setInvalid(true);
      if (!next.response.ok) throw new Error("unavailable");
      const parsed = publicSchemas.PolicyHistoryPage.parse(next.data);
      if (parsed.policy_id !== data.policy_id || parsed.content_version !== data.content_version) return setInvalid(true);
      setData({ ...parsed, items: [...data.items, ...parsed.items] });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="mx-auto max-w-[var(--page-max-reading)] pb-10 pt-5">
      <PolicyBack />
      <h1 className="mt-5 text-[24px] font-semibold">法规版本记录</h1>
      <p className="mt-3 text-[13px] leading-6 text-ink-3">保留本站各次公开版本的正文与解读。仅显示仍具备公开资格的版本，不等同于完整法定沿革。</p>
      {invalid ? (
        <p className="mt-6">内容已更新，请返回列表重新浏览。</p>
      ) : (
        <>
          <ol className="mt-5 divide-y divide-line">
            {data.items.map((item) => (
              <li key={`${item.expression_id}:${item.document_revision_id}`} className="py-4">
                <Link
                  className="font-semibold text-accent"
                  to={`${policyHref(data.policy_id)}?${new URLSearchParams({ policy_version_id: item.policy_version_id, expression_id: item.expression_id, document_revision_id: item.document_revision_id })}`}
                >
                  {item.original_version}
                </Link>
                <p className="mt-2 text-[13px] text-ink-3">
                  {item.language} · {item.instrument_number ?? "文号尚未确认"} · {item.current ? "当前可读版本" : "历史公开快照"}
                </p>
                <p className="mt-2 text-[12px] text-ink-4">
                  本站公开：{timeLabel(item.first_public_at)}；原文公布：{timeLabel(item.published_time)}；该原件留存时核对：{timeLabel(item.checked_at)}
                </p>
              </li>
            ))}
          </ol>
          {!data.items.length && <p className="mt-5 text-[14px] text-ink-3">暂无可公开的历史版本。</p>}
          {failed && <p className="mt-3 text-[13px] text-amber-ink">暂时无法继续读取，已有记录仍保留。</p>}
          {data.next_cursor && (
            <button type="button" disabled={busy} onClick={() => void more()} className={`${actionClass} mt-5`}>
              继续查看版本记录
            </button>
          )}
        </>
      )}
    </article>
  );
}
