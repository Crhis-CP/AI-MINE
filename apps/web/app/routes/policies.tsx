import { useRef } from "react";
import { Form, Link, data as withHeaders, useLoaderData, useSearchParams } from "react-router";
import type { Route } from "./+types/policies";
import { createPublicClient, publicSchemas } from "@amp/api-client/public";
import { PolicyListQuery } from "@amp/contracts/http/public";
import { apiBaseFor } from "../../api-target.ts";
import { contractResult } from "../lib/api.server.ts";
import { pageMeta } from "../lib/seo.ts";
import { Pagination } from "../features/feed/DayList";
import { EmptyState } from "../components/ui/Page";
import {
  PolicyCardView,
  PolicyTabs,
  PolicyError,
  usePolicyListReturn,
  usePolicyRecheck,
  themes,
  natures,
  stages,
  fieldClass,
  actionClass,
  policyCache,
} from "../features/policy/PolicyUI";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url),
    input = Object.fromEntries([...url.searchParams].filter(([, v]) => v));
  const parsed = PolicyListQuery.safeParse(input);
  const invalid = !parsed.success || [...url.searchParams.keys()].some((k) => url.searchParams.getAll(k).length > 1);
  if (invalid) return withHeaders({ listing: null, scope: null, filters: { ...PolicyListQuery.parse({}), ...input }, error: 400 }, { status: 400 });
  const client = createPublicClient({ baseUrl: apiBaseFor("/api/site/policies") });
  const options = { headers: { accept: "application/json", "x-amp-ssr": "1" }, signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]) };
  const [listing, scope] = await Promise.allSettled([
    client
      .GET("/api/site/policies", { ...options, params: { query: parsed.success ? parsed.data : PolicyListQuery.parse({}) } })
      .then((r) => contractResult(r, publicSchemas.PolicyListResponse)),
    client.GET("/api/site/policies/scope", options).then((r) => contractResult(r, publicSchemas.PolicyScopeList)),
  ]);
  const values = {
    listing: listing.status === "fulfilled" ? listing.value : null,
    scope: scope.status === "fulfilled" ? scope.value : null,
    filters: parsed.success ? parsed.data : PolicyListQuery.parse({}),
    error: listing.status === "rejected" ? 503 : null,
  };
  return withHeaders(values, { status: values.error ?? 200 });
}
export const headers = policyCache;
export const ErrorBoundary = PolicyError;
export function meta({ location }: Route.MetaArgs) {
  return pageMeta({
    title: "法规政策动态",
    path: location.pathname + location.search,
    noindex: [...new URLSearchParams(location.search).keys()].some((k) => k !== "page"),
  });
}
export default function PoliciesPage() {
  const { listing, scope, filters, error } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  usePolicyListReturn();
  usePolicyRecheck();
  const href = (page: number) => {
    const next = new URLSearchParams(params);
    next.set("page", String(page));
    return `/policies?${next}`;
  };
  const filterDialog = useRef<HTMLDialogElement>(null);
  const filterForm = (
    <Form
      key={JSON.stringify(filters)}
      onSubmit={() => filterDialog.current?.close()}
      method="get"
      className="mt-5 grid gap-3 rounded-card border border-line bg-surface p-4 sm:grid-cols-2 lg:grid-cols-4"
      aria-label="法规筛选"
    >
      <label className="space-y-1 text-[12px] text-ink-3">
        国家与组织
        <select name="jurisdiction" defaultValue={filters.jurisdiction ?? ""} className={fieldClass}>
          <option value="">全部国家与组织</option>
          {[
            ["country", "目标国家"],
            ["organization", "跨国与国际组织"],
          ].map(([kind, label]) => (
            <optgroup key={kind} label={label}>
              {scope?.items
                .filter((i) => i.jurisdiction.kind === kind)
                .map((i) => (
                  <option key={i.jurisdiction.code} value={i.jurisdiction.code}>
                    {i.jurisdiction.label}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>
      {[
        ["theme", "经营主题", themes],
        ["nature", "文书性质", natures],
        ["stage", "制定阶段", stages],
      ].map(([key, label, values]) => (
        <label key={key as string} className="space-y-1 text-[12px] text-ink-3">
          {label as string}
          <select name={key as string} defaultValue={filters[key as "theme" | "nature" | "stage"] ?? ""} className={fieldClass}>
            <option value="">全部</option>
            {Object.entries(values).map(([value, name]) => (
              <option key={value} value={value}>
                {name}
              </option>
            ))}
          </select>
        </label>
      ))}
      <label className="space-y-1 text-[12px] text-ink-3">
        开始日期
        <input type="date" name="from" defaultValue={filters.from} className={fieldClass} />
      </label>
      <label className="space-y-1 text-[12px] text-ink-3">
        结束日期
        <input type="date" name="to" defaultValue={filters.to} className={fieldClass} />
      </label>
      <label className="space-y-1 text-[12px] text-ink-3 lg:col-span-2">
        关键词
        <div className="flex gap-2">
          <input name="q" maxLength={120} defaultValue={filters.q} placeholder="中文名、原文名、文号或机关" className={fieldClass} />
          <button className={actionClass} type="submit">
            筛选
          </button>
          <Link to="/policies" className={`${actionClass} whitespace-nowrap`}>
            重置
          </Link>
        </div>
      </label>
    </Form>
  );
  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-10 pt-5 lg:pt-0" data-policies>
      <h1 className="text-[24px] font-semibold text-ink">法规政策动态</h1>
      <p className="mt-2 text-[14px] text-ink-3">按国家与经营主题阅读官方规则、完整中文和原文证据。</p>
      <PolicyTabs />
      <button type="button" className={`${actionClass} mt-4 lg:hidden`} onClick={() => filterDialog.current?.showModal()}>
        筛选法规
      </button>
      <div className="hidden lg:block">{filterForm}</div>
      <dialog ref={filterDialog} aria-label="筛选法规" className="fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none bg-bg p-4 text-ink backdrop:bg-ink/40">
        <div className="flex items-center justify-between">
          <h2 className="text-[20px] font-semibold">筛选法规</h2>
          <button type="button" className={actionClass} onClick={() => filterDialog.current?.close()}>
            关闭
          </button>
        </div>
        {filterForm}
      </dialog>
      {!scope ? (
        <p className="mt-3 text-[13px] text-amber-ink">
          国家选项暂时无法读取。
          <Link to="." className="underline">
            重新读取
          </Link>
        </p>
      ) : (
        <details className="mt-4 rounded-control bg-bg-sunk px-4 py-3 text-[12px] text-ink-3">
          <summary className="cursor-pointer font-medium">范围与当前可读篇数 · 篇数不代表覆盖完成率</summary>
          <p className="mt-3">{scope.note}</p>
          {[
            ["country", "目标国家"],
            ["organization", "跨国与国际组织"],
          ].map(([kind, label]) => (
            <section key={kind} className="mt-3">
              <h2 className="font-semibold">{label}</h2>
              <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                {scope.items
                  .filter((i) => i.jurisdiction.kind === kind)
                  .map((i) => (
                    <li key={i.jurisdiction.code}>
                      {i.jurisdiction.label}：{i.readable_count} 份
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </details>
      )}
      {listing && (
        <p className="mt-5 text-[12px] text-ink-4">
          第 {listing.page} 页 · 共 {listing.total} 份文书
        </p>
      )}
      {error ? (
        <EmptyState title={error === 400 ? "筛选参数有误" : "暂时无法读取政策法规"}>
          {error === 400 ? "请调整筛选条件后重试，其他已填写的条件仍保留。" : "请稍后重新读取；读取失败不代表没有新法规。"}
        </EmptyState>
      ) : listing?.items.length ? (
        <div>
          {listing.items.map((policy) => (
            <PolicyCardView key={policy.id} policy={policy} />
          ))}
        </div>
      ) : (
        <EmptyState title="当前筛选暂无已公开法规">可调整国家、主题或搜索词查看其他内容；不能据此判断有关法域没有新法规。</EmptyState>
      )}
      {listing && <Pagination page={listing.page} pageCount={Math.max(1, Math.ceil(listing.total / listing.page_size))} href={href} />}
      {listing && listing.total > listing.page_size && (
        <Form method="get" className="mt-4 flex items-center justify-center gap-2 text-[12px]">
          {Object.entries(filters)
            .filter(([k, v]) => k !== "page" && v !== undefined)
            .map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={String(v)} />
            ))}
          <label>
            跳到第{" "}
            <input
              name="page"
              type="number"
              min={1}
              max={Math.ceil(listing.total / listing.page_size)}
              defaultValue={listing.page}
              className="w-16 rounded-control border border-line bg-surface px-2 py-1"
            />{" "}
            页
          </label>
          <button type="submit" className={actionClass}>
            跳转
          </button>
        </Form>
      )}
    </div>
  );
}
