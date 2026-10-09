// Feed filters: the channel and category row, and search.
import { useEffect, useRef, useState } from "react";
import { Form, Link, useNavigation, useSearchParams } from "react-router";
import { CATEGORY_KEYS, type CategoryKey, type ChannelKey } from "@amp/contracts/taxonomy";
import { CATEGORY_LABELS, CHANNEL_LABELS } from "@amp/industry/taxonomy";
import { IconClose, IconSearch } from "../../components/icons";
import { PillTabs } from "../../components/ui/Tabs";
import { createPublicClient, publicSchemas } from "@amp/api-client/public";

/** The selector describes event/impact geography; publication-source tags are not an input. */
export function JurisdictionFilter({ base, value }: { base: string; value: string | null }) {
  const [params] = useSearchParams(),
    navigation = useNavigation();
  const [choices, setChoices] = useState<{ code: string; label: string; kind: string; news_count: number }[] | null>(null),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    createPublicClient({ baseUrl: window.location.origin })
      .GET("/api/site/jurisdictions", { signal: controller.signal })
      .then((response) => {
        if (!response.response.ok) throw new Error("jurisdictions unavailable");
        if (!controller.signal.aborted) setChoices(publicSchemas.PolicyJurisdictionList.parse(response.data));
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, []);
  const keep = [...new Set(params.keys())]
    .filter((key) => !["jurisdiction", "page", "cursor", "deep", "anchorAt", "_routes"].includes(key))
    .map((key) => [key, params.get(key)!] as const);
  return (
    <Form method="get" action={base} className="my-3 flex flex-wrap items-center gap-2 text-[13px]">
      {keep.map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}
      <label className="flex items-center gap-2">
        国家 / 地区
        <select
          name="jurisdiction"
          defaultValue={value ?? ""}
          key={`${value ?? "all"}:${choices ? "ready" : "loading"}`}
          className="max-w-[220px] rounded-md border border-line-strong bg-surface px-3 py-2 text-ink"
        >
          <option value="">全部国家 / 地区</option>
          {value && !["unknown", "none"].includes(value) && !choices?.some((j) => j.code === value) && <option value={value}>当前国家条件</option>}
          {[
            { label: "国家", kind: "country" },
            { label: "中国省区", kind: "subdivision" },
            { label: "国际组织", kind: "organization" },
          ].map(({ label, kind }) => (
            <optgroup key={kind} label={label}>
              {(choices ?? [])
                .filter((j) => j.kind === kind)
                .map((j) => (
                  <option key={j.code} value={j.code}>
                    {j.label}（{j.news_count}）
                  </option>
                ))}
            </optgroup>
          ))}
          <optgroup label="其他归属">
            <option value="unknown">国家尚未完全确定</option>
            <option value="none">未限定国家</option>
          </optgroup>
        </select>
      </label>
      <button type="submit" disabled={navigation.state === "loading"} className="rounded-md border border-line-strong px-3 py-2 text-ink disabled:opacity-50">
        筛选
      </button>
      <span className="text-ink-4">
        {failed ? "国家选项暂时不可用，当前筛选仍保留。" : choices ? "按事件或影响地区 · 数字为已识别资讯数" : "正在读取国家选项…"}
      </span>
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

/**
 * The feed's one filter row (精选 and 全部动态 alike): 全部, 一手, then the categories. One choice at a
 * time: picking 一手 clears the category and picking a category clears 一手. Older 资讯 / X links
 * still filter; the row then shows 全部.
 */
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
  const [params] = useSearchParams();
  const items = [
    { key: "all", label: "全部", to: allTo ?? hrefWith(base, params, { category: null, channel: null }) },
    { key: "firstParty", label: CHANNEL_LABELS.firstParty, to: hrefWith(base, params, { category: null, channel: "firstParty" }) },
    ...CATEGORY_KEYS.map((k) => ({ key: k, label: CATEGORY_LABELS[k], to: hrefWith(base, params, { category: k, channel: null }) })),
  ];
  const active = channel === "firstParty" ? "firstParty" : (category ?? "all");
  return <PillTabs items={items} active={active} layoutId={layoutId} label="筛选" size={size} className={className} />;
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
      <Form method="get" action={action} role="search" className="flex gap-2">
        {hidden}
        <label className="relative flex-1">
          <span className="sr-only">搜索标题、摘要与正文</span>
          <IconSearch size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-4" />
          <input
            ref={inputRef}
            name="q"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="搜索标题、摘要…"
            maxLength={200}
            autoComplete="off"
            enterKeyHint="search"
            className="h-11 w-full rounded-full border border-line-strong bg-surface pl-10 pr-9 text-[15px] text-ink outline-none transition-[border-color,box-shadow] placeholder:text-ink-4 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
          />
          {value && (
            <button
              type="button"
              aria-label="清空"
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
          className={`h-11 shrink-0 rounded-full bg-accent px-5 text-[14.5px] font-semibold text-accent-contrast transition-[background-color,transform] active:scale-[0.98] ${searching ? "opacity-60" : ""}`}
        >
          搜索
        </button>
      </Form>
    );
  }

  return (
    <Form method="get" action={action} role="search" className="group relative w-full shrink-0 lg:w-60">
      {hidden}
      <label htmlFor="site-search" className="sr-only">
        搜索标题、摘要与正文
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
        placeholder="搜索标题、摘要…"
        maxLength={200}
        autoComplete="off"
        className="h-[42px] w-full rounded-full bg-bg-sunk pl-10 pr-10 text-[14px] text-ink outline-none ring-1 ring-inset ring-line-soft transition-[background-color,box-shadow] placeholder:text-ink-4 hover:ring-line-strong focus:bg-surface focus:shadow-[0_0_0_3px_var(--accent-soft)] focus:ring-accent dark:bg-bg-muted/60 dark:focus:bg-surface"
      />
      {value ? (
        <button
          type="button"
          aria-label="清空"
          onClick={() => {
            setValue("");
            inputRef.current?.focus();
          }}
          className="absolute right-3 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-full text-ink-4 transition-colors hover:bg-bg-sunk hover:text-ink"
        >
          <IconClose size={13} />
        </button>
      ) : (
        <kbd className="mono pointer-events-none absolute right-4 top-1/2 hidden -translate-y-1/2 rounded-mark border border-line-strong bg-surface px-1.5 text-[10.5px] leading-4 text-ink-4 lg:block">
          /
        </kbd>
      )}
    </Form>
  );
}

/** Mobile home: the search icon at the end of the category row opens search on 全部动态. */
export function SearchIconLink() {
  const [params] = useSearchParams();
  return (
    <Link
      to={hrefWith("/all", params, { search: "1" })}
      aria-label="搜索"
      className="flex size-9 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-bg-sunk hover:text-ink"
    >
      <IconSearch size={19} />
    </Link>
  );
}
