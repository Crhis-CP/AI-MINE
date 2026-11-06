// Layered browsing for the policy list (Owner 2026-11-05): country or organisation → business theme → documents,
// each level a plain link with its state in the address, so every level can be shared and Back returns to it.
// Search stays available but secondary. Places and themes with documents come first as cards; those without any
// are one compact line of names (still links), so an empty catalogue never fills the page with dead tiles.
import { Fragment, type ReactNode } from "react";
import { useTr } from "@amp/web/i18n";
import { Form, IconChevronRight, IconSearch, Link, PillTabs } from "@amp/web/extension";
import type { PolicyCard } from "@amp/contracts/http/public";
import { themes } from "./PolicyUI";
import { policyTitle, usePolicyText } from "./reader";

export type ThemeKey = keyof typeof themes;
export const themeKeys = Object.keys(themes) as ThemeKey[];
/** The web-only value for “every theme, as a list”; it never reaches the API. */
export const ALL_THEMES = "all";
/** The web-only value for “documents not yet given a theme” (themes come with a finished interpretation); never sent to the API. */
export const NO_THEME = "none";

export type ScopeItem = { jurisdiction: { code: string; label: string; kind: string }; readable_count: number };

/** An address on the list page; empty values are dropped and the page always restarts at 1 unless given. */
export function policiesHref(params: Record<string, string | number | undefined | null>) {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") next.set(key, String(value));
  return next.size ? `/policies?${next}` : "/policies";
}

export function Breadcrumb({ items }: { items: { label: string; to?: string }[] }) {
  const tr = useTr();
  return (
    <nav aria-label={tr("位置")} className="mt-5">
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-1 text-[14px]">
        {items.map((item, i) => (
          <li key={item.label} className="flex min-w-0 items-center gap-1">
            {i > 0 && <IconChevronRight size={14} className="shrink-0 text-ink-4" />}
            {item.to ? (
              <Link to={item.to} className="rounded-mark px-1 py-0.5 text-accent hover:bg-bg-sunk">
                {item.label}
              </Link>
            ) : (
              <span aria-current="page" className="px-1 py-0.5 font-semibold text-ink">
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

const cardBase = "flex h-full min-w-0 flex-col rounded-card border p-3.5";
const linkCard = `${cardBase} border-line bg-surface card-hover`;

/** The names that have nothing yet, on one quiet line; each still opens its own page. */
export function EmptyNames({ label, items, testId }: { label: string; items: { key: string; name: string; to?: string }[]; testId: string }) {
  if (!items.length) return null;
  return (
    <p className="mt-3 text-[12.5px] leading-6 text-ink-4" data-empty-list={testId}>
      <span className="mr-1">{label}</span>
      {items.map((item, i) => (
        // A line breaks between names, never inside one.
        <Fragment key={item.key}>
          {i > 0 && <span aria-hidden="true">{" · "}</span>}
          {item.to ? (
            <Link
              to={item.to}
              className="whitespace-nowrap text-ink-3 underline decoration-line-strong underline-offset-2 hover:text-accent"
              data-empty-item={item.key}
            >
              {item.name}
            </Link>
          ) : (
            <span className="whitespace-nowrap" data-empty-item={item.key}>
              {item.name}
            </span>
          )}
        </Fragment>
      ))}
    </p>
  );
}

/** Level 1: the jurisdictions of one group that have documents, as cards, newest document named on each. */
export function JurisdictionCards({ items, latest }: { items: ScopeItem[]; latest: Map<string, PolicyCard> }) {
  const tr = useTr();
  const text = usePolicyText();
  return (
    <ul className="mt-2.5 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
      {items.map(({ jurisdiction, readable_count }) => {
        const recent = latest.get(jurisdiction.code);
        const date = recent ? text.date(recent.sort_time ?? recent.published_time) : null;
        return (
          <li key={jurisdiction.code} className="min-w-0">
            <Link to={policiesHref({ jurisdiction: jurisdiction.code })} className={linkCard} data-jurisdiction-card={jurisdiction.code}>
              <span className="flex min-w-0 items-center gap-2.5">
                <span
                  aria-hidden="true"
                  className="grid h-8 min-w-8 shrink-0 place-items-center rounded-tile bg-accent-softer px-1.5 text-[11px] font-semibold tracking-wide text-accent"
                >
                  {jurisdiction.code.slice(0, 4)}
                </span>
                <span className="min-w-0 truncate text-[15px] font-semibold text-ink">{text.place(jurisdiction)}</span>
              </span>
              <span className="mt-3 text-[13px] text-ink-2">
                <span className="num text-[17px] font-semibold text-ink">{readable_count}</span> {tr("份可读文书")}
              </span>
              {recent && date && (
                <span className="mt-1 block min-w-0 truncate text-[12px] text-ink-4" title={policyTitle(recent).title}>
                  {tr("最近 {date}", { date })}
                  <span className="hidden sm:inline"> · {policyTitle(recent).title}</span>
                </span>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Level 2: “all themes”, the themes that have documents, and the documents no theme has been given yet (themes come
 * with a finished interpretation); themes without documents are one line. Counts are left out when they could not be read.
 */
export function ThemeCards({
  jurisdiction,
  total,
  counts,
  unthemed,
}: {
  jurisdiction: string;
  total: number | null;
  counts: Record<string, number | null> | null;
  unthemed: number | null;
}) {
  const tr = useTr();
  const count = (n: number | null | undefined) =>
    n === null || n === undefined ? null : (
      <span className="mt-3 text-[13px] text-ink-2">
        <span className="num text-[17px] font-semibold text-ink">{n}</span> {tr("份")}
      </span>
    );
  const card = (key: string, label: string, n: number | null | undefined, extra = "") => (
    <li key={key} className="min-w-0">
      <Link to={policiesHref({ jurisdiction, theme: key })} className={`${linkCard} ${extra}`} data-theme-card={key}>
        <span className="flex items-center justify-between gap-2 text-[15px] font-semibold text-ink">
          <span className="min-w-0">{label}</span>
          <IconChevronRight size={16} className="shrink-0 text-ink-4" />
        </span>
        {count(n)}
      </Link>
    </li>
  );
  const filled = themeKeys.filter((key) => counts?.[key] !== 0);
  const empty = themeKeys.filter((key) => counts?.[key] === 0);
  return (
    <>
      <ul className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
        {card(ALL_THEMES, tr("全部主题"), total, "!border-accent/30 !bg-accent-softer")}
        {filled.map((key) => card(key, tr.maybe(themes[key]), counts?.[key]))}
        {!!unthemed && card(NO_THEME, tr("未归入主题"), unthemed)}
      </ul>
      {!!unthemed && <p className="mt-2 text-[12px] text-ink-4">{tr("经营主题随完整解读给出；尚未完成解读的文书先列在“未归入主题”。")}</p>}
      <EmptyNames label={tr("暂无文书的主题：")} testId="themes" items={empty.map((key) => ({ key, name: tr.maybe(themes[key]) }))} />
    </>
  );
}

/** One row of narrowing chips (document type, stage): a label and a sideways-scrolling pill track. */
export function ChipRow({
  label,
  items,
  active,
  layoutId,
}: {
  label: string;
  items: { key: string; label: string; to: string }[];
  active: string;
  layoutId: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="w-16 shrink-0 text-[12.5px] text-ink-3">{label}</span>
      <PillTabs items={items} active={active} layoutId={layoutId} size="sm" label={label} className="min-w-0" />
    </div>
  );
}

/** The secondary search: a box at the top right on desktop, an icon that opens the same box on phones. */
export function PolicySearch({ q, keep }: { q?: string; keep: Record<string, string | undefined> }) {
  const tr = useTr();
  const form = (id: string, extra = "") => (
    <Form method="get" role="search" aria-label={tr("搜索法规")} className={`flex items-center gap-2 ${extra}`}>
      {Object.entries(keep).map(([key, value]) => (value ? <input key={key} type="hidden" name={key} value={value} /> : null))}
      <label htmlFor={id} className="sr-only">
        {tr("搜索法规")}
      </label>
      <span className="relative min-w-0 flex-1">
        <IconSearch size={16} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-4" />
        <input
          id={id}
          type="search"
          name="q"
          maxLength={120}
          defaultValue={q}
          placeholder={tr("中文名、原文名、文号或机关")}
          className="w-full min-w-0 rounded-control border border-line-strong bg-surface py-2 pl-8 pr-3 text-[16px] text-ink sm:text-[13px] focus:outline-accent"
        />
      </span>
      <button type="submit" className="shrink-0 rounded-control bg-accent px-3 py-2 text-[13px] font-medium text-accent-contrast hover:opacity-90">
        {tr("搜索")}
      </button>
    </Form>
  );
  return (
    <>
      <div className="hidden w-[22rem] shrink-0 lg:block">{form("policy-search-wide")}</div>
      <details className="disclosure relative shrink-0 lg:hidden">
        <summary
          aria-label={tr("搜索法规")}
          className="grid size-10 place-items-center rounded-control border border-line-strong bg-surface text-ink-2 hover:text-ink"
        >
          <IconSearch size={18} />
        </summary>
        <div className="absolute right-0 top-full z-20 mt-2 w-[calc(100vw-2rem)] max-w-md rounded-card border border-line bg-surface p-3 shadow-[var(--shadow-pop)]">
          {form("policy-search-narrow")}
        </div>
      </details>
    </>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mt-7 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 className="text-[16px] font-semibold text-ink">{children}</h2>
      {aside}
    </div>
  );
}
