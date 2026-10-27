import { apiFetch } from "../lib/http.ts";
import { SITE, withSubject } from "@amp/industry/site";
import { Link, data as withHeaders, redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/home";
import { schemas as publicSchemas } from "@amp/contracts/http/public";
import { apiBaseFor } from "../../api-target.ts";
import { isCategoryKey, isChannelKey } from "@amp/contracts/taxonomy";
import { contractResult, loadOr404, queryString } from "../lib/api.server";
import { listPath, organizationLd, pageMeta } from "../lib/seo";
import { Timeline } from "../features/feed/Timeline";
import { HotTopics } from "../features/feed/HotTopics";
import { CategoryTabs, JurisdictionFilter, SearchField, FeedBar } from "../features/feed/Filters";
import { DayList } from "../features/feed/DayList";
import { EmptyState, MoreLink } from "../components/ui/Page";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q");
  // Search lives on /all; keep the parameters so old links still land on results.
  if (q && q.trim()) throw redirect(`/all${url.search}`);
  const channelParam = url.searchParams.get("channel") ?? "all";
  const categoryParam = url.searchParams.get("category");
  const channel = isChannelKey(channelParam) ? channelParam : "all";
  const category = categoryParam && isCategoryKey(categoryParam) ? categoryParam : null;
  const jurisdiction = url.searchParams.get("jurisdiction")?.trim() || null;
  const tag = url.searchParams.get("tag")?.trim() || null;
  const upstream = new Headers();
  const query = {
    channel: channel === "all" ? undefined : channel,
    category: category ?? undefined,
    tag: tag ?? undefined,
    jurisdiction: jurisdiction ?? undefined,
  };
  const data = await loadOr404(
    () =>
      apiFetch("/api/site/timeline", {
        params: { query },
        querySerializer: () => queryString(query).slice(1),
        headers: { accept: "application/json", "x-amp-ssr": "1" },
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
        baseUrl: apiBaseFor(),
      }).then(async (result) => {
        const body = await contractResult(result, publicSchemas.TimelineResponse);
        result.headers.forEach((value, name) => {
          upstream.set(name, value);
        });
        return body;
      }),
    { signal: request.signal },
  );
  // Until the first pick exists, the unfiltered home page shows the newest items of 全部动态 instead of
  // an empty feed; it switches back to picks by itself (Owner, 2026-10-05; DEC-13). An empty three-month
  // window is not that case: older picks still exist, so the page stays the featured entrance.
  const unfilteredEmpty = data.cards.length === 0 && channel === "all" && !category && !tag && !jurisdiction;
  const started = unfilteredEmpty ? await featuredHasStarted(request.signal) : false;
  const waiting = unfilteredEmpty && started === false;
  const latest = waiting ? await loadLatest(request.signal) : null;
  const unavailable = (unfilteredEmpty && started === null) || latest === "failed";
  // A failed read must not be cached: the next request tries 全部动态 again.
  return withHeaders(
    { data, waiting, unavailable, latest: typeof latest === "object" ? latest : null, filters: { channel, category, tag, topic: null, jurisdiction } },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** True when any 精选 exists, including ones outside the homepage window; null preserves an unavailable observation. */
function featuredHasStarted(signal: AbortSignal) {
  return apiFetch("/api/site/stats", {
    headers: { accept: "application/json", "x-amp-ssr": "1" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
    baseUrl: apiBaseFor(),
  })
    .then(async (result) => (await contractResult(result, publicSchemas.SiteStats)).selected > 0)
    .catch(() => null);
}

/** The first page of 全部动态; "empty" or "failed" when there is nothing to show (DR-85). */
function loadLatest(signal: AbortSignal) {
  return apiFetch("/api/site/pool", {
    headers: { accept: "application/json", "x-amp-ssr": "1" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    baseUrl: apiBaseFor(),
  })
    .then((result) => contractResult(result, publicSchemas.PoolResponse))
    .then((pool) => (pool.items.length > 0 ? pool : ("empty" as const)))
    .catch(() => "failed" as const);
}

export function meta({ loaderData }: Route.MetaArgs) {
  const f = loaderData?.filters;
  const path = listPath("/", { channel: f && f.channel !== "all" ? f.channel : null, category: f?.category, tag: f?.tag, jurisdiction: f?.jurisdiction });
  return pageMeta({ path, jsonLd: path === "/" ? organizationLd() : undefined });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

export default function Home() {
  const { data, waiting, unavailable, latest, filters } = useLoaderData<typeof loader>();
  const title = filters.tag ? `#${filters.tag}` : latest ? "最新动态" : "精选";
  // While there are no picks, “全部” stays on this page and the other tabs lead to 全部动态, where the items are.
  const tabsBase = waiting ? "/all" : "/";
  const allTo = waiting ? "/" : undefined;
  return (
    <div className="pb-6 [--phone-bar-offset:48px] lg:[--phone-bar-offset:0px]">
      <FeedBar base="/" category={filters.category} channel={filters.channel} jurisdiction={filters.jurisdiction ?? null} />
      {data.hot && <HotTopics entries={data.hot} cards={data.cards} />}
      <div className="hidden lg:block">
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">{title}</h1>
        <div className="mb-5 mt-4 flex items-center justify-between gap-4">
          <CategoryTabs base={tabsBase} allTo={allTo} category={filters.category} channel={filters.channel} layoutId="home-cat-desk" className="min-w-0" />
          <SearchField variant="track" keep={{ channel: filters.channel, category: filters.category, jurisdiction: filters.jurisdiction }} />
        </div>
      </div>

      <div className="hidden lg:block">
        <JurisdictionFilter base={tabsBase} value={filters.jurisdiction} />
      </div>

      {unavailable ? (
        <EmptyState
          title="精选暂时无法读取"
          action={
            <Link to="/all" className="text-[13px] font-medium text-accent hover:underline">
              查看全部矿业动态
            </Link>
          }
        >
          请稍后重试，或先浏览全部矿业动态。
        </EmptyState>
      ) : latest ? (
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
