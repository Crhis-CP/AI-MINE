import { SITE, withSubject } from "@amp/industry/site";
import { Link, data as withHeaders, redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/home";
import { createPublicClient, publicSchemas } from "@amp/api-client/public";
import { apiBaseFor } from "../../api-target.ts";
import { isCategoryKey, isChannelKey } from "@amp/contracts/taxonomy";
import { contractResult, loadOr404, queryString, releaseBoundCache } from "../lib/api.server";
import { listPath, organizationLd, pageMeta } from "../lib/seo";
import { Wordmark } from "../components/Logo";
import { Timeline } from "../features/feed/Timeline";
import { HotTopics } from "../features/feed/HotTopics";
import { CategoryTabs, SearchField, SearchIconLink } from "../features/feed/Filters";
import { DayList } from "../features/feed/DayList";
import { EmptyState, MoreLink } from "../components/ui/Page";
import { beijingDate, beijingWeekday } from "../lib/format";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q");
  // Search lives on /all; keep the parameters so old links still land on results.
  if (q && q.trim()) throw redirect(`/all${url.search}`);
  const channelParam = url.searchParams.get("channel") ?? "all";
  const categoryParam = url.searchParams.get("category");
  const channel = isChannelKey(channelParam) ? channelParam : "all";
  const category = categoryParam && isCategoryKey(categoryParam) ? categoryParam : null;
  const tag = url.searchParams.get("tag")?.trim() || null;
  const upstream = new Headers();
  const query = { channel: channel === "all" ? undefined : channel, category: category ?? undefined, tag: tag ?? undefined };
  const data = await loadOr404(
    () =>
      createPublicClient({ baseUrl: apiBaseFor("/api/site/timeline") })
        .GET("/api/site/timeline", {
          params: { query },
          querySerializer: () => queryString(query).slice(1),
          headers: { accept: "application/json", "x-amp-ssr": "1" },
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
        })
        .then((result) => {
          const body = contractResult(result, publicSchemas.TimelineResponse);
          result.response.headers.forEach((value, name) => {
            upstream.set(name, value);
          });
          return body;
        }),
    { signal: request.signal },
  );
  // Until the first pick exists, the unfiltered home page shows the newest items of 全部动态 instead of
  // an empty feed; it switches back to picks by itself (Owner, 2026-10-05; DEC-13).
  const waiting = data.cards.length === 0 && channel === "all" && !category && !tag;
  const latest = waiting ? await loadLatest(request.signal) : null;
  // A failed read must not be cached: the next request tries 全部动态 again.
  const seconds = latest === "failed" ? 0 : 60;
  return withHeaders(
    { data, waiting, latest: typeof latest === "object" ? latest : null, filters: { channel, category, tag, topic: null } },
    { headers: releaseBoundCache(data.refreshAt, seconds, Date.now(), upstream) },
  );
}

/** The first page of 全部动态; "empty" or "failed" when there is nothing to show (DR-85). */
function loadLatest(signal: AbortSignal) {
  return createPublicClient({ baseUrl: apiBaseFor("/api/site/pool") })
    .GET("/api/site/pool", {
      headers: { accept: "application/json", "x-amp-ssr": "1" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    })
    .then((result) => contractResult(result, publicSchemas.PoolResponse))
    .then((pool) => (pool.items.length > 0 ? pool : ("empty" as const)))
    .catch(() => "failed" as const);
}

export function meta({ loaderData }: Route.MetaArgs) {
  const f = loaderData?.filters;
  const path = listPath("/", { channel: f && f.channel !== "all" ? f.channel : null, category: f?.category, tag: f?.tag });
  return pageMeta({ path, jsonLd: path === "/" ? organizationLd() : undefined });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

function TodayLabel() {
  const today = beijingDate(Date.now());
  const [, m, d] = today.split("-").map(Number) as [number, number, number];
  return (
    <span className="text-[12.5px] text-ink-4" suppressHydrationWarning>
      {m}月{d}日 · {beijingWeekday(today).replace("星期", "周")}
    </span>
  );
}

export default function Home() {
  const { data, waiting, latest, filters } = useLoaderData<typeof loader>();
  const title = filters.tag ? `#${filters.tag}` : latest ? "最新动态" : "精选";
  // While there are no picks, “全部” stays on this page and the other tabs lead to 全部动态, where the items are.
  const tabsBase = waiting ? "/all" : "/";
  const allTo = waiting ? "/" : undefined;
  return (
    <div className="pb-6">
      {/* Phones: brand bar, today's hot topics, then the feed under "最新精选". */}
      <div className="flex h-14 items-center justify-between lg:hidden">
        <Wordmark size={20} className="text-ink" />
        <TodayLabel />
      </div>
      <div className="hidden lg:block">
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">{title}</h1>
        <div className="mb-5 mt-4 flex items-center justify-between gap-4">
          <CategoryTabs base={tabsBase} allTo={allTo} category={filters.category} channel={filters.channel} layoutId="home-cat-desk" className="min-w-0" />
          <SearchField variant="track" keep={{ category: filters.category }} />
        </div>
      </div>

      {data.hot && <HotTopics entries={data.hot} />}

      <h2 className="mt-6 text-[20px] font-bold text-ink lg:hidden">{filters.tag || latest ? title : "最新精选"}</h2>
      <div className="-mx-4 mt-3 flex items-center gap-2 pl-4 pr-2 lg:hidden">
        <CategoryTabs
          base={tabsBase}
          allTo={allTo}
          category={filters.category}
          channel={filters.channel}
          layoutId="home-cat-mobile"
          size="sm"
          className="min-w-0 flex-1"
        />
        <SearchIconLink />
      </div>

      {latest ? (
        <div className="mt-2">
          <p className="mb-2 text-[13px] text-ink-3">精选还没开始，先看最新动态。</p>
          <DayList items={latest.items} todayCount={latest.todayCount} showTags />
          {latest.pageCount > 1 && (
            <div className="mt-4 text-center">
              <MoreLink to="/all?page=2">更多动态</MoreLink>
            </div>
          )}
        </div>
      ) : waiting ? (
        <div className="lg:card">
          <EmptyState
            title="暂时没有符合条件的精选"
            action={
              <Link to="/all" className="text-[13px] font-medium text-accent hover:underline">
                查看全部矿业动态
              </Link>
            }
          >
            当前可在全部矿业动态中阅读已收录资讯。
          </EmptyState>
        </div>
      ) : (
        <Timeline initial={data} filters={data.filters} />
      )}
    </div>
  );
}
