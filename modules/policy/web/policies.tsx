import { apiFetch, Form, Link } from "@amp/web/extension";
import { useTr } from "@amp/web/i18n";
import { data as withHeaders, useLoaderData, useSearchParams } from "react-router";
import type { LoaderFunctionArgs, MetaArgs } from "react-router";
import { schemas as publicSchemas } from "@amp/contracts/http/public";
import { PolicyListQuery } from "@amp/contracts/http/public";
import type { PolicyCard } from "@amp/contracts/http/public";
import { apiBaseFor } from "@amp/web/extension.server";
import { contractResult } from "@amp/web/extension.server";
import { pageMeta } from "@amp/web/extension";
import { Pagination } from "@amp/web/pagination";
import { EmptyState } from "@amp/web/page";
import {
  PolicyCardList,
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
} from "./features/PolicyUI";
import {
  ALL_THEMES,
  NO_THEME,
  Breadcrumb,
  ChipRow,
  EmptyNames,
  JurisdictionCards,
  PolicySearch,
  SectionTitle,
  ThemeCards,
  policiesHref,
  themeKeys,
  type ThemeKey,
} from "./features/PolicyBrowse";
import { usePolicyText } from "./features/reader";

/** Which level of the drill-down an address shows: 1 jurisdictions, 2 themes of one jurisdiction, 3 documents. */
type Level = 1 | 2 | 3;
const LIST_KEYS = ["theme", "q", "nature", "stage", "from", "to", "page"] as const;
type Listing = ReturnType<typeof publicSchemas.PolicyListResponse.parse>;
/** Every card of one filter is read in pages of fifty; past this many pages the whole set is not read. */
const PAGE = 50,
  MAX_PAGES = 20;

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  // `theme=all` (every theme, as a list) and `theme=none` (documents not given a theme yet) are the web's own; the API never sees them.
  const allThemes = url.searchParams.get("theme") === ALL_THEMES,
    noTheme = url.searchParams.get("theme") === NO_THEME;
  const input = Object.fromEntries(
    [...url.searchParams].filter(([key, v]) => key !== "_routes" && v && !(key === "theme" && (v === ALL_THEMES || v === NO_THEME))),
  );
  const parsed = PolicyListQuery.safeParse(input);
  const invalid = !parsed.success || [...url.searchParams.keys()].some((k) => url.searchParams.getAll(k).length > 1);
  const level: Level = allThemes || noTheme || LIST_KEYS.some((k) => k in input) ? 3 : input.jurisdiction ? 2 : 1;
  const empty = { listing: null, scope: null, counts: null, unthemed: null };
  if (invalid)
    return withHeaders({ ...empty, level: 3 as Level, allThemes, noTheme, filters: { ...PolicyListQuery.parse({}), ...input }, error: 400 }, { status: 400 });
  const query = parsed.data;
  const apiBase = apiBaseFor();
  const options = { headers: { accept: "application/json", "x-amp-ssr": "1" }, signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]) };
  const list = (params: Record<string, unknown>) =>
    apiFetch("/api/site/policies", { ...options, params: { query: PolicyListQuery.parse(params) }, baseUrl: apiBase }).then((r) =>
      contractResult(r, publicSchemas.PolicyListResponse),
    );
  /** Every card matching `params`, in the list's order; null when there are too many to read them all. */
  const everyCard = async (params: Record<string, unknown>) => {
    const first = await list({ ...params, page: 1, page_size: PAGE });
    const pages = Math.ceil(first.total / PAGE);
    if (pages > MAX_PAGES) return null;
    const rest = await Promise.all(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => list({ ...params, page: i + 2, page_size: PAGE })));
    return { first, items: [first, ...rest].flatMap((page) => page.items) };
  };
  const scopeCall = apiFetch("/api/site/policies/scope", { ...options, baseUrl: apiBase }).then((r) => contractResult(r, publicSchemas.PolicyScopeList));
  const { page: _page, page_size: _size, ...filters } = query;

  let listing: Promise<Listing>;
  let themeCounts: Promise<{ counts: Record<ThemeKey, number | null>; unthemed: number | null }> | null = null;
  /**
   * Each theme's documents as the API returns them: the API matches a theme on every current language version of a
   * document, not only the card shown, so counts and “not yet given a theme” come from these answers, not from the shown
   * cards' own themes (Codex review #352). A theme that fails or has too many to read keeps its total (or no count).
   */
  const byThemeAnswer = async (params: Record<string, unknown>) => {
    const answers = await Promise.allSettled(
      themeKeys.map(async (theme) => {
        const every = await everyCard({ ...params, theme });
        return every
          ? { total: every.first.total, ids: every.items.map((card) => card.id) }
          : { total: (await list({ ...params, theme, page_size: 1 })).total, ids: [] };
      }),
    );
    return {
      counts: Object.fromEntries(themeKeys.map((key, i) => [key, answers[i]!.status === "fulfilled" ? answers[i].value.total : null])) as Record<
        ThemeKey,
        number | null
      >,
      ids: new Set(answers.flatMap((answer) => (answer.status === "fulfilled" ? answer.value.ids : []))),
    };
  };
  /** Documents of no theme: none on the card shown and none in any theme's answer (equal to the API's rule when all answer). */
  const withoutTheme = <T extends { id: string; themes: unknown[] }>(cards: T[], ids: Set<string>) =>
    cards.filter((card) => card.themes.length === 0 && !ids.has(card.id));
  if (level === 2) {
    // The themes of one jurisdiction are counted with the documents no theme has been given yet (themes come with a
    // finished interpretation), so the theme step is never a dead end.
    listing = list({ jurisdiction: query.jurisdiction, page_size: 3 });
    themeCounts = Promise.all([everyCard({ jurisdiction: query.jurisdiction }).catch(() => null), byThemeAnswer({ jurisdiction: query.jurisdiction })])
      .then(([all, byTheme]) => ({ counts: byTheme.counts, unthemed: all ? withoutTheme(all.items, byTheme.ids).length : null }))
      .catch(() => ({ counts: Object.fromEntries(themeKeys.map((key) => [key, null])) as Record<ThemeKey, null>, unthemed: null }));
  } else if (noTheme) {
    listing = Promise.all([everyCard(filters), byThemeAnswer(filters)]).then(([all, byTheme]) => {
      if (!all) throw new Error("too many documents to list without a theme");
      const items = withoutTheme(all.items, byTheme.ids);
      return {
        ...all.first,
        items: items.slice((query.page - 1) * query.page_size, query.page * query.page_size),
        page: query.page,
        page_size: query.page_size,
        total: items.length,
      };
    });
  } else listing = list(query);
  const [listed, scope, themed] = await Promise.allSettled([listing, scopeCall, themeCounts ?? Promise.resolve(null)]);
  const values = {
    level,
    allThemes,
    noTheme,
    listing: listed.status === "fulfilled" ? listed.value : null,
    scope: scope.status === "fulfilled" ? scope.value : null,
    counts: themed.status === "fulfilled" ? (themed.value?.counts ?? null) : null,
    unthemed: themed.status === "fulfilled" ? (themed.value?.unthemed ?? null) : null,
    filters: query,
    error: listed.status === "rejected" ? 503 : null,
  };
  return withHeaders(values, { status: values.error ?? 200 });
}
export const headers = policyCache;
export const ErrorBoundary = PolicyError;
export function meta({ location }: MetaArgs<typeof loader>) {
  return pageMeta({
    title: "法规政策动态",
    path: location.pathname + location.search,
    noindex: [...new URLSearchParams(location.search).keys()].some((k) => k !== "page"),
  });
}

/** The state of the policy line on one quiet line: paused or the pilot, as the operator's switch says, and where the notice is. */
function UpdateNotice({ updates }: { updates: "paused" | "pilot" | undefined }) {
  const tr = useTr();
  if (!updates) return null;
  return (
    <p className="mt-3 text-[12.5px] leading-6 text-ink-3" data-policy-updates={updates}>
      <span className="font-medium text-ink-2">{updates === "pilot" ? tr("试点更新中") : tr("暂停更新")}</span>
      {" · "}
      {updates === "pilot" ? tr("新文书先提供原文存档与逐条对照，AI 解读暂不更新；已发布内容照常可查。") : tr("已发布内容照常可查，恢复时间另行公告。")}{" "}
      <Link to="/changelog" className="whitespace-nowrap text-accent underline underline-offset-2">
        {tr("查看公告")}
      </Link>
    </p>
  );
}

export default function PoliciesPage() {
  const tr = useTr();
  const text = usePolicyText();
  const { level, allThemes, noTheme, listing, scope, counts, unthemed, filters, error } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  usePolicyListReturn();
  usePolicyRecheck();
  const jurisdiction = filters.jurisdiction;
  const known = jurisdiction
    ? (scope?.items.find((i) => i.jurisdiction.code === jurisdiction)?.jurisdiction ??
      listing?.items.flatMap((p) => p.jurisdictions).find((j) => j.code === jurisdiction))
    : null;
  const jurisdictionLabel = jurisdiction ? text.place(known ?? { code: jurisdiction, label: jurisdiction }) : null;
  const themeLabel = noTheme ? tr("未归入主题") : filters.theme && filters.theme in themes ? tr.maybe(themes[filters.theme as ThemeKey]) : null;
  const themeParam = filters.theme ?? (noTheme ? NO_THEME : allThemes ? ALL_THEMES : undefined);
  // Changing a chip keeps the reader on the list (level 3): without a theme the list is “all themes”.
  const listTheme = themeParam ?? ALL_THEMES;
  const chipHref = (key: "nature" | "stage" | "q", value?: string) => {
    const next = new URLSearchParams(params);
    next.delete("page");
    if (value) next.set(key, value);
    else next.delete(key);
    if (!next.get("theme")) next.set("theme", listTheme);
    return `/policies?${next}`;
  };
  const pageHref = (page: number) => {
    const next = new URLSearchParams(params);
    next.set("page", String(page));
    return `/policies?${next}`;
  };
  const crumbs =
    level === 1
      ? []
      : [
          { label: tr("法规政策动态"), to: "/policies" },
          ...(level === 2
            ? [{ label: jurisdictionLabel ?? "" }]
            : [
                jurisdiction
                  ? { label: jurisdictionLabel ?? jurisdiction, to: policiesHref({ jurisdiction }) }
                  : { label: tr("全部国家与组织"), to: "/policies" },
                { label: themeLabel ?? tr("全部主题") },
              ]),
        ];
  const errorState = error ? (
    <EmptyState title={error === 400 ? tr("筛选参数有误") : tr("暂时无法读取政策法规")}>
      {error === 400 ? tr("请调整筛选条件后重试，其他已填写的条件仍保留。") : tr("请稍后重新读取；读取失败不代表没有新法规。")}
    </EmptyState>
  ) : null;
  const emptyState = (
    <EmptyState title={tr("当前筛选暂无已公开法规")}>{tr("可调整国家、主题或搜索词查看其他内容；不能据此判断有关法域没有新法规。")}</EmptyState>
  );
  const allLink = (count: number, to: string) => (
    <Link to={to} className="text-[13px] font-medium text-accent">
      {tr("查看全部 {count} 份文书 →", { count })}
    </Link>
  );
  const groups = [
    ["country", tr("目标国家")],
    ["organization", tr("跨国与国际组织")],
  ] as const;
  const latest = new Map<string, PolicyCard>();
  for (const policy of listing?.items ?? []) for (const j of policy.jurisdictions) if (!latest.has(j.code)) latest.set(j.code, policy);
  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-10 pt-5 lg:pt-0" data-policies data-policy-level={level}>
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[24px] font-semibold text-ink">{tr("法规政策动态")}</h1>
          <p className="mt-2 text-[14px] text-ink-3">{tr("先选国家或组织，再选经营主题，逐层找到官方文书、完整中文和原文证据。")}</p>
        </div>
        <PolicySearch q={filters.q} keep={{ jurisdiction, theme: level === 3 ? themeParam : undefined }} />
      </header>
      <UpdateNotice updates={scope?.updates} />
      <PolicyTabs />
      {crumbs.length > 0 && <Breadcrumb items={crumbs} />}

      {level === 1 &&
        (errorState ?? (
          <>
            {!scope ? (
              <p className="mt-5 text-[13px] text-amber-ink">
                {tr("国家选项暂时无法读取。")}
                <Link to="." className="underline">
                  {tr("重新读取")}
                </Link>
              </p>
            ) : (
              <section aria-labelledby="policy-pick-jurisdiction">
                <SectionTitle>
                  <span id="policy-pick-jurisdiction">{tr("选择国家或组织")}</span>
                </SectionTitle>
                <p className="mt-1 text-[12.5px] text-ink-4">{tr("数字是目前可公开阅读的文书份数。")}</p>
                {groups.map(([kind, label]) => {
                  const items = scope.items.filter((i) => i.jurisdiction.kind === kind && i.readable_count > 0);
                  if (!items.length) return null;
                  return (
                    <section key={kind} className="mt-5">
                      <h3 className="text-[13px] font-medium text-ink-3">{label}</h3>
                      <JurisdictionCards items={items} latest={latest} />
                    </section>
                  );
                })}
                <EmptyNames
                  label={tr("暂无已公开文书：")}
                  testId="jurisdictions"
                  items={groups.flatMap(([kind]) =>
                    scope.items
                      .filter((i) => i.jurisdiction.kind === kind && i.readable_count === 0)
                      .map((i) => ({ key: i.jurisdiction.code, name: text.place(i.jurisdiction), to: policiesHref({ jurisdiction: i.jurisdiction.code }) })),
                  )}
                />
              </section>
            )}
            <SectionTitle aside={listing && listing.total > 5 ? allLink(listing.total, policiesHref({ theme: ALL_THEMES })) : undefined}>
              {tr("最近公开的文书")}
            </SectionTitle>
            {listing?.items.length ? <PolicyCardList items={listing.items.slice(0, 5)} /> : emptyState}
          </>
        ))}

      {level === 2 &&
        jurisdiction &&
        (errorState ??
          (listing && listing.total === 0 ? (
            <EmptyState title={tr("{name}暂无已公开文书", { name: jurisdictionLabel ?? jurisdiction })}>
              {tr("本站目前没有这里可公开阅读的文书；这不代表当地没有新法规。")}
            </EmptyState>
          ) : (
            <>
              <SectionTitle>{tr("选择经营主题")}</SectionTitle>
              <ThemeCards jurisdiction={jurisdiction} total={listing?.total ?? null} counts={counts} unthemed={unthemed} />
              <p className="mt-2 text-[12px] text-ink-4">{tr("一份文书可能涉及多个主题，各主题篇数相加可能多于全部篇数。")}</p>
              <SectionTitle
                aside={listing && listing.total > listing.items.length ? allLink(listing.total, policiesHref({ jurisdiction, theme: ALL_THEMES })) : undefined}
              >
                {tr("{name}最新文书", { name: jurisdictionLabel ?? jurisdiction })}
              </SectionTitle>
              {listing?.items.length ? <PolicyCardList items={listing.items} /> : emptyState}
            </>
          )))}

      {level === 3 && (
        <>
          {!error && (
            <div className="mt-4 space-y-2.5">
              <ChipRow
                label={tr("文书性质")}
                layoutId="policy-nature"
                active={filters.nature ?? ""}
                items={[
                  { key: "", label: tr("全部"), to: chipHref("nature") },
                  ...Object.entries(natures)
                    .filter(([key]) => key !== "unknown")
                    .map(([key, name]) => ({ key, label: tr.maybe(name), to: chipHref("nature", key) })),
                ]}
              />
              <ChipRow
                label={tr("制定阶段")}
                layoutId="policy-stage"
                active={filters.stage ?? ""}
                items={[
                  { key: "", label: tr("全部"), to: chipHref("stage") },
                  ...Object.entries(stages)
                    .filter(([key]) => key !== "unknown")
                    .map(([key, name]) => ({ key, label: tr.maybe(name), to: chipHref("stage", key) })),
                ]}
              />
              {filters.q && (
                <p className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
                  {tr("搜索：“{q}”", { q: filters.q })}
                  <Link to={chipHref("q")} className="rounded-full border border-line px-2.5 py-0.5 text-[12px] text-accent hover:bg-bg-sunk">
                    {tr("清除搜索")}
                  </Link>
                </p>
              )}
            </div>
          )}
          <AdvancedFilters filters={{ ...filters, theme: themeParam }} scope={scope?.items ?? []} open={!!error || !!(filters.from || filters.to)} />
          {listing && (
            <p className="mt-5 text-[12px] text-ink-4">
              {tr("第")} {listing.page} {tr("页 · 共")} {listing.total} {tr("份文书")}
            </p>
          )}
          {errorState ?? (listing?.items.length ? <PolicyCardList items={listing.items} /> : emptyState)}
          {listing && <Pagination page={listing.page} pageCount={Math.max(1, Math.ceil(listing.total / listing.page_size))} href={pageHref} />}
          {listing && listing.total > listing.page_size && (
            <Form method="get" className="mt-4 flex items-center justify-center gap-2 text-[12px]">
              {Object.entries({ ...filters, theme: themeParam })
                .filter(([k, v]) => k !== "page" && v !== undefined)
                .map(([k, v]) => (
                  <input key={k} type="hidden" name={k} value={String(v)} />
                ))}
              <label>
                {tr("跳到第")}{" "}
                <input
                  name="page"
                  type="number"
                  min={1}
                  max={Math.ceil(listing.total / listing.page_size)}
                  defaultValue={listing.page}
                  className="w-16 rounded-control border border-line bg-surface px-2 py-1"
                />{" "}
                {tr("页")}
              </label>
              <button type="submit" className={actionClass}>
                {tr("跳转")}
              </button>
            </Form>
          )}
        </>
      )}
    </div>
  );
}

/** The former full filter form, folded under “高级筛选” for date ranges and combined conditions. */
function AdvancedFilters({
  filters,
  scope,
  open,
}: {
  filters: Record<string, string | number | undefined>;
  scope: { jurisdiction: { code: string; label: string; kind: string } }[];
  open: boolean;
}) {
  const tr = useTr();
  const text = usePolicyText();
  const select = (key: "theme" | "nature" | "stage", label: string, values: Record<string, string>, all: string, extra: [string, string][] = []) => (
    <label key={key} className="space-y-1 text-[12px] text-ink-3">
      {label}
      <select name={key} defaultValue={String(filters[key] ?? all)} className={fieldClass}>
        <option value={all}>{tr("全部")}</option>
        {[...Object.entries(values).filter(([value]) => value !== "unknown"), ...extra].map(([value, name]) => (
          <option key={value} value={value}>
            {tr.maybe(name)}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <details className="disclosure mt-3" open={open || undefined}>
      <summary className="w-fit py-1 text-[13px] text-ink-3 underline decoration-line-strong underline-offset-4 hover:text-ink">
        {tr("高级筛选（日期范围与组合条件）")}
      </summary>
      <Form key={JSON.stringify(filters)} method="get" className="mt-2 rounded-card border border-line bg-surface p-4" aria-label={tr("法规筛选")}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="space-y-1 text-[12px] text-ink-3">
            {tr("国家与组织")}
            <select name="jurisdiction" defaultValue={String(filters.jurisdiction ?? "")} className={fieldClass}>
              <option value="">{tr("全部国家与组织")}</option>
              {(
                [
                  ["country", tr("目标国家")],
                  ["organization", tr("跨国与国际组织")],
                ] as const
              ).map(([kind, label]) => (
                <optgroup key={kind} label={label}>
                  {scope
                    .filter((i) => i.jurisdiction.kind === kind)
                    .map((i) => (
                      <option key={i.jurisdiction.code} value={i.jurisdiction.code}>
                        {text.place(i.jurisdiction)}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </label>
          {/* “All” is the list of every theme, so a submitted form always lands on the document list. */}
          {select("theme", tr("经营主题"), themes, ALL_THEMES, [[NO_THEME, "未归入主题"]])}
          {select("nature", tr("文书性质"), natures, "")}
          {select("stage", tr("制定阶段"), stages, "")}
          <label className="space-y-1 text-[12px] text-ink-3">
            {tr("开始日期")}
            <input type="date" name="from" defaultValue={filters.from as string | undefined} className={fieldClass} />
          </label>
          <label className="space-y-1 text-[12px] text-ink-3">
            {tr("结束日期")}
            <input type="date" name="to" defaultValue={filters.to as string | undefined} className={fieldClass} />
          </label>
          <label className="space-y-1 text-[12px] text-ink-3 sm:col-span-2">
            {tr("关键词")}
            <div className="flex gap-2">
              <input
                name="q"
                maxLength={120}
                defaultValue={filters.q as string | undefined}
                placeholder={tr("中文名、原文名、文号或机关")}
                className={fieldClass}
              />
              <button className={actionClass} type="submit">
                {tr("筛选")}
              </button>
              <Link to="/policies" className={`${actionClass} whitespace-nowrap`}>
                {tr("重置")}
              </Link>
            </div>
          </label>
        </div>
      </Form>
    </details>
  );
}
