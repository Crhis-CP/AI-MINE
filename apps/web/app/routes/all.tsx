import { SITE, withSubject } from "@amp/industry/site";
import { Link, useLoaderData, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/all";
import { createPublicClient, publicSchemas } from "@amp/api-client/public";
import { apiBaseFor } from "../../api-target.ts";
import { isCategoryKey, isChannelKey } from "@amp/contracts/taxonomy";
import { contractResult, loadOr404, queryString } from "../lib/api.server";
import { listPath, pageMeta } from "../lib/seo";
import { CategoryTabs, JurisdictionFilter, SearchField, SourceDateFilters } from "../features/feed/Filters";
import { PillTabs } from "../components/ui/Tabs";
import { DayList, Pagination } from "../features/feed/DayList";
import { HotTopics } from "../features/feed/HotTopics";
import { EmptyState } from "../components/ui/Page";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const channelParam = url.searchParams.get("channel") ?? "all";
  const categoryParam = url.searchParams.get("category");
  const channel = isChannelKey(channelParam) ? channelParam : "all";
  const category = categoryParam && isCategoryKey(categoryParam) ? categoryParam : null;
  const jurisdiction = url.searchParams.get("jurisdiction")?.trim() || null;
  const tag = url.searchParams.get("tag")?.trim() || null;
  const q = url.searchParams.get("q")?.trim().slice(0, 200) || null;
  const tab = url.searchParams.get("tab") === "relevance" ? "relevance" : null;
  // Legacy deep-paging parameters (deep, anchorAt) still open a normal page.
  const page = Math.max(Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1, 1);
  const query = {
    channel: channel === "all" ? undefined : channel,
    category: category ?? undefined,
    tag: tag ?? undefined,
    jurisdiction: jurisdiction ?? undefined,
    q: q ?? undefined,
    tab: tab ?? undefined,
    page: page > 1 ? page : undefined,
    source: url.searchParams.get("source") || undefined,
    mineral: url.searchParams.get("mineral") || undefined,
    on: url.searchParams.get("on") || undefined,
    from: url.searchParams.get("from") || undefined,
    to: url.searchParams.get("to") || undefined,
  } as const;
  const data = await loadOr404(
    () =>
      createPublicClient({ baseUrl: apiBaseFor("/api/site/pool") })
        .GET("/api/site/pool", {
          params: { query },
          querySerializer: () => queryString(query).slice(1),
          headers: { accept: "application/json", "x-amp-ssr": "1" },
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
        })
        .then((result) => contractResult(result, publicSchemas.PoolResponse)),
    { signal: request.signal },
  );
  const policyMatches = q
    ? await createPublicClient({ baseUrl: apiBaseFor("/api/site/policies") })
        .GET("/api/site/policies", {
          params: { query: { q, page: 1, page_size: 5 } },
          headers: { accept: "application/json", "x-amp-ssr": "1" },
          signal: request.signal,
        })
        .then((result) => contractResult(result, publicSchemas.PolicyListResponse))
        .catch(() => null)
    : null;
  return { data, policyMatches, policySearchFailed: !!q && policyMatches === null };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const f = loaderData?.data.filters;
  const q = f?.q;
  const page = loaderData?.data.page ?? 1;
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
  const { data, policyMatches, policySearchFailed } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const navigation = useNavigation();
  const f = data.filters;
  const busy = navigation.state === "loading" && navigation.location?.pathname === "/all";
  const keep = Object.fromEntries([...params].filter(([key]) => !["q", "page", "cursor", "search"].includes(key)));
  const searchTabHref = (tab: "time" | "relevance") => {
    const sp = new URLSearchParams(params);
    sp.delete("page");
    if (tab === "relevance") sp.set("tab", "relevance");
    else sp.delete("tab");
    return `/all?${sp}`;
  };
  const title = f.q ? `搜索“${f.q}”` : f.tag ? `#${f.tag}` : null;
  const updated = new Date(data.freshness).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" });

  return (
    <div className="pb-6">
      {/* Desktop, as on 精选: the title, then one filter row with the search field aligned on the right. */}
      <div className="hidden lg:block">
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">{title ?? `全部${withSubject("动态")}`}</h1>
        <div className="mb-5 mt-4 flex items-center justify-between gap-4">
          <CategoryTabs base="/all" category={f.category} channel={f.channel} layoutId="all-cat-desk" className="min-w-0" />
          <SearchField variant="track" defaultValue={f.q ?? ""} keep={keep} />
        </div>
      </div>

      {/* Phones: title with today's count, the search bar, then the same filter row as 精选. */}
      <div className="lg:hidden">
        <div className="flex items-baseline justify-between pb-3 pt-5">
          <h1 className="text-[22px] font-bold text-ink">{title ?? "全部动态"}</h1>
          {!f.q && (
            <span className="text-[12.5px] text-ink-4">
              今日 <span className="num">{data.todayCount}</span> 条
            </span>
          )}
        </div>
        <SearchField variant="bar" defaultValue={f.q ?? ""} keep={keep} autoFocus={params.get("search") === "1"} />
        <div className="-mx-4 mt-3 border-b border-line-soft px-4 pb-3">
          <CategoryTabs base="/all" category={f.category} channel={f.channel} layoutId="all-cat-mobile" size="sm" className="min-w-0" />
        </div>
      </div>

      <JurisdictionFilter base="/all" value={f.jurisdiction ?? null} />
      <SourceDateFilters base="/all" facets={data.facets} />
      {data.hot && <HotTopics entries={data.hot} />}
      {f.q && (
        <section aria-label="法规政策搜索结果" className="my-4 rounded-card border border-line px-4 py-3">
          <div className="flex justify-between text-[14px]">
            <h2 className="font-semibold">法规政策{policyMatches ? `（${policyMatches.total} 条）` : ""}</h2>
            <Link to={`/policies?q=${encodeURIComponent(f.q)}`} className="text-accent">
              查看全部法规结果 →
            </Link>
          </div>
          {policySearchFailed ? (
            <p className="mt-2 text-[13px] text-ink-3">法规结果暂时无法读取，可进入法规栏目重试。</p>
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
            <p className="mt-2 text-[13px] text-ink-3">未找到相符的法规文书。</p>
          )}
        </section>
      )}
      <p className="my-3 text-[12px] text-ink-4">
        第 {data.page} 页 · 共 {data.total} {data.cards ? "张事件卡" : "条动态"}
        {data.reportTotal !== undefined ? ` · ${data.reportTotal} 篇报道` : ""}
      </p>
      {f.q && (
        <div className="mb-3 mt-3 flex flex-wrap items-center justify-between gap-2 lg:mt-0">
          <PillTabs
            size="xs"
            layoutId="all-search-sort"
            label="搜索排序"
            active={f.tab}
            items={(["time", "relevance"] as const).map((t) => ({ key: t, label: t === "time" ? "最新（标题与摘要）" : "全文相关", to: searchTabHref(t) }))}
          />
          <span className="text-[12px] text-ink-4">
            找到 <span className="num">{data.total}</span> 条 · 更新于 <span className="num">{updated}</span>
          </span>
        </div>
      )}

      <div className={`transition-opacity duration-200 ${busy ? "opacity-50" : ""}`}>
        {data.items.length === 0 ? (
          <div className="mt-2 lg:card">
            <EmptyState
              title="没有找到相关内容"
              action={
                f.q && f.tab === "time" ? (
                  <Link to={searchTabHref("relevance")} className="text-[13px] font-medium text-accent hover:underline">
                    试试“全文相关”，连正文一起搜
                  </Link>
                ) : undefined
              }
            >
              {f.q ? "换个说法，或者去掉筛选再试。" : "这个筛选下暂时没有内容。"}
            </EmptyState>
          </div>
        ) : (
          <DayList items={data.items} cards={data.cards} todayCount={f.q ? null : data.todayCount} showTags />
        )}
      </div>
      <Pagination page={data.page} pageCount={data.pageCount} href={(p) => pageHref(params, p)} />
      {data.page > data.pageCount && (
        <Link to={pageHref(params, 1)} className="block py-4 text-center text-accent">
          回到第 1 页
        </Link>
      )}
    </div>
  );
}
