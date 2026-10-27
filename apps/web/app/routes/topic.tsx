import { PhoneBar } from "../components/shell/PhoneBar";
import { BrandMark } from "../components/BrandMark";
import { apiFetch } from "../lib/http.ts";
import { SITE } from "@amp/industry/site";
import { Link, redirect, useLoaderData, useSearchParams } from "react-router";
import type { Route } from "./+types/topic";
import type { z } from "zod";
import { schemas as publicSchemas } from "@amp/contracts/http/public";
import { apiBaseFor } from "../../api-target.ts";
import { SearchField, SourceDateFilters, JurisdictionFilter, hrefWith } from "../features/feed/Filters";
import { apiGet, ApiError, contractResult, queryString, loadOr404 } from "../lib/api.server";
import { breadcrumbLd, pageMeta, titled, siteUrl } from "../lib/seo";
import { loadParts } from "../../site-modules";
import type { TopicPagePart } from "../../modules";
import { DayList, Pagination } from "../features/feed/DayList";
import { EmptyState, MoreLink } from "../components/ui/Page";

/** Topic lists retain their mining scope and current country evidence. */
export function headers() {
  return { "Cache-Control": "no-store" };
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
  if (params.page === "1") throw redirect(`/topics/${encodeURIComponent(params.slug)}`, 308);
  const topicPath = `/api/site/topics/${encodeURIComponent(params.slug)}`;
  const readTopic = async (wanted: number) =>
    publicSchemas.TopicPage.parse(
      await apiGet<unknown>(`${topicPath}?page=${wanted}`, {
        signal: request.signal,
        baseUrl: apiBaseFor(),
      }),
    );
  let data = await loadOr404(() => readTopic(1), { signal: request.signal });
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
  const pool = await loadOr404(
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
          .catch(() => [])
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
      <PhoneBar back={{ to: "/topics", label: "全部主题" }} title={topic.name} />
      <header className="pb-4 pt-5 lg:pt-1">
        <div className="flex items-start justify-between gap-4">
          <h1 data-page-title="" className="flex items-center gap-2.5 text-[22px] font-bold leading-[1.35] text-ink">
            {topic.brand && <BrandMark brand={topic.brand} size={32} />}
            {topic.name}
          </h1>
          <span className="hidden pt-2 lg:block">
            <MoreLink to="/topics">全部主题</MoreLink>
          </span>
        </div>
        <p className="mt-1 max-w-[640px] text-[13px] leading-relaxed text-ink-3">{topic.definition}</p>
        <div className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <span className="text-[12.5px] text-ink-4">
            <span className="num mr-1 text-[20px] font-bold text-ink">{pool.total.toLocaleString("zh-CN")}</span>条{picks ? "精选" : "动态"}
          </span>
          {topic.related.length > 0 && (
            <span className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
              <span className="text-ink-4">相关主题</span>
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

      <p className="mb-3 text-[13px] text-ink-3">近 30 天 {topic.recent ?? 0} 条动态</p>
      <nav aria-label="主题栏目" className="my-4 flex gap-5 text-[14px]">
        <Link to={hrefWith(base, params, { selected: null })} aria-current={!picks ? "page" : undefined} className="text-accent">
          最新动态
        </Link>
        <Link to={hrefWith(base, params, { selected: "true" })} aria-current={picks ? "page" : undefined} className="text-accent">
          精选
        </Link>
        <Link to={policyLink} className="text-accent">
          法规
        </Link>
      </nav>
      <SearchField
        action={base}
        variant="bar"
        defaultValue={params.get("q") ?? ""}
        keep={Object.fromEntries([...params].filter(([key]) => !["page", "q"].includes(key)))}
      />
      <JurisdictionFilter base={base} value={params.get("jurisdiction")} />
      <SourceDateFilters base={base} facets={pool.facets} />
      <div className="mb-1 mt-2 flex items-baseline justify-between">
        <h2 className="text-[18px] font-bold text-ink">{picks ? "最新精选" : "最新动态"}</h2>
        {items.length > 0 && (
          <span className="num text-[12px] text-ink-4">
            第 {first}–{last} 条 · 共 {pool.total.toLocaleString("zh-CN")} 条
          </span>
        )}
      </div>
      {items.length === 0 ? (
        <div className="lg:card">
          <EmptyState title={picks ? "这个主题暂时还没有精选内容" : "这个主题暂时还没有内容"} />
        </div>
      ) : (
        <DayList items={items} cards={pool.cards} filters={pool.filters} />
      )}
      {page > pageCount && (
        <Link to={href(1)} className="block py-4 text-center text-accent">
          回到第 1 页
        </Link>
      )}
      <Pagination page={page} pageCount={pageCount} href={href} />
    </div>
  );
}
