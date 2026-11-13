import { apiFetch, IconChevronDown, IconExternal, Link, pageMeta } from "@amp/web/extension";
import { type Phrase, useLocale, useTr } from "@amp/web/i18n";
import { useEffect, useState, type ReactNode } from "react";
import { data as withHeaders, useLoaderData } from "react-router";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { schemas as publicSchemas, type MetalPrices } from "@amp/contracts/http/public";
import { apiBaseFor, contractResult } from "@amp/web/extension.server";
import {
  changeText,
  headlineIndex,
  isBehind,
  isHeld,
  licenceNotes,
  noteParts,
  priceText,
  shortLabel,
  tagOf,
  trendPoints,
  trendRanges,
  trendScale,
  trendStepped,
  trendWindow,
  type TrendRange,
  type Metal,
  type Note,
  type Quote,
  type Source,
} from "./quotes.ts";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const prices = await apiFetch("/api/site/metal-prices", {
      headers: { accept: "application/json", "x-amp-ssr": "1" },
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
      baseUrl: apiBaseFor(),
    }).then((response) => contractResult(response, publicSchemas.MetalPrices));
    return withHeaders({ prices }, { headers: { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" } });
  } catch (error) {
    if (request.signal.aborted) throw error;
    return withHeaders({ prices: null }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
export const headers: HeadersFunction = ({ loaderHeaders }) => loaderHeaders;
export function meta() {
  return pageMeta({
    title: "金属价格",
    description: "官方机构定期发布的金属价格，注明出处。",
    descriptionEn: "Metal prices published regularly by official bodies, each with its source.",
    path: "/metals",
  });
}

/** The frequency mark (日, 周, 旬, 月) in front of a quote or a source. */
const Tag = ({ value }: { value: string }) => (
  <span className="mr-1 inline-grid h-4 min-w-4 place-items-center rounded-mark bg-bg-muted px-1 align-[1px] text-[10px] font-medium leading-none text-ink-3">
    {value}
  </span>
);
function NewWindow() {
  const tr = useTr();
  return <span className="sr-only">{tr("（在新窗口打开）")}</span>;
}
function External({ href, title, children, className = "" }: { href: string; title?: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" title={title} className={`text-accent hover:underline ${className}`}>
      {children}
      <NewWindow />
    </a>
  );
}
function NoteText({ note }: { note: Note }) {
  const [before, after] = noteParts(note);
  return (
    <>
      {before}
      {note.link && (
        <External href={note.link.url} className="underline underline-offset-2">
          {note.link.name}
        </External>
      )}
      {after}
    </>
  );
}

/** Links a source's numbers carry: its licence note and the linked footnotes of its quotes (the data page to cite). */
function sourceLinks(prices: MetalPrices, source: Source) {
  const refs = new Set(prices.metals.flatMap((metal) => metal.quotes.filter((q) => q.source === source.key).map((q) => q.footnote)));
  const notes = [...licenceNotes(prices.notes, source), ...prices.notes.filter((note) => note.ref !== null && refs.has(note.ref) && note.link)];
  return [...new Map(notes.map((note) => [note.link!.url, note.link!])).values()].filter((link) => link.name !== source.name);
}

function Price({ quote, lead = false }: { quote: Quote; lead?: boolean }) {
  const tr = useTr();
  const size = lead ? "text-[22px] leading-7 sm:text-[26px] sm:leading-8" : "text-[14px] leading-5";
  return (
    <span className={lead ? "block" : "whitespace-nowrap"}>
      <span className={`mono tabular-nums tracking-[-0.01em] ${size} ${quote.value === null ? "font-medium text-ink-4" : "font-semibold text-ink"}`}>
        {quote.value === null ? tr("暂缺") : priceText(quote.value, quote.decimals)}
      </span>
      <span className={`text-ink-4 ${lead ? "mt-0.5 block text-[11.5px]" : "ml-1 text-[11px]"}`}>{quote.unit}</span>
    </span>
  );
}

/** Converted units with their own wording, so English reads “≈ US$13,624/t” rather than the Chinese unit. */
const APPROX: Record<string, Phrase> = { "美元/吨": "约 {value} 美元/吨" };

/**
 * The published price in another currency, under it (TASK-0572): “约 13,624 美元/吨（按10月30日人民币汇率中间价折算）”.
 * The rate's date is the one the API used (the quote's period end or the latest day before); none, nothing is shown.
 */
function Converted({ prices, quote, lead = false }: { prices: MetalPrices; quote: Quote; lead?: boolean }) {
  const tr = useTr();
  const english = useLocale() === "en";
  const converted = quote.converted;
  if (!converted || quote.value === null) return null;
  const value = priceText(converted.value, null);
  const phrase = APPROX[converted.unit];
  const date = english ? converted.rate.date : shortLabel(prices, converted.rate.label);
  return (
    <span data-converted="" className={`block leading-[1.5] text-ink-3 ${lead ? "mt-1 text-[12.5px]" : "mt-0.5 text-[12px]"}`}>
      <span className="tabular-nums">{phrase ? tr(phrase, { value }) : tr("约 {value} {unit}", { value, unit: tr.maybe(converted.unit) })}</span>
      {english ? " " : ""}
      <span className="text-[11px] text-ink-4">{tr("（按{date}{name}折算）", { date, name: tr.maybe(converted.rate.name) })}</span>
    </span>
  );
}

/** The site's colours for price moves: red up, green down (as the notes say), grey flat. */
const TONE = { up: "bg-hot-soft text-hot", down: "bg-ok-soft text-ok", flat: "bg-bg-sunk text-ink-3" } as const;
function Change({ prices, quote }: { prices: MetalPrices; quote: Quote }) {
  const tr = useTr();
  if (!quote.change) {
    return quote.value === null ? null : (
      <span className="text-[11px] text-ink-4" title={tr("缺少可比的上一期报价，暂不显示涨跌")}>
        {tr("暂无可比上期")}
      </span>
    );
  }
  const { text, direction } = changeText(quote.change.percent);
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      <span className={`mono rounded-full px-1.5 py-px text-[12px] font-medium tabular-nums ${TONE[direction]}`}>{text}</span>
      <span className="text-[11px] text-ink-4" title={tr("按各报价所示的实际基期比较，可能跨越停发期")}>
        {tr("对比")} {shortLabel(prices, quote.change.previous.period.label)}
      </span>
    </span>
  );
}

function Period({ prices, metal, quote }: { prices: MetalPrices; metal: Metal; quote: Quote }) {
  const tr = useTr();
  return (
    <span className="inline-flex items-center whitespace-nowrap text-[11.5px] text-ink-3">
      <Tag value={tagOf(prices, quote)} />
      {quote.period ? shortLabel(prices, quote.period.label) : tr("暂缺")}
      {isBehind(prices, metal, quote) && <span className="ml-1 text-amber-ink">{tr("较早期数据")}</span>}
      {isHeld(prices, quote) && (
        <span className="ml-1 text-amber-ink" title={tr("新一期报价较上一期变动超出常规范围，暂显示上一期已核对的数值，下一期公布后自动确认或更正")}>
          {tr("待下期确认")}
        </span>
      )}
    </span>
  );
}

/** Where a quote comes from: the source (linked to its latest release), its licence, the spec and the footnote. */
function QuoteInfo({ prices, quote }: { prices: MetalPrices; quote: Quote }) {
  const tr = useTr();
  const source = prices.sources.find((candidate) => candidate.key === quote.source)!;
  const footnote = quote.footnote === null ? undefined : prices.notes.find((note) => note.ref === quote.footnote);
  return (
    <div className="mt-1 space-y-0.5 text-[11.5px] leading-[1.6] text-ink-4">
      <p>
        {tr("来源")}
        {tr("：")}
        {source.latest ? (
          <External href={source.latest.release.url} title={source.latest.release.label}>
            {source.name}
          </External>
        ) : (
          source.name
        )}
        {licenceNotes(prices.notes, source).map((note) => (
          <span key={note.link!.url}>
            {" · "}
            {tr("许可")} <External href={note.link!.url}>{note.link!.name}</External>
          </span>
        ))}
      </p>
      {quote.spec && <p>{quote.spec}</p>}
      {footnote && (
        <p>
          <NoteText note={footnote} />
        </p>
      )}
    </div>
  );
}

/**
 * How the quote's price moved (TASK-0627, a reader's suggestion taken up by the Owner 2026-11-12): one point per
 * published period, read from what the site has stored, never interpolated. Daily prices are a line; ten-day and
 * monthly ones are steps. The point under the pointer shows its period and price. Red when the range ends higher
 * than it began, green when lower, as the change badge does.
 */
function Trend({ prices, quote }: { prices: MetalPrices; quote: Quote }) {
  const tr = useTr();
  const all = trendPoints(quote);
  const ranges = trendRanges(all);
  const [range, setRange] = useState<TrendRange | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  if (!ranges.length) return null;
  const current = ranges.find((r) => r.key === range) ?? ranges[0]!;
  const points = trendWindow(all, current.days);
  const W = 320,
    H = 96,
    top = 8,
    bottom = 6;
  const { min, max } = trendScale(points.map((p) => p.value));
  const x = (i: number) => (points.length === 1 ? W / 2 : 2 + ((W - 4) * i) / (points.length - 1)),
    y = (value: number) => top + (H - top - bottom) * (1 - (value - min) / (max - min));
  const stepped = trendStepped(points);
  let path = `M${x(0)},${y(points[0]!.value)}`;
  for (let i = 1; i < points.length; i++) path += stepped ? ` H${x(i)} V${y(points[i]!.value)}` : ` L${x(i)},${y(points[i]!.value)}`;
  const first = points[0]!,
    last = points.at(-1)!,
    direction = last.value > first.value ? "up" : last.value < first.value ? "down" : "flat",
    stroke = direction === "up" ? "var(--hot)" : direction === "down" ? "var(--ok)" : "var(--ink-3)";
  const at = hover === null ? null : points[Math.max(0, Math.min(points.length - 1, hover))]!;
  const shown = at ?? last;
  const id = `trend-${quote.key.replace(/[^a-z0-9]/gi, "-")}`;
  return (
    <figure className="mt-2.5" data-trend={quote.key}>
      <figcaption className="flex items-center justify-between gap-2 text-[11px] text-ink-4">
        <span className="min-w-0 truncate" aria-live="polite">
          {shortLabel(prices, shown.label)} <span className="mono tabular-nums text-ink-2">{priceText(String(shown.value), quote.decimals)}</span>
        </span>
        {ranges.length > 1 && (
          <span className="flex shrink-0 gap-0.5 rounded-full bg-bg-sunk p-0.5">
            {ranges.map((r) => (
              <button
                key={r.key}
                type="button"
                aria-pressed={r.key === current.key}
                onClick={() => {
                  setRange(r.key);
                  setHover(null);
                }}
                className={`rounded-full px-2 py-px ${r.key === current.key ? "bg-surface font-medium text-ink shadow-sm" : "text-ink-3"}`}
              >
                {tr.maybe(r.label)}
              </button>
            ))}
          </span>
        )}
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-1 block h-auto w-full touch-pan-y overflow-visible"
        role="img"
        aria-label={tr("{metal}价格走势：{from} 至 {to}，共 {count} 期", {
          metal: quote.title,
          from: shortLabel(prices, first.label),
          to: shortLabel(prices, last.label),
          count: points.length,
        })}
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setHover(Math.round((((event.clientX - box.left) / box.width) * W - 2) / ((W - 4) / Math.max(1, points.length - 1))));
        }}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={stroke} stopOpacity={0.16} />
            <stop offset="1" stopColor={stroke} stopOpacity={0} />
          </linearGradient>
        </defs>
        <path d={`${path} V${H} H${x(0)}Z`} fill={`url(#${id})`} />
        <path d={path} fill="none" stroke={stroke} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
        {points.length <= 12 && points.map((p, i) => <circle key={p.start} cx={x(i)} cy={y(p.value)} r={1.75} fill={stroke} />)}
        <circle cx={x(points.length - 1)} cy={y(last.value)} r={3.25} fill={stroke} stroke="var(--surface)" strokeWidth={1.75} />
        {at && (
          <>
            <line x1={x(points.indexOf(at))} x2={x(points.indexOf(at))} y1={top - 4} y2={H} stroke="var(--ink-4)" strokeWidth={1} />
            <circle cx={x(points.indexOf(at))} cy={y(at.value)} r={3.5} fill="var(--surface)" stroke={stroke} strokeWidth={1.75} />
          </>
        )}
      </svg>
      <p className="mt-0.5 flex justify-between text-[10.5px] text-ink-4">
        <span>{shortLabel(prices, first.label)}</span>
        <span>
          {stepped ? tr("每期一个价") : tr("每次公布一个价")} · {tr("{count} 期", { count: points.length })}
        </span>
      </p>
    </figure>
  );
}

function MetalCard({ prices, metal }: { prices: MetalPrices; metal: Metal }) {
  const tr = useTr();
  const lead = headlineIndex(prices, metal);
  const quote = metal.quotes[lead]!;
  const others = metal.quotes.filter((_, index) => index !== lead);
  return (
    // On phones an opened card takes the whole row, so its other quotes are not squeezed into half the width.
    <li data-metal={metal.key} className="card flex min-w-0 flex-col p-3.5 max-md:has-[details[open]]:col-span-full sm:p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <h2 className="text-[16px] font-semibold leading-6 text-ink">{metal.name}</h2>
        <Period prices={prices} metal={metal} quote={quote} />
      </div>
      <p className="text-[12px] leading-[18px] text-ink-3">{quote.title}</p>
      <div className="mt-2.5">
        <Price quote={quote} lead />
        <Converted prices={prices} quote={quote} lead />
      </div>
      <div className="mt-1.5 min-h-5">
        <Change prices={prices} quote={quote} />
      </div>
      <Trend prices={prices} quote={quote} />
      <details className="disclosure group/quotes mt-auto pt-3">
        <summary className="flex items-center gap-1 border-t border-line-soft pt-2.5 text-[12px] text-ink-3 transition-colors hover:text-ink">
          <span>{others.length ? tr("另有 {count} 个报价", { count: others.length }) : tr("来源与规格")}</span>
          <span aria-hidden="true" className="text-ink-4">
            ·
          </span>
          <span className="font-medium text-accent group-open/quotes:hidden">{tr("展开")}</span>
          <span className="hidden font-medium text-accent group-open/quotes:inline">{tr("收起")}</span>
          <IconChevronDown size={13} className="ml-auto text-ink-4 transition-transform duration-200 group-open/quotes:rotate-180" />
        </summary>
        <div className="pt-2">
          <QuoteInfo prices={prices} quote={quote} />
          {others.length > 0 && (
            <ul className="mt-2.5 space-y-2">
              {others.map((other) => (
                <li key={other.key} className="rounded-control bg-bg-sunk px-2.5 py-2">
                  <p className="text-[12.5px] leading-[18px] text-ink-2">{other.title}</p>
                  <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                    <Price quote={other} />
                    <Period prices={prices} metal={metal} quote={other} />
                  </div>
                  <Converted prices={prices} quote={other} />
                  <div className="mt-1">
                    <Change prices={prices} quote={other} />
                  </div>
                  <QuoteInfo prices={prices} quote={other} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </li>
  );
}

function LatestLine({ prices }: { prices: MetalPrices }) {
  const tr = useTr();
  return (
    <section
      aria-label={tr("最新一期")}
      className="well mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-control px-3 py-2 text-[12px] leading-5 text-ink-3"
    >
      <span className="font-medium text-ink-4">{tr("最新一期")}</span>
      {prices.latest.map((period) => (
        <span key={period.tag} className="inline-block">
          <Tag value={period.tag} />
          {period.label ?? tr("暂无可显示的报价")}
          {period.stale && <span className="ml-1 text-amber-ink">{tr("较早期数据")}</span>}
          {period.extras.map((extra) => (
            <span key={extra.label} className="text-ink-4">
              {tr("（{value}）", { value: `${extra.metals.join(tr("、"))} ${extra.label}${extra.stale ? tr(" 较早期数据") : ""}` })}
            </span>
          ))}
        </span>
      ))}
    </section>
  );
}

function OfficialLinks({ links }: { links: MetalPrices["officialLinks"] }) {
  const tr = useTr();
  if (!links.length) return null;
  return (
    <div className="mt-5">
      <h3 id="metals-official-links" className="text-[13px] font-semibold text-ink-2">
        {tr("官方查询入口")}
      </h3>
      <ul aria-labelledby="metals-official-links" className="mt-2 grid gap-x-6 gap-y-1.5 text-[12.5px] leading-relaxed sm:grid-cols-2">
        {links.map((entry) => (
          <li key={entry.url}>
            <a href={entry.url} target="_blank" rel="noopener noreferrer" className="font-medium text-accent hover:underline">
              {entry.name}
              <IconExternal size={11} className="ml-0.5 inline" />
              <NewWindow />
            </a>
            <span className="ml-1.5 text-ink-4">{entry.note}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Sources stay in view with their attribution and licence links; the longer notes fold away. */
function SourcesSection({ prices }: { prices: MetalPrices }) {
  const tr = useTr();
  return (
    <section aria-labelledby="metals-sources" className="mt-10 border-t border-line pt-5">
      <h2 id="metals-sources" className="text-[15px] font-semibold text-ink">
        {tr("数据来源与说明")}
      </h2>
      <ul className="mt-3 space-y-1.5 text-[12.5px] leading-relaxed text-ink-3">
        {prices.sources.map((source) => (
          <li key={source.key}>
            <Tag value={source.tag} />
            {source.latest ? (
              <External href={source.latest.release.url} title={source.latest.release.label}>
                {source.name}
              </External>
            ) : (
              <span className="text-ink-2">{source.name}</span>
            )}
            {source.latest && (
              <span className="text-ink-4">
                {" · "}
                {tr("最新")} {shortLabel(prices, source.latest.label)}
              </span>
            )}
            {source.status === "stale" && <span className="ml-1.5 text-amber-ink">{tr("更新延迟")}</span>}
            {source.status === "empty" && <span className="ml-1.5 text-ink-4">{tr("暂缺")}</span>}
            {sourceLinks(prices, source).map((link) => (
              <span key={link.url} className="text-ink-4">
                {" · "}
                <External href={link.url}>{link.name}</External>
              </span>
            ))}
          </li>
        ))}
      </ul>
      <details id="metals-notes" className="disclosure group/notes mt-4 text-[12.5px]">
        <summary className="inline-flex items-center gap-1 font-medium text-ink-3 transition-colors hover:text-ink">
          {tr("说明与官方查询入口")}
          <IconChevronDown size={13} className="transition-transform duration-200 group-open/notes:rotate-180" />
        </summary>
        <ul className="mt-3 max-w-[760px] list-disc space-y-1.5 pl-5 leading-relaxed text-ink-3 marker:text-ink-4">
          {prices.notes.map((note, index) => (
            <li key={note.ref ?? `plain-${index}`} id={note.ref === null ? undefined : `n${note.ref}`}>
              <NoteText note={note} />
            </li>
          ))}
        </ul>
        <OfficialLinks links={prices.officialLinks} />
      </details>
    </section>
  );
}

export default function MetalsPage() {
  const tr = useTr();
  const { prices: initialPrices } = useLoaderData<typeof loader>();
  const [prices, setPrices] = useState(initialPrices);
  const [refreshFailed, setRefreshFailed] = useState(false);
  useEffect(() => {
    if (initialPrices) setPrices(initialPrices);
    let timer: ReturnType<typeof setInterval> | undefined;
    let pending: AbortController | null = null;
    const apiBase = window.location.origin;
    const refresh = async () => {
      if (document.visibilityState !== "visible" || pending) return;
      const request = new AbortController();
      pending = request;
      try {
        const result = await apiFetch("/api/site/metal-prices", {
          cache: "no-cache",
          headers: { accept: "application/json" },
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
          baseUrl: apiBase,
        });
        if (!result.ok) throw new Error("Price refresh unavailable");
        const next = publicSchemas.MetalPrices.parse(await result.json());
        if (!request.signal.aborted) {
          setPrices(next);
          setRefreshFailed(false);
        }
      } catch {
        if (!request.signal.aborted) setRefreshFailed(true);
      } finally {
        if (pending === request) pending = null;
      }
    };
    const pause = () => {
      clearInterval(timer);
      pending?.abort();
      pending = null;
    };
    const resume = () => {
      pause();
      if (document.visibilityState === "visible") {
        void refresh();
        timer = setInterval(refresh, 300_000);
      }
    };
    if (document.visibilityState === "visible") timer = setInterval(refresh, 300_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("pagehide", pause);
    return () => {
      pause();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("pagehide", pause);
    };
  }, [initialPrices]);
  const hasData = prices?.metals.some((metal) => metal.quotes.some((quote) => quote.value !== null));
  return (
    <article data-metals className="mx-auto max-w-[var(--page-max-reading)] pb-12">
      <header className="pt-5 lg:pt-1">
        <h1 data-page-title="" className="text-[24px] font-semibold leading-[1.3] text-ink">
          {tr("金属价格")}
        </h1>
        {prices && <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-3">{prices.intro}</p>}
      </header>
      {!prices ? (
        <p className="mt-4 text-[14px] text-ink-3">{tr("价格数据暂时无法读取")}</p>
      ) : (
        <>
          <p className={`mt-1 text-[12px] ${refreshFailed ? "text-amber-ink" : "text-ink-4"}`} role="status">
            {refreshFailed ? tr("更新暂时失败，仍显示上次读取的结果。") : tr("按官方最新公布的期次展示；尚未发布新报价时保留上一期。")}
          </p>
          {!hasData ? (
            <>
              <p className="mt-5 text-[14px] text-ink-3">{tr("暂无可显示的报价")}</p>
              <OfficialLinks links={prices.officialLinks} />
            </>
          ) : (
            <>
              <LatestLine prices={prices} />
              <ul
                data-metal-grid
                aria-label={tr("各金属最新报价")}
                className="mt-4 grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 max-md:grid-flow-row-dense md:grid-cols-3 md:items-start xl:grid-cols-4"
              >
                {prices.metals.map((metal) => (
                  <MetalCard key={metal.key} prices={prices} metal={metal} />
                ))}
              </ul>
              <SourcesSection prices={prices} />
            </>
          )}
        </>
      )}
      <Link to="/all?category=commodity_market" className="mt-8 inline-block text-[14px] font-medium text-accent hover:underline">
        {tr("浏览矿业市场动态 →")}
      </Link>
    </article>
  );
}
