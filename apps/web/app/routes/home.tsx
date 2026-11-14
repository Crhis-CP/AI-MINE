import { apiFetch } from "../lib/http.ts";
import { localizedFrom, useT, useTagLabel } from "../i18n";
import { data as withHeaders, redirect, useLoaderData } from "react-router";
import { Link } from "../i18n/navigation";
import type { Route } from "./+types/home";
import { schemas as publicSchemas } from "@amp/contracts/http/public";
import { apiBaseFor } from "../../api-target.ts";
import { canonicalCategoryFilter, isChannelKey } from "@amp/contracts/taxonomy";
import { contractResult, loadOr404, queryString, readerPageHeaders } from "../lib/api.server";
import { markDegraded } from "../lib/cache.server";
import { listPath, organizationLd, pageMeta, websiteLd } from "../lib/seo";
import { Timeline } from "../features/feed/Timeline";
import { HotTopics } from "../features/feed/HotTopics";
import { WorldMap } from "../features/feed/WorldMap";
import { FeedBar, FeedToolbar } from "../features/feed/Filters";
import { DayList } from "../features/feed/DayList";
import { HomeCountry } from "../features/region/HomeCountry";
import { EmptyState, MoreLink } from "../components/ui/Page";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q");
  // Search lives on /all; keep the parameters so old links still land on results.
  if (q && q.trim()) throw redirect(localizedFrom(request.url, `/all${url.search}`));
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
  const query = {
    readingGroups: "reports-v1",
    channel: channel === "all" ? undefined : channel,
    category: category ?? undefined,
    tag: tag ?? undefined,
    jurisdiction: jurisdiction ?? undefined,
  };
  let upstream: Headers | undefined;
  const data = await loadOr404(
    () =>
      apiFetch("/api/site/timeline", {
        params: { query },
        querySerializer: () => queryString(query).slice(1),
        headers: { accept: "application/json", "x-amp-ssr": "1" },
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
        baseUrl: apiBaseFor(),
      }).then(async (result) => {
        const body = await contractResult(result, publicSchemas.ReportGroupedTimelineResponse);
        upstream = result.headers;
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
  // A failed read must not be cached: the next request tries 全部动态 again. Otherwise the HTML may be shared until the
  // next scheduled release in this scope at the latest (TASK-0672).
  if (unavailable) markDegraded();
  return withHeaders(
    { data, waiting, unavailable, latest: typeof latest === "object" ? latest : null, filters: { channel, category, tag, topic: null, jurisdiction } },
    { headers: unavailable ? { "Cache-Control": "no-store" } : readerPageHeaders(data.refreshAt, upstream) },
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
    params: { query: { readingGroups: "reports-v1" } },
    headers: { accept: "application/json", "x-amp-ssr": "1" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    baseUrl: apiBaseFor(),
  })
    .then((result) => contractResult(result, publicSchemas.ReportGroupedPoolResponse))
    .then((pool) => (pool.items.length > 0 ? pool : ("empty" as const)))
    .catch(() => "failed" as const);
}

export function meta({ loaderData }: Route.MetaArgs) {
  const f = loaderData?.filters;
  const path = listPath("/", { channel: f && f.channel !== "all" ? f.channel : null, category: f?.category, tag: f?.tag, jurisdiction: f?.jurisdiction });
  return pageMeta({ path, jsonLd: path === "/" ? [organizationLd(), websiteLd()] : undefined });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

export default function Home() {
  const tf = useT().feed;
  const tagLabel = useTagLabel();
  const { data, waiting, unavailable, latest, filters } = useLoaderData<typeof loader>();
  const title = filters.tag ? `#${tagLabel(filters.tag)}` : latest ? tf.latest : tf.picks;
  // While there are no picks, “全部” stays on this page and the other tabs lead to 全部动态, where the items are.
  const tabsBase = waiting ? "/all" : "/";
  const allTo = waiting ? "/" : undefined;
  return (
    <div className="pb-6 [--phone-bar-offset:48px] lg:[--phone-bar-offset:0px]">
      <FeedBar base="/" category={filters.category} jurisdiction={filters.jurisdiction ?? null} />
      {/* The reader's country first, the world below; only on the unfiltered page, where no country was asked for. */}
      {!filters.jurisdiction && !filters.category && !filters.tag && filters.channel === "all" && <HomeCountry />}
      {/* Direction C overview: the hotspot board beside the survey map on desktop; phones and tablets show the
          map under the board (TASK-0568: it used to be desktop only). */}
      <div className="lg:grid lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:items-start lg:gap-5">
        {data.hot && <HotTopics entries={data.hot} cards={data.cards} />}
        <div className="min-w-0">
          <WorldMap base={tabsBase} selected={filters.jurisdiction ?? null} />
        </div>
      </div>
      <FeedToolbar
        title={title}
        base={tabsBase}
        allTo={allTo}
        category={filters.category}
        jurisdiction={filters.jurisdiction ?? null}
        layoutId="home-cat-desk"
      />

      {unavailable ? (
        <EmptyState
          title={tf.picksUnavailable}
          action={
            <Link to="/all" className="text-[13px] font-medium text-accent hover:underline">
              {tf.viewAll}
            </Link>
          }
        >
          {tf.retryOrAll}
        </EmptyState>
      ) : latest ? (
        <div className="mt-2">
          <p className="mb-2 text-[13px] text-ink-3">{tf.picksNotStarted}</p>
          <DayList items={latest.items} cards={latest.cards} filters={latest.filters} todayCount={latest.todayCount} showTags />
          {latest.pageCount > 1 && (
            <div className="mt-4 text-center">
              <MoreLink to="/all?page=2">{tf.moreNews}</MoreLink>
            </div>
          )}
        </div>
      ) : waiting ? (
        <div className="lg:card">
          <EmptyState
            title={tf.noPicks}
            action={
              <Link to="/all" className="text-[13px] font-medium text-accent hover:underline">
                {tf.viewAll}
              </Link>
            }
          >
            {tf.noPicksHint}
          </EmptyState>
        </div>
      ) : (
        <Timeline initial={data} filters={data.filters} />
      )}
    </div>
  );
}
