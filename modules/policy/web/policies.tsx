import { apiFetch } from "@amp/web/extension";
import { useTr } from "@amp/web/i18n";
import { Form, Link, data as withHeaders, useLoaderData, useSearchParams } from "react-router";
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
} from "./features/PolicyUI";
import {
  ALL_THEMES,
  Breadcrumb,
  ChipRow,
  JurisdictionCards,
  PolicySearch,
  SectionTitle,
  ThemeCards,
  policiesHref,
  themeKeys,
  type ThemeKey,
} from "./features/PolicyBrowse";

/** Which level of the drill-down an address shows: 1 jurisdictions, 2 themes of one jurisdiction, 3 documents. */
type Level = 1 | 2 | 3;
const LIST_KEYS = ["theme", "q", "nature", "stage", "from", "to", "page"] as const;

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  // `theme=all` is the web's own “every theme, as a list” (level 3 without a theme); the API never sees it.
  const allThemes = url.searchParams.get("theme") === ALL_THEMES;
  const input = Object.fromEntries([...url.searchParams].filter(([key, v]) => key !== "_routes" && v && !(key === "theme" && v === ALL_THEMES)));
  const parsed = PolicyListQuery.safeParse(input);
  const invalid = !parsed.success || [...url.searchParams.keys()].some((k) => url.searchParams.getAll(k).length > 1);
  const level: Level = allThemes || LIST_KEYS.some((k) => k in input) ? 3 : input.jurisdiction ? 2 : 1;
  const empty = { listing: null, scope: null, counts: null, latest: [] as PolicyCard[] };
  if (invalid) return withHeaders({ ...empty, level: 3 as Level, allThemes, filters: { ...PolicyListQuery.parse({}), ...input }, error: 400 }, { status: 400 });
  const query = parsed.data;
  const apiBase = apiBaseFor();
  const options = { headers: { accept: "application/json", "x-amp-ssr": "1" }, signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]) };
  const list = (params: Record<string, unknown>) =>
    apiFetch("/api/site/policies", { ...options, params: { query: PolicyListQuery.parse(params) }, baseUrl: apiBase }).then((r) =>
      contractResult(r, publicSchemas.PolicyListResponse),
    );
  const scopeCall = apiFetch("/api/site/policies/scope", { ...options, baseUrl: apiBase }).then((r) => contractResult(r, publicSchemas.PolicyScopeList));
  // Level 2 counts each theme with the list's own `total` (one-row pages, read in parallel; eight list calls at most).
  // A failed count only hides that number; the jurisdiction's own call doubles as the newest-documents preview.
  const [listing, scope, ...themeTotals] = await Promise.allSettled([
    level === 2 ? list({ jurisdiction: query.jurisdiction, page_size: 3 }) : list(query),
    scopeCall,
    ...(level === 2 ? themeKeys.map((theme) => list({ jurisdiction: query.jurisdiction, theme, page_size: 1 }).then((r) => r.total)) : []),
  ]);
  const counts =
    level === 2 ? Object.fromEntries(themeKeys.map((key, i) => [key, themeTotals[i]?.status === "fulfilled" ? themeTotals[i].value : null])) : null;
  const values = {
    level,
    allThemes,
    listing: listing.status === "fulfilled" ? listing.value : null,
    scope: scope.status === "fulfilled" ? scope.value : null,
    counts: counts as Record<ThemeKey, number | null> | null,
    filters: query,
    error: listing.status === "rejected" ? 503 : null,
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

export default function PoliciesPage() {
  const tr = useTr();
  const { level, allThemes, listing, scope, counts, filters, error } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  usePolicyListReturn();
  usePolicyRecheck();
  const jurisdiction = filters.jurisdiction;
  const jurisdictionLabel = jurisdiction
    ? (scope?.items.find((i) => i.jurisdiction.code === jurisdiction)?.jurisdiction.label ??
      listing?.items.flatMap((p) => p.jurisdictions).find((j) => j.code === jurisdiction)?.label ??
      jurisdiction)
    : null;
  const themeLabel = filters.theme && filters.theme in themes ? tr.maybe(themes[filters.theme as ThemeKey]) : null;
  // Changing a chip keeps the reader on the list (level 3): without a theme the list is “all themes”.
  const listTheme = filters.theme ?? ALL_THEMES;
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
  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-10 pt-5 lg:pt-0" data-policies data-policy-level={level}>
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[24px] font-semibold text-ink">{tr("法规政策动态")}</h1>
          <p className="mt-2 text-[14px] text-ink-3">{tr("先选国家或组织，再选经营主题，逐层找到官方文书、完整中文和原文证据。")}</p>
        </div>
        <PolicySearch q={filters.q} keep={{ jurisdiction, theme: level === 3 ? (filters.theme ?? (allThemes ? ALL_THEMES : undefined)) : undefined }} />
      </header>
      <p className="mt-4 rounded-control border border-line bg-bg-sunk px-4 py-3 text-[13px] leading-relaxed text-ink-2">
        {scope?.updates === "pilot"
          ? tr("法规政策动态试点范围更新中：新文书先提供原文存档与逐条对照，AI 解读暂不更新。已发布内容仍可查阅。")
          : tr("法规政策动态暂时停止更新。已发布内容仍可查阅，恢复时间另行公告。")}{" "}
        <Link to="/changelog" className="text-accent underline underline-offset-2">
          {tr("查看公告")}
        </Link>
      </p>
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
                <p className="mt-1 text-[12.5px] text-ink-4">
                  {tr("篇数为当前可读文书，不代表覆盖完成率。")} {scope.note}
                </p>
                {(
                  [
                    ["country", tr("目标国家")],
                    ["organization", tr("跨国与国际组织")],
                  ] as const
                ).map(([kind, label]) => {
                  const items = scope.items.filter((i) => i.jurisdiction.kind === kind);
                  if (!items.length) return null;
                  const latest = new Map<string, PolicyCard>();
                  for (const policy of listing?.items ?? []) for (const j of policy.jurisdictions) if (!latest.has(j.code)) latest.set(j.code, policy);
                  return (
                    <section key={kind} className="mt-5">
                      <h3 className="text-[13px] font-medium text-ink-3">{label}</h3>
                      <JurisdictionCards items={items} latest={latest} />
                    </section>
                  );
                })}
              </section>
            )}
            <SectionTitle aside={listing && listing.total > 5 ? allLink(listing.total, policiesHref({ theme: ALL_THEMES })) : undefined}>
              {tr("最近公开的文书")}
            </SectionTitle>
            {listing?.items.length ? (
              <div>
                {listing.items.slice(0, 5).map((policy) => (
                  <PolicyCardView key={policy.id} policy={policy} />
                ))}
              </div>
            ) : (
              emptyState
            )}
          </>
        ))}

      {level === 2 &&
        jurisdiction &&
        (errorState ?? (
          <>
            <SectionTitle>{tr("选择经营主题")}</SectionTitle>
            <ThemeCards jurisdiction={jurisdiction} total={listing?.total ?? null} counts={counts} />
            <p className="mt-2 text-[12px] text-ink-4">{tr("一份文书可能涉及多个主题，各主题篇数相加可能多于全部篇数。")}</p>
            <SectionTitle
              aside={listing && listing.total > listing.items.length ? allLink(listing.total, policiesHref({ jurisdiction, theme: ALL_THEMES })) : undefined}
            >
              {tr("{name}最新文书", { name: jurisdictionLabel ?? jurisdiction })}
            </SectionTitle>
            {listing?.items.length ? (
              <div>
                {listing.items.map((policy) => (
                  <PolicyCardView key={policy.id} policy={policy} />
                ))}
              </div>
            ) : (
              emptyState
            )}
          </>
        ))}

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
                  ...Object.entries(natures).map(([key, name]) => ({ key, label: tr.maybe(name), to: chipHref("nature", key) })),
                ]}
              />
              <ChipRow
                label={tr("制定阶段")}
                layoutId="policy-stage"
                active={filters.stage ?? ""}
                items={[
                  { key: "", label: tr("全部"), to: chipHref("stage") },
                  ...Object.entries(stages).map(([key, name]) => ({ key, label: tr.maybe(name), to: chipHref("stage", key) })),
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
          <AdvancedFilters filters={filters} scope={scope?.items ?? []} open={!!error || !!(filters.from || filters.to)} />
          {listing && (
            <p className="mt-5 text-[12px] text-ink-4">
              {tr("第")} {listing.page} {tr("页 · 共")} {listing.total} {tr("份文书")}
            </p>
          )}
          {errorState ??
            (listing?.items.length ? (
              <div>
                {listing.items.map((policy) => (
                  <PolicyCardView key={policy.id} policy={policy} />
                ))}
              </div>
            ) : (
              emptyState
            ))}
          {listing && <Pagination page={listing.page} pageCount={Math.max(1, Math.ceil(listing.total / listing.page_size))} href={pageHref} />}
          {listing && listing.total > listing.page_size && (
            <Form method="get" className="mt-4 flex items-center justify-center gap-2 text-[12px]">
              {Object.entries({ ...filters, theme: filters.theme ?? (allThemes ? ALL_THEMES : undefined) })
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
  const select = (key: "theme" | "nature" | "stage", label: string, values: Record<string, string>, all: string) => (
    <label key={key} className="space-y-1 text-[12px] text-ink-3">
      {label}
      <select name={key} defaultValue={String(filters[key] ?? all)} className={fieldClass}>
        <option value={all}>{tr("全部")}</option>
        {Object.entries(values).map(([value, name]) => (
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
                        {i.jurisdiction.label}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </label>
          {/* “All” is the list of every theme, so a submitted form always lands on the document list. */}
          {select("theme", tr("经营主题"), themes, ALL_THEMES)}
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
