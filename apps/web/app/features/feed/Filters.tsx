import { PhoneBar } from "../../components/shell/PhoneBar";
import { fmt, useCategoryLabel, useLocale, useT, useTr } from "../../i18n";
import { Sheet } from "../../components/ui/Sheet";
import { Wordmark } from "../../components/Logo";
import { SITE } from "@amp/industry/site";
import { useJurisdictionChoices } from "./jurisdictions";
import { useOpenSearch } from "../search/SearchOverlay";
import { addRecentSearch } from "../../lib/local-state";
// Feed filters: the channel and category row, and search.
import { useEffect, useMemo, useRef, useState } from "react";
import { Form, Link, useLocation, useNavigate, useNavigation, useSearchParams } from "react-router";
import { CATEGORY_KEYS, type CategoryKey, type ChannelKey } from "@amp/contracts/taxonomy";
import { IconClose, IconSearch, IconFilter, IconChevronLeft } from "../../components/icons";
import { PillTabs } from "../../components/ui/Tabs";

/** The selector describes event/impact geography; publication-source tags are not an input. */
export function JurisdictionFilter({ base, value, confirm = false }: { base: string; value: string | null; confirm?: boolean }) {
  const tf = useT().feed;
  const [params] = useSearchParams(),
    navigation = useNavigation();
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  const { choices, failed } = useJurisdictionChoices();
  const tr = useTr();
  const english = useLocale() === "en";
  const regionNames = useMemo(() => (english && typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["en"], { type: "region" }) : null), [english]);
  // On a page a choice applies at once; the button stays for readers without scripts, and in the phone
  // sheet (`confirm`), where filters are composed and then applied together.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const live = mounted && !confirm;
  const keep = [...new Set(params.keys())]
    .filter((key) => !["jurisdiction", "page", "cursor", "deep", "anchorAt", "_routes"].includes(key))
    .map((key) => [key, params.get(key)!] as const);
  return (
    <Form method="get" action={base} className="my-3 flex flex-wrap items-center gap-2 text-[14px]">
      {keep.map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}
      <label className="flex items-center gap-2">
        {tf.country}
        <select
          name="jurisdiction"
          value={draft}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            if (live) event.currentTarget.form?.requestSubmit();
          }}
          className="max-w-[220px] rounded-md border border-line-strong bg-surface px-3 py-2 text-ink"
        >
          <option value="">{tf.allCountries}</option>
          {draft && !["unknown", "none"].includes(draft) && !choices?.some((j) => j.code === draft) && <option value={draft}>{tf.currentCountry}</option>}
          {[
            { label: tf.groupCountry, kind: "country" },
            { label: tf.groupSubdivision, kind: "subdivision" },
            { label: tf.groupOrganization, kind: "organization" },
          ].map(({ label, kind }) => (
            <optgroup key={kind} label={label}>
              {(choices ?? [])
                .filter((j) => j.kind === kind)
                .map((j) => (
                  <option key={j.code} value={j.code}>
                    {j.kind === "country" ? (regionNames?.of(j.code) ?? j.label) : tr.maybe(j.label)}（{j.news_count}）
                  </option>
                ))}
            </optgroup>
          ))}
          <optgroup label={tf.groupOther}>
            <option value="unknown">{tf.countryUnknown}</option>
            <option value="none">{tf.countryNone}</option>
          </optgroup>
        </select>
      </label>
      <button
        type="submit"
        disabled={navigation.state === "loading"}
        className={`rounded-md border border-line-strong px-3 py-2 text-ink disabled:opacity-50 ${live ? "hidden" : ""}`}
      >
        {tf.apply}
      </button>
      <span className="text-ink-4">{failed ? tf.countryFailed : choices ? tf.countryHint : tf.countryLoading}</span>
    </Form>
  );
}

/** Same page with some query parameters changed (paging state dropped). */
export function hrefWith(base: string, params: URLSearchParams, patch: Record<string, string | null>) {
  const sp = new URLSearchParams(params);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === "") sp.delete(k);
    else sp.set(k, v);
  }
  sp.delete("page");
  sp.delete("cursor");
  const s = sp.toString();
  return s ? `${base}?${s}` : base;
}

/** Source attributes and subject categories combine through the existing query contract. */
function SourceScopeTabs({ base, channel, layoutId }: { base: string; channel: ChannelKey; layoutId: string }) {
  const tf = useT().feed;
  const [params] = useSearchParams();
  return (
    <PillTabs
      size="sm"
      label={tf.sourceScope}
      layoutId={layoutId}
      active={channel === "firstParty" ? "firstParty" : "all"}
      items={[
        { key: "all", label: tf.allSources, resetScroll: true, to: hrefWith(base, params, { channel: null }) },
        { key: "firstParty", label: tf.firstParty, resetScroll: true, to: hrefWith(base, params, { channel: "firstParty" }) },
      ]}
    />
  );
}

export function CategoryTabs({
  base,
  allTo,
  category,
  channel = "all",
  layoutId,
  size = "md",
  className = "",
}: {
  base: string;
  /** Where “全部” leads when it differs from `base` (the home page while it waits for its first pick). */
  allTo?: string;
  category: CategoryKey | null;
  channel?: ChannelKey;
  layoutId: string;
  size?: "md" | "sm";
  className?: string;
}) {
  const tf = useT().feed;
  const cat = useCategoryLabel();
  const [params] = useSearchParams();
  const items = [
    { key: "all", label: tf.allCategories, resetScroll: true, to: hrefWith(allTo ?? base, params, { category: null }) },
    ...CATEGORY_KEYS.map((k) => ({ key: k, label: cat(k), resetScroll: true, to: hrefWith(base, params, { category: k }) })),
  ];
  return (
    <div className={`min-w-0 space-y-2 ${className}`}>
      <SourceScopeTabs base={base} channel={channel} layoutId={`${layoutId}-source`} />
      <PillTabs items={items} active={category ?? "all"} layoutId={layoutId} label={tf.categoryTabs} size={size} />
    </div>
  );
}

/** The same scope switch and filter sheet on the two news feeds. */
export function FeedBar({
  base,
  category,
  channel,
  jurisdiction,
  facets,
}: {
  base: "/" | "/all";
  category: CategoryKey | null;
  channel: ChannelKey;
  jurisdiction: string | null;
  facets?: { sources: Array<{ id: string; name: string; count: number }>; minerals: string[] };
}) {
  const tf = useT().feed;
  const cat = useCategoryLabel();
  const homeLabel = useT().shell.home;
  const [params] = useSearchParams();
  const location = useLocation();
  const [sheetKey, setSheetKey] = useState<string | null>(null);
  const sheet = sheetKey === location.key;
  const setSheet = (open: boolean) => setSheetKey(open ? location.key : null);
  const search = useOpenSearch();
  const navigate = useNavigate();
  const legacyOpened = useRef(false);
  const query = params.get("q");
  const active = category ?? "all";
  const filtered =
    channel === "firstParty" || active !== "all" || ["jurisdiction", "tag", "source", "mineral", "on", "from", "to"].some((key) => params.get(key));
  useEffect(() => {
    const media = matchMedia("(min-width: 961px)");
    const close = () => {
      if (media.matches) setSheetKey(null);
    };
    media.addEventListener("change", close);
    return () => media.removeEventListener("change", close);
  }, []);
  useEffect(() => {
    if (!legacyOpened.current && params.get("search") === "1" && matchMedia("(max-width: 960px)").matches && search) {
      legacyOpened.current = true;
      search(query ?? "");
    }
  }, [params, search, query]);
  const scope = (to: "/" | "/all") =>
    hrefWith(to, params, {
      q: null,
      tab: null,
      search: null,
      ...(to === "/" ? { source: null, mineral: null, on: null, from: null, to: null, selected: null } : {}),
    });
  const choices = [
    { key: "all", label: tf.anyCategory, to: hrefWith(base, params, { category: null }) },
    ...CATEGORY_KEYS.map((key) => ({ key, label: cat(key), to: hrefWith(base, params, { category: key }) })),
  ];
  const chips = [
    ...(channel === "firstParty" ? [{ key: "channel", label: tf.firstParty, patch: { channel: null } }] : []),
    ...(category ? [{ key: "category", label: cat(category), patch: { category: null } }] : []),
    ...["tag", "jurisdiction", "source", "mineral", "on", "from", "to"].flatMap((key) => {
      const value = params.get(key);
      if (!value) return [];
      const label =
        key === "jurisdiction"
          ? tf.chipRegion
          : key === "source"
            ? tf.chipSource
            : key === "tag"
              ? `#${value}`
              : key === "from"
                ? fmt(tf.chipFrom, { value })
                : key === "to"
                  ? fmt(tf.chipTo, { value })
                  : value;
      return [{ key, label, patch: { [key]: null } }];
    }),
  ];
  return (
    <>
      <PhoneBar
        leading={
          query ? (
            <Link
              to={hrefWith("/all", params, { q: null, tab: null, search: null })}
              onClick={(event) => {
                if (
                  event.button === 0 &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.altKey &&
                  !event.shiftKey &&
                  typeof history.state?.idx === "number" &&
                  history.state.idx > 0
                ) {
                  event.preventDefault();
                  navigate(-1);
                }
              }}
              aria-label={tf.backToFeed}
              className="flex min-h-11 items-center px-1 text-[16px] text-accent"
            >
              <IconChevronLeft size={23} />
              {tf.back}
            </Link>
          ) : (
            <Link to="/" aria-label={`${SITE.name} ${homeLabel}`} className="flex h-11 items-center px-2.5">
              <Wordmark size={17} />
            </Link>
          )
        }
        center={
          query ? (
            <button
              type="button"
              aria-label={fmt(tf.editSearch, { query })}
              className="flex h-9 min-w-0 items-center gap-2 rounded-full bg-bg-sunk px-3 text-left text-[15px]"
              onClick={(event) => search?.(query, event.currentTarget)}
            >
              <IconSearch size={16} className="shrink-0" />
              <span className="truncate">{query}</span>
            </button>
          ) : (
            <PillTabs
              size="sm"
              layoutId="feed-scope"
              label={tf.scope}
              active={base === "/" ? "featured" : "all"}
              items={[
                { key: "featured", label: tf.picks, to: scope("/") },
                { key: "all", label: tf.all, to: scope("/all") },
              ]}
            />
          )
        }
        actions={
          <>
            <button
              type="button"
              aria-label={filtered ? tf.filterActive : tf.filter}
              aria-expanded={sheet}
              onClick={() => setSheet(true)}
              className={`relative grid size-11 shrink-0 place-items-center rounded-full transition-colors active:bg-bg-sunk ${filtered ? "text-accent" : "text-ink-2"}`}
            >
              <IconFilter size={21} />
              {filtered && <span aria-hidden="true" className="absolute right-2 top-2 size-1.5 rounded-full bg-accent" />}
            </button>
            {!query && <SearchIconLink />}
          </>
        }
      />
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-2 py-2 lg:hidden">
          {chips.map((chip) => (
            <Link
              key={chip.key}
              aria-label={fmt(tf.clearFilter, { label: chip.label })}
              to={hrefWith(base, params, chip.patch)}
              className="inline-flex min-h-10 max-w-full items-center gap-1 rounded-full bg-accent-soft px-3 text-[14px] text-accent"
            >
              <span className="truncate">{chip.label}</span>
              <IconClose size={14} />
            </Link>
          ))}
        </div>
      )}
      <Sheet open={sheet} onClose={() => setSheet(false)} title={tf.filter}>
        {sheet && (
          <>
            <SourceScopeTabs base={base} channel={channel} layoutId="phone-source-scope" />
            <JurisdictionFilter base={base} value={jurisdiction} confirm />
            {base === "/all" ? (
              <SourceDateFilters base="/all" facets={facets} />
            ) : (
              <Link to={scope("/all")} className="block py-3 text-[14px] text-accent">
                {tf.moreFilters}
              </Link>
            )}
            <ul className="divide-y divide-line-soft">
              {choices.map((choice) => (
                <li key={choice.key}>
                  <Link
                    to={choice.to}
                    onClick={() => setSheet(false)}
                    aria-current={active === choice.key ? "true" : undefined}
                    className={`flex min-h-11 items-center justify-between rounded-tile px-2 text-[16px] active:bg-bg-sunk ${active === choice.key ? "font-semibold text-accent" : "text-ink-2"}`}
                  >
                    {choice.label}
                    {active === choice.key && <span aria-hidden="true">✓</span>}
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </Sheet>
    </>
  );
}

function useSlashFocus(ref: React.RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement)?.isContentEditable)) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ref]);
}

/**
 * Search field (GET /all?q=…). Desktop ("track"): at the end of the filter row as the same grey track,
 * at the height of md tabs, with a "/" hint. Phones ("bar"): full width with a separate 搜索 button.
 */
export function SearchField({
  action = "/all",
  defaultValue = "",
  keep = {},
  variant = "track",
  autoFocus = false,
}: {
  action?: string;
  defaultValue?: string;
  keep?: Record<string, string | null>;
  variant?: "track" | "bar";
  autoFocus?: boolean;
}) {
  const tf = useT().feed;
  const [value, setValue] = useState(defaultValue);
  const navigation = useNavigation();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => setValue(defaultValue), [defaultValue]);
  useSlashFocus(inputRef);
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);
  const searching = navigation.state === "loading" && navigation.location?.pathname === action && !!new URLSearchParams(navigation.location.search).get("q");
  const hidden = Object.entries(keep).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null));

  if (variant === "bar") {
    return (
      <Form
        onSubmit={() => {
          if (action === "/all") addRecentSearch(value);
        }}
        method="get"
        action={action}
        role="search"
        className="flex gap-2"
      >
        {hidden}
        <label className="relative flex-1">
          <span className="sr-only">{tf.searchAll}</span>
          <IconSearch size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-4" />
          <input
            ref={inputRef}
            name="q"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={tf.searchPlaceholder}
            maxLength={200}
            autoComplete="off"
            enterKeyHint="search"
            className="h-11 w-full rounded-full border border-line-strong bg-surface pl-10 pr-9 text-[16px] lg:text-[16px] text-ink outline-none transition-[border-color,box-shadow] placeholder:text-ink-4 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
          />
          {value && (
            <button
              type="button"
              aria-label={tf.clear}
              onClick={() => {
                setValue("");
                inputRef.current?.focus();
              }}
              className="absolute right-2.5 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-full text-ink-4"
            >
              <IconClose size={15} />
            </button>
          )}
        </label>
        <button
          type="submit"
          className={`h-11 shrink-0 rounded-full bg-accent px-5 text-[15.5px] font-semibold text-accent-contrast transition-[background-color,transform] active:scale-[0.98] ${searching ? "opacity-60" : ""}`}
        >
          {tf.search}
        </button>
      </Form>
    );
  }

  return (
    <Form
      onSubmit={() => {
        if (action === "/all") addRecentSearch(value);
      }}
      method="get"
      action={action}
      role="search"
      className="group relative w-full shrink-0 lg:w-60"
    >
      {hidden}
      <label htmlFor="site-search" className="sr-only">
        {tf.searchAll}
      </label>
      <IconSearch
        size={16}
        className={`pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 transition-colors ${searching ? "text-accent" : "text-ink-4 group-focus-within:text-ink-3"}`}
      />
      <input
        ref={inputRef}
        id="site-search"
        name="q"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={tf.searchPlaceholder}
        maxLength={200}
        autoComplete="off"
        className="h-[42px] w-full rounded-full bg-bg-sunk pl-10 pr-10 text-[15px] text-ink outline-none ring-1 ring-inset ring-line-soft transition-[background-color,box-shadow] placeholder:text-ink-4 hover:ring-line-strong focus:bg-surface focus:shadow-[0_0_0_3px_var(--accent-soft)] focus:ring-accent dark:bg-bg-muted/60 dark:focus:bg-surface"
      />
      {value ? (
        <button
          type="button"
          aria-label={tf.clear}
          onClick={() => {
            setValue("");
            inputRef.current?.focus();
          }}
          className="absolute right-3 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-full text-ink-4 transition-colors hover:bg-bg-sunk hover:text-ink"
        >
          <IconClose size={13} />
        </button>
      ) : (
        <kbd className="mono pointer-events-none absolute right-4 top-1/2 hidden -translate-y-1/2 rounded-mark border border-line-strong bg-surface px-1.5 text-[11.5px] leading-4 text-ink-4 lg:block">
          /
        </kbd>
      )}
    </Form>
  );
}

/** Mobile home: the search icon at the end of the category row opens search on 全部动态. */
export function SearchIconLink() {
  const tf = useT().feed;
  const [params] = useSearchParams();
  const openSearch = useOpenSearch();
  return (
    <Link
      to={hrefWith("/all", params, { search: "1" })}
      onClick={(event) => {
        if (openSearch && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
          event.preventDefault();
          openSearch(params.get("q") ?? "", event.currentTarget);
        }
      }}
      aria-label={tf.search}
      className="flex size-11 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-bg-sunk hover:text-ink"
    >
      <IconSearch size={19} />
    </Link>
  );
}

/** Shareable source, mineral and calendar-day conditions; submitting resets only pagination. */
export function SourceDateFilters({
  base,
  facets,
}: {
  base: string;
  facets?: { sources: Array<{ id: string; name: string; count: number }>; minerals: string[] };
}) {
  const tf = useT().feed;
  const [params] = useSearchParams();
  const controls = ["source", "mineral", "on", "from", "to"];
  const field = "min-w-0 rounded-control border border-line-strong bg-surface px-2 py-2 text-[16px] text-ink sm:text-[14px]";
  return (
    <details className="my-3 rounded-control border border-line px-3 py-2" open={controls.some((name) => params.get(name)) || undefined}>
      <summary className="cursor-pointer text-[14px] text-ink-3">{tf.advancedFilters}</summary>
      <Form key={params.toString()} method="get" action={base} className="mt-3 flex flex-wrap items-end gap-3" aria-label={tf.comboLabel}>
        {[...params]
          .filter(([name]) => ![...controls, "page", "cursor", "_routes"].includes(name))
          .map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
        <label className="flex max-w-full flex-col gap-1 text-[13px] text-ink-3">
          {tf.source}
          <select name="source" defaultValue={params.get("source") ?? ""} className={field}>
            <option value="">{tf.allSources}</option>
            {params.get("source") && !facets?.sources.some((source) => source.id === params.get("source")) && (
              <option value={params.get("source")!}>{tf.currentSourceNoMatch}</option>
            )}
            {facets?.sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}（{source.count}）
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[13px] text-ink-3">
          {tf.commodity}
          <select name="mineral" defaultValue={params.get("mineral") ?? ""} className={field}>
            <option value="">{tf.allCommodities}</option>
            {params.get("mineral") && !facets?.minerals.includes(params.get("mineral")!) && (
              <option value={params.get("mineral")!}>{params.get("mineral")}</option>
            )}
            {facets?.minerals.map((mineral) => (
              <option key={mineral} value={mineral}>
                {mineral}
              </option>
            ))}
          </select>
        </label>
        {[
          ["on", tf.dateOn],
          ["from", tf.dateFrom],
          ["to", tf.dateTo],
        ].map(([name, label]) => (
          <label key={name} className="flex flex-col gap-1 text-[13px] text-ink-3">
            {label}
            <input type="date" name={name} defaultValue={params.get(name!) ?? ""} className={field} />
          </label>
        ))}
        <button type="submit" className={`${field} text-accent`}>
          {tf.applyFilters}
        </button>
        <Link to={hrefWith(base, params, { source: null, mineral: null, on: null, from: null, to: null })} className="py-2 text-[14px] text-ink-3">
          {tf.clearThese}
        </Link>
        <p className="w-full text-[13px] text-ink-4">{tf.dateHelp}</p>
      </Form>
    </details>
  );
}
