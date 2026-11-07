import { apiFetch, Link } from "@amp/web/extension";
import { useTr } from "@amp/web/i18n";
import { useState } from "react";
import { data as withHeaders, useLoaderData } from "react-router";
import type { LoaderFunctionArgs, MetaArgs } from "react-router";
import { schemas as publicSchemas } from "@amp/contracts/http/public";
import { apiBaseFor } from "@amp/web/extension.server";
import { pageMeta } from "@amp/web/extension";
import { PolicyBack, PolicyError, policyCache, policyHref, actionClass, usePolicyRecheck } from "./features/PolicyUI";
import { usePolicyText } from "./features/reader";
export async function loader({ request, params }: LoaderFunctionArgs) {
  const result = await apiFetch("/api/site/policies/{id}/history", {
    params: { path: { id: params.id! }, query: { limit: 20 } },
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
    baseUrl: apiBaseFor(),
  });
  if (!result.ok) throw withHeaders(null, { status: [400, 404, 409, 410].includes(result.status) ? result.status : 503 });
  return publicSchemas.PolicyHistoryPage.parse(await result.json());
}
export const headers = policyCache;
export const ErrorBoundary = PolicyError;
export function meta({ params }: MetaArgs<typeof loader>) {
  return pageMeta({ title: "法规版本记录", path: `${policyHref(params.id!)}/history`, noindex: true });
}
export default function PolicyHistoryPage() {
  const initial = useLoaderData<typeof loader>();
  return <History key={initial.content_version} initial={initial} />;
}
function History({ initial }: { initial: Awaited<ReturnType<typeof loader>> }) {
  const tr = useTr();
  const text = usePolicyText();
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
      const next = await apiFetch("/api/site/policies/{id}/history", {
        params: { path: { id: data.policy_id }, query: { cursor: data.next_cursor, limit: 20 } },
        baseUrl: location.origin,
      });
      if ([404, 409, 410].includes(next.status)) return setInvalid(true);
      if (!next.ok) throw new Error("unavailable");
      const parsed = publicSchemas.PolicyHistoryPage.parse(await next.json());
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
      <h1 className="mt-5 text-[24px] font-semibold">{tr("法规版本记录")}</h1>
      <p className="mt-3 text-[13px] leading-6 text-ink-3">{tr("保留本站各次公开版本的正文与解读。仅显示仍具备公开资格的版本，不等同于完整法定沿革。")}</p>
      {invalid ? (
        <p className="mt-6">{tr("内容已更新，请返回列表重新浏览。")}</p>
      ) : (
        <>
          <ol className="mt-5 divide-y divide-line">
            {data.items.map((item) => (
              <li key={`${item.expression_id}:${item.document_revision_id}`} className="py-4">
                <Link
                  className="font-semibold text-accent"
                  to={`${policyHref(data.policy_id)}?${new URLSearchParams({ policy_version_id: item.policy_version_id, expression_id: item.expression_id, document_revision_id: item.document_revision_id })}`}
                >
                  {text.version(item.original_version)}
                </Link>
                <p className="mt-2 text-[13px] text-ink-3">
                  {text.join([text.language(item.language), item.instrument_number, item.current ? tr("当前可读版本") : tr("历史公开快照")])}
                </p>
                <p className="mt-2 text-[12px] text-ink-4">
                  {text.join([
                    text.date(item.first_public_at) && tr("本站公开 {date}", { date: text.date(item.first_public_at)! }),
                    text.date(item.published_time) && tr("来源发布 {date}", { date: text.date(item.published_time)! }),
                    text.date(item.checked_at) && tr("原件核对 {date}", { date: text.date(item.checked_at)! }),
                  ])}
                </p>
                {!item.current && item.kind !== "ai_translation" && (
                  <Link
                    className="mt-2 inline-block text-[13px] text-accent underline-offset-2 hover:underline"
                    to={`${policyHref(data.policy_id)}?${new URLSearchParams({ compare_from: item.document_revision_id })}#compare`}
                  >
                    {tr("与当前版本逐条对照 →")}
                  </Link>
                )}
              </li>
            ))}
          </ol>
          {!data.items.length && <p className="mt-5 text-[14px] text-ink-3">{tr("暂无可公开的历史版本。")}</p>}
          {failed && <p className="mt-3 text-[13px] text-amber-ink">{tr("暂时无法继续读取，已有记录仍保留。")}</p>}
          {data.next_cursor && (
            <button type="button" disabled={busy} onClick={() => void more()} className={`${actionClass} mt-5`}>
              {tr("继续查看版本记录")}
            </button>
          )}
        </>
      )}
    </article>
  );
}
