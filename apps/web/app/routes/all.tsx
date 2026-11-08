import { apiFetch } from "../lib/http.ts";
import { basePath, useTagLabel, useTr } from "../i18n";
import { SITE, withSubject } from "@amp/industry/site";
import { data as withStatus, redirect, useLoaderData, useNavigation, useSearchParams } from "react-router";
import { Link } from "../i18n/navigation";
import type { Route } from "./+types/all";
import { schemas as publicSchemas } from "@amp/contracts/http/public";
import { apiBaseFor } from "../../api-target.ts";
import { isValidDate } from "@amp/contracts/time";
import { canonicalCategoryFilter, isChannelKey } from "@amp/contracts/taxonomy";
import { contractResult, loadOr404, queryString } from "../lib/api.server";
import { listPath, pageMeta } from "../lib/seo";
import { FeedBar, FeedToolbar, SearchField, SourceDateFilters } from "../features/feed/Filters";
import { PillTabs } from "../components/ui/Tabs";
import { DayList, Pagination } from "../features/feed/DayList";
import { HotTopics } from "../features/feed/HotTopics";
import { EmptyState } from "../components/ui/Page";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const channelParam = url.searchParams.get("channel") ?? "all";
  const categoryParam = url.searchParams.get("category");
  // The first-party switch is gone (TASK-0587, Owner 2026-11-07): an old ?channel=firstParty link opens the whole list.
  const channel = isChannelKey(channelParam) && channelParam !== "firstParty" ? channelParam : "all";
  const category = categoryParam ? canonicalCategoryFilter(categoryParam) : null;
  // Old links with a retired category (ADR-0031) move to its successor; company_project stays and filters both.
  if (categoryParam && category && category !== categoryParam) {
    url.searchParams.set("category", category);
    throw redirect(`${url.pathname}${url.search}`, 301);
  }
  const jurisdiction = url.searchParams.get("jurisdiction")?.trim() || null;
  const tag = url.searchParams.get("tag")?.trim() || null;
  const q = url.searchParams.get("q")?.trim().slice(0, 200) || null;
  const tab = url.searchParams.get("tab") === "relevance" ? "relevance" : null;
  // Legacy deep-paging parameters (deep, anchorAt) still open a normal page.
  const page = Math.max(Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1, 1);
  const query = {
    readingGroups: "reports-v1",
    channel: channel === "all" ? undefined : channel,
    category: category ?? undefined,
    tag: tag ?? undefined,
    jurisdiction: jurisdiction ?? undefined,
    q: q ?? undefined,
    tab: tab ?? undefined,
    page: page > 1 ? page : undefined,
    source: url.searchParams.get("source") || undefined,
    selected: url.searchParams.get("selected") === "true" ? "true" : undefined,
    mineral: url.searchParams.get("mineral") || undefined,
    on: url.searchParams.get("on") || undefined,
    from: url.searchParams.get("from") || undefined,
    to: url.searchParams.get("to") || undefined,
  } as const;
  const invalidDate = ["on", "from", "to"].some((name) => {
    const value = url.searchParams.get(name);
    return !!value && !isValidDate(value);
  });
  const invalidRange = query.from && query.to && query.from > query.to;
  if (invalidDate || invalidRange)
    return withStatus(
      {
        data: null,
        policyMatches: null,
        policySearchFailed: false,
        filterError: invalidDate ? "日期无效，请使用有效的年、月、日。" : "开始日期不能晚于结束日期，请调整后再筛选。",
      },
      { status: 400 },
    );
  // The optional policy search starts alongside news and has its own short deadline.
  const policyRequest = q
    ? apiFetch("/api/site/policies", {
        params: { query: { q, page: 1, page_size: 5 } },
        headers: { accept: "application/json", "x-amp-ssr": "1" },
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(3000)]),
        baseUrl: apiBaseFor(),
      })
        .then((result) => contractResult(result, publicSchemas.PolicyListResponse))
        .catch(() => null)
    : null;
  const data = await loadOr404(
    () =>
      apiFetch("/api/site/pool", {
        params: { query },
        querySerializer: () => queryString(query).slice(1),
        headers: { accept: "application/json", "x-amp-ssr": "1" },
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
        baseUrl: apiBaseFor(),
      }).then((result) => contractResult(result, publicSchemas.ReportGroupedPoolResponse)),
    { signal: request.signal },
  );
  const policyMatches = await policyRequest;
  return { data, policyMatches, policySearchFailed: !!q && policyMatches === null, filterError: null };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const f = loaderData?.data?.filters;
  const q = f?.q;
  const page = loaderData?.data?.page ?? 1;
  return pageMeta({
    title: q ? `搜索：${q}` : `全部${withSubject("动态")}`,
    description: `${SITE.name} 收录的全部${withSubject("动态")}，可按国家、地区、类别与标签筛选，支持中英文搜索。`,
    path: listPath("/all", {
      channel: f && f.channel !== "all" ? f.channel : null,
      category: f?.category,
      tag: f?.tag,
      jurisdiction: f?.jurisdiction,
      source: f?.source,
      mineral: f?.mineral,
      on: f?.on,
      from: f?.from,
      to: f?.to,
      q,
      tab: f?.tab === "relevance" ? "relevance" : null,
      page: page > 1 ? page : null,
    }),
    noindex: !!q,
  });
}

export function headers() {
  return { "Cache-Control": "no-store" };
}

function pageHref(params: URLSearchParams, page: number) {
  const sp = new URLSearchParams(params);
  sp.delete("deep");
  sp.delete("anchorAt");
  sp.delete("search");
  if (page <= 1) sp.delete("page");
  else sp.set("page", String(page));
  const s = sp.toString();
  return s ? `/all?${s}` : "/all";
}

export default function AllPage() {
  const tr = useTr();
  const tagLabel = useTagLabel();
  const { data, policyMatches, policySearchFailed, filterError } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const navigation = useNavigation();
  if (!data)
    return (
      <div className="pb-12">
        <h1 className="pt-5 text-[24px] font-semibold text-ink">{tr("全部矿业动态")}</h1>
        <p role="alert" className="mt-3 text-[14px] text-hot">
          {filterError && tr.maybe(filterError)}
        </p>
        <SourceDateFilters base="/all" />
      </div>
    );
  const f = data.filters;
  const busy = navigation.state === "loading" && !!navigation.location && basePath(navigation.location.pathname) === "/all";
  const keep = Object.fromEntries([...params].filter(([key]) => !["q", "page", "cursor", "search"].includes(key)));
  const searchTabHref = (tab: "time" | "relevance") => {
    const sp = new URLSearchParams(params);
    sp.delete("page");
    if (tab === "relevance") sp.set("tab", "relevance");
    else sp.delete("tab");
    return `/all?${sp}`;
  };
  const title = f.q ? tr("搜索“{q}”", { q: f.q }) : f.tag ? `#${tagLabel(f.tag)}` : null;
  const updated = new Date(data.freshness).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" });

  return (
    <div className="pb-6 [--phone-bar-offset:48px] lg:[--phone-bar-offset:0px]">
      <FeedBar base="/all" category={f.category} jurisdiction={f.jurisdiction ?? null} facets={data.facets} />
      <FeedToolbar
        title={title ?? tr.maybe(`全部${withSubject("动态")}`)}
        base="/all"
        category={f.category}
       
        jurisdiction={f.jurisdiction ?? null}
        layoutId="all-cat-desk"
        search={<SearchField variant="track" defaultValue={f.q ?? ""} keep={keep} />}
        advanced={<SourceDateFilters base="/all" facets={data.facets} flat />}
      />
      {data.hot && <HotTopics entries={data.hot} />}
      {f.q && (
        <section aria-label={tr("法规政策搜索结果")} className="my-4 rounded-card border border-line px-4 py-3">
          <div className="flex justify-between text-[14px]">
            <h2 className="font-semibold">
              {tr("法规政策")}
              {policyMatches ? tr("（{total} 条）", { total: policyMatches.total }) : ""}
            </h2>
            <Link to={`/policies?q=${encodeURIComponent(f.q)}`} className="text-accent">
              {tr("查看全部法规结果 →")}
            </Link>
          </div>
          {policySearchFailed ? (
            <p className="mt-2 text-[13px] text-ink-3">{tr("法规结果暂时无法读取，可进入法规栏目重试。")}</p>
          ) : policyMatches?.items.length ? (
            <ul className="mt-2 divide-y divide-line">
              {policyMatches.items.slice(0, 5).map((policy) => (
                <li key={policy.id} className="py-2 text-[14px]">
                  <Link to={`/policies/${encodeURIComponent(policy.id)}`} className="text-accent">
                    {policy.title}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-[13px] text-ink-3">{tr("未找到相符的法规文书。")}</p>
          )}
        </section>
      )}
      <p className="my-3 text-[12px] text-ink-4">
        {tr("第")} {data.page} {tr("页 · 共")} {data.total} {data.cards ? tr("组动态") : tr("条动态")}
        {data.reportTotal !== undefined ? tr(" · {reportTotal} 篇报道", { reportTotal: data.reportTotal }) : ""}
      </p>
      {f.q && (
        <div className="mb-3 mt-3 flex flex-wrap items-center justify-between gap-2 lg:mt-0">
          <PillTabs
            size="xs"
            layoutId="all-search-sort"
            label={tr("搜索排序")}
            active={f.tab}
            items={(["time", "relevance"] as const).map((t) => ({
              key: t,
              label: t === "time" ? tr("最新（标题与摘要）") : tr("全文相关"),
              to: searchTabHref(t),
            }))}
          />
          <span className="text-[12px] text-ink-4">
            {tr("找到")} <span className="num">{data.total}</span> {tr("条 · 更新于")} <span className="num">{updated}</span>
          </span>
        </div>
      )}

      <div className={`transition-opacity duration-200 ${busy ? "opacity-50" : ""}`}>
        {data.items.length === 0 ? (
          <div className="mt-2 lg:card">
            <EmptyState
              title={tr("没有找到相关内容")}
              action={
                f.q && f.tab === "time" ? (
                  <Link to={searchTabHref("relevance")} className="text-[13px] font-medium text-accent hover:underline">
                    {tr("试试“全文相关”，连正文一起搜")}
                  </Link>
                ) : undefined
              }
            >
              {f.q ? tr("换个说法，或者去掉筛选再试。") : tr("这个筛选下暂时没有内容。")}
            </EmptyState>
          </div>
        ) : (
          <DayList items={data.items} cards={data.cards} filters={data.filters} todayCount={f.q ? null : data.todayCount} showTags />
        )}
      </div>
      <Pagination page={data.page} pageCount={data.pageCount} href={(p) => pageHref(params, p)} />
      {data.page > data.pageCount && (
        <Link to={pageHref(params, 1)} className="block py-4 text-center text-accent">
          {tr("回到第 1 页")}
        </Link>
      )}
    </div>
  );
}
