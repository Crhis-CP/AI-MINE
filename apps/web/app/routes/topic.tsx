import { PhoneBar } from "../components/shell/PhoneBar";
import { localizedFrom, useTr } from "../i18n";
import { BrandMark } from "../components/BrandMark";
import { apiFetch } from "../lib/http.ts";
import { SITE } from "@amp/industry/site";
import { redirect, useLoaderData, useSearchParams } from "react-router";
import { Link } from "../i18n/navigation";
import type { Route } from "./+types/topic";
import type { z } from "zod";
import { schemas as publicSchemas } from "@amp/contracts/http/public";
import { apiBaseFor } from "../../api-target.ts";
import { SearchField, SourceDateFilters, JurisdictionFilter, hrefWith } from "../features/feed/Filters";
import { PillTabs } from "../components/ui/Tabs";
import { apiGet, ApiError, contractResult, queryString, loadOr404, readerPageHeaders } from "../lib/api.server";
import { markDegraded } from "../lib/cache.server";
import { breadcrumbLd, pageMeta, titled, siteUrl } from "../lib/seo";
import { loadParts } from "../../site-modules";
import type { TopicPagePart } from "../../modules";
import { DayList, Pagination } from "../features/feed/DayList";
import { EmptyState, MoreLink } from "../components/ui/Page";

/** Topic lists retain their mining scope and current country evidence. */
/** The HTML may be shared briefly (TASK-0672); its data is read fresh. */
export function headers() {
  return readerPageHeaders();
}

type TopicPageData = z.infer<typeof publicSchemas.TopicPage>;
const PAGE_PARTS = await loadParts((module) => module.topicPage);
type PagePart = TopicPagePart & { key: string; data: unknown };
function partsOf(data: TopicPageData): PagePart[] {
  return PAGE_PARTS.flatMap(({ name, part }) => {
    const value = data.parts && Object.hasOwn(data.parts, name) ? data.parts[name] : undefined;
    return value !== undefined && part.shows(value, data.topic) ? [{ ...part, key: name, data: value }] : [];
  });
}

export async function loader({ params, request }: Route.LoaderArgs) {
  if ([...params.slug].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Response("Not found", { status: 404 });
  const search = new URL(request.url).searchParams;
  const page = params.page ? Number(params.page) : Math.max(1, Number.parseInt(search.get("page") ?? "1", 10) || 1);
  if (params.page !== undefined && (!/^\d+$/.test(params.page) || page < 1)) throw new Response("Not found", { status: 404 });
  // Page 1 lives at the topic's own address (308).
  if (params.page === "1") throw redirect(localizedFrom(request.url, `/topics/${encodeURIComponent(params.slug)}`), 308);
  const topicPath = `/api/site/topics/${encodeURIComponent(params.slug)}`;
  // The page's list comes from the pool below, so the topic is read without its own (TASK-0714).
  const readTopic = async (wanted: number) =>
    publicSchemas.TopicPage.parse(
      await apiGet<unknown>(`${topicPath}?page=${wanted}&items=none`, {
        signal: request.signal,
        baseUrl: apiBaseFor(),
      }),
    );
  const query = {
    readingGroups: "reports-v1",
    topic: params.slug,
    page,
    q: search.get("q") || undefined,
    tab: search.get("tab") === "relevance" ? "relevance" : undefined,
    source: search.get("source") || undefined,
    mineral: search.get("mineral") || undefined,
    jurisdiction: search.get("jurisdiction") || undefined,
    on: search.get("on") || undefined,
    from: search.get("from") || undefined,
    to: search.get("to") || undefined,
    selected: search.get("selected") === "true" || undefined,
  };
  // The topic and the list are independent: both are asked for at once. An unknown topic still answers 404 first.
  const topicRead = loadOr404(() => readTopic(1), { signal: request.signal });
  const poolRead = loadOr404(
    () =>
      apiFetch("/api/site/pool", {
        params: { query },
        querySerializer: () => queryString({ ...query, selected: query.selected ? "true" : undefined }).slice(1),
        headers: { accept: "application/json", "x-amp-ssr": "1" },
        signal: request.signal,
        baseUrl: apiBaseFor(),
      }).then((result) => contractResult(result, publicSchemas.ReportGroupedPoolResponse)),
    { signal: request.signal },
  );
  poolRead.catch(() => {});
  let data = await topicRead;
  const pool = await poolRead;
  const filtered = [
    pool.filters.q,
    pool.filters.source,
    pool.filters.mineral,
    pool.filters.jurisdiction,
    pool.filters.on,
    pool.filters.from,
    pool.filters.to,
    pool.filters.selected,
  ].some(Boolean);
  if (filtered) data = { ...data, parts: undefined };
  else if (PAGE_PARTS.length && pool.page > 1) {
    data = await loadOr404(
      async () => {
        try {
          return await readTopic(pool.page);
        } catch (error) {
          // A lagging catalogue count cannot remove the live list or substitute page one's parts.
          if (error instanceof ApiError && error.status === 404) return { ...data, parts: undefined };
          throw error;
        }
      },
      { signal: request.signal },
    );
  }
  const countries =
    data.topic.group === "genre"
      ? await apiFetch("/api/site/jurisdictions", { signal: request.signal, baseUrl: apiBaseFor() })
          .then((result) => contractResult(result, publicSchemas.PolicyJurisdictionList))
          .catch(() => {
            // Without the country list the policy link falls back to a search; such a page is not cached.
            markDegraded();
            return [];
          })
      : [];
  const country = countries.find((country) => country.label === data.topic.name);
  const policyLink = country ? `/policies?jurisdiction=${country.code}` : `/policies?q=${encodeURIComponent(data.topic.name)}`;
  return { data: { ...data, items: pool.items, page: pool.page, pageCount: pool.pageCount }, pool, policyLink };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: titled("主题不存在") }, { name: "robots", content: "noindex" }];
  const { topic, page } = loaderData.data;
  const parts = partsOf(loaderData.data);
  const news = parts
    .flatMap((part) => part.news(part.data))
    .slice(0, 2)
    .map((title) => title.replace(/[。.]$/u, ""))
    .join("；");
  const description = news ? Array.from(`${news}。${topic.definition}`).slice(0, 150).join("") : topic.definition;
  const path = page > 1 ? `/topics/${topic.slug}/page/${page}` : `/topics/${topic.slug}`;
  const crumbs = breadcrumbLd([
    { name: SITE.name, path: "/" },
    { name: "主题", path: "/topics" },
    { name: topic.name, path: `/topics/${topic.slug}` },
  ]);
  return pageMeta({
    title: page > 1 ? `${topic.name} · 第 ${page} 页` : parts.length ? `${topic.name} · ${parts.map((part) => part.name).join("、")}` : topic.name,
    description,
    path,
    image: `/og/topics/${topic.slug}.png`,
    noindex: !topic.indexable,
    jsonLd: parts.length
      ? [
          crumbs,
          {
            "@context": "https://schema.org",
            "@type": "CollectionPage",
            name: topic.name,
            hasPart: parts.map((part) => ({
              "@type": "ItemList",
              name: part.name,
              itemListElement: part.entries(part.data).map((entry, index) => ({
                "@type": "ListItem",
                position: index + 1,
                item: { "@type": "Thing", name: entry.title, ...(entry.href ? { url: new URL(entry.href, siteUrl()).href } : {}) },
              })),
            })),
          },
        ]
      : crumbs,
  });
}

export default function TopicPage() {
  const tr = useTr();
  const { data, pool, policyLink } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const { topic, items, page, pageCount } = data;
  const parts = partsOf(data);
  const picks = pool.filters.selected === true;
  const base = `/topics/${topic.slug}`;
  const href = (p: number) => {
    const query = new URLSearchParams(params);
    if (p <= 1) query.delete("page");
    else query.set("page", String(p));
    return `${base}${query.size ? `?${query}` : ""}`;
  };
  const first = (page - 1) * 20 + 1;
  const last = first + items.length - 1;
  return (
    <div className="pb-6 [--phone-bar-offset:48px] lg:[--phone-bar-offset:0px]">
      <PhoneBar back={{ to: "/topics", label: tr("全部主题") }} title={topic.name} />
      <header className="pb-4 pt-5 lg:pt-1">
        <div className="flex items-start justify-between gap-4">
          <h1 data-page-title="" className="flex items-center gap-2.5 text-[22px] font-bold leading-[1.35] text-ink">
            {topic.brand && <BrandMark brand={topic.brand} size={32} />}
            {topic.name}
          </h1>
          <span className="hidden pt-2 lg:block">
            <MoreLink to="/topics">{tr("全部主题")}</MoreLink>
          </span>
        </div>
        <p className="mt-1 max-w-[640px] text-[14px] leading-relaxed text-ink-3">{topic.definition}</p>
        <div className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <span className="text-[13.5px] text-ink-4">
            <span className="num mr-1 text-[20px] font-bold text-ink">{pool.total.toLocaleString("zh-CN")}</span>
            {tr("条")}
            {picks ? tr("精选") : tr("动态")}
          </span>
          <span className="num text-[13.5px] text-ink-4">
            {tr("近 30 天")} {topic.recent ?? 0}
          </span>
          {topic.related.length > 0 && (
            <span className="flex flex-wrap items-center gap-1.5 text-[13.5px]">
              <span className="text-ink-4">{tr("相关主题")}</span>
              {topic.related.map((r) => (
                <Link key={r.slug} to={`/topics/${r.slug}`} className="chip">
                  {r.name}
                </Link>
              ))}
            </span>
          )}
        </div>
      </header>

      {parts.map((part) => (
        <div key={`${part.key}:${topic.slug}`} className="mb-8">
          <part.Block data={part.data} topic={topic} />
        </div>
      ))}

      {/* One switch and one filter panel (UI update, Owner 2026-11-05) instead of loose links and stacked forms. */}
      <div className="my-4 flex flex-wrap items-center justify-between gap-3">
        <PillTabs
          label={tr("主题栏目")}
          layoutId="topic-scope"
          active={picks ? "picks" : "all"}
          items={[
            { key: "all", label: tr("最新动态"), to: hrefWith(base, params, { selected: null }), resetScroll: true },
            { key: "picks", label: tr("精选"), to: hrefWith(base, params, { selected: "true" }), resetScroll: true },
          ]}
        />
        <Link
          to={policyLink}
          className="inline-flex h-9 items-center gap-1 rounded-control border border-line bg-surface px-3 text-[13.5px] font-medium text-accent hover:bg-bg-sunk"
        >
          {tr("法规")} →
        </Link>
      </div>
      <div className="mb-5 rounded-card border border-line bg-surface px-3 py-3">
        <SearchField
          action={base}
          variant="bar"
          defaultValue={params.get("q") ?? ""}
          keep={Object.fromEntries([...params].filter(([key]) => !["page", "q"].includes(key)))}
        />
        <div className="mt-2.5 border-t border-line-soft pt-2.5">
          <JurisdictionFilter base={base} value={params.get("jurisdiction")} compact />
        </div>
        <SourceDateFilters base={base} facets={pool.facets} flat />
      </div>
      <div className="mb-1 mt-2 flex items-baseline justify-between">
        <h2 className="text-[18px] font-bold text-ink">{picks ? tr("最新精选") : tr("最新动态")}</h2>
        {items.length > 0 && (
          <span className="num text-[13px] text-ink-4">
            {tr("第 {first}–{last} 条 · 共 {total} 条", { first, last, total: pool.total.toLocaleString("zh-CN") })}
          </span>
        )}
      </div>
      {items.length === 0 ? (
        <div className="lg:card">
          <EmptyState title={picks ? tr("这个主题暂时还没有精选内容") : tr("这个主题暂时还没有内容")} />
        </div>
      ) : (
        <DayList items={items} cards={pool.cards} filters={pool.filters} />
      )}
      {page > pageCount && (
        <Link to={href(1)} className="block py-4 text-center text-accent">
          {tr("回到第 1 页")}
        </Link>
      )}
      <Pagination page={page} pageCount={pageCount} href={href} />
    </div>
  );
}
