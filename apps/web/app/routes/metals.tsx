import { useEffect, useState } from "react";
import { Link, data as withHeaders, useLoaderData } from "react-router";
import type { Route } from "./+types/metals";
import { createPublicClient, publicSchemas } from "@amp/api-client/public";
import { apiBaseFor } from "../../api-target";
import { contractResult } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { IconExternal } from "../components/icons";

export async function loader({ request }: Route.LoaderArgs) {
  try {
    const prices = await createPublicClient({ baseUrl: apiBaseFor("/api/site/metal-prices") })
      .GET("/api/site/metal-prices", {
        headers: { accept: "application/json", "x-amp-ssr": "1" },
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
      })
      .then((response) => contractResult(response, publicSchemas.MetalPrices));
    return withHeaders({ prices }, { headers: { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" } });
  } catch (error) {
    if (request.signal.aborted) throw error;
    return withHeaders({ prices: null }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}
export function meta() {
  return pageMeta({ title: "金属价格", description: "官方机构定期发布的金属价格，注明出处。", path: "/metals" });
}

function priceText(value: string, decimals: number | null) {
  if (decimals !== null) {
    // Intl accepts a decimal string without the precision loss of a JavaScript number; lib.d.ts lacks that overload.
    return new Intl.NumberFormat("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value as unknown as number);
  }
  const [integer, fraction] = value.split(".");
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction === undefined ? "" : `.${fraction}`);
}
const Tag = ({ value }: { value: string }) => (
  <span className="mr-1.5 inline-block rounded-mark bg-bg-muted px-1.5 py-0.5 text-[10px] leading-none text-ink-3">{value}</span>
);
const NewWindow = () => <span className="sr-only">（在新窗口打开）</span>;

export default function MetalsPage() {
  const { prices: initialPrices } = useLoaderData<typeof loader>();
  const [prices, setPrices] = useState(initialPrices);
  const [refreshFailed, setRefreshFailed] = useState(false);
  useEffect(() => {
    if (initialPrices) setPrices(initialPrices);
    let timer: ReturnType<typeof setInterval> | undefined;
    let pending: AbortController | null = null;
    const client = createPublicClient({ baseUrl: window.location.origin });
    const refresh = async () => {
      if (document.visibilityState !== "visible" || pending) return;
      const request = new AbortController();
      pending = request;
      try {
        const result = await client.GET("/api/site/metal-prices", {
          cache: "no-cache",
          headers: { accept: "application/json" },
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
        });
        if (!result.response.ok) throw new Error("Price refresh unavailable");
        const next = publicSchemas.MetalPrices.parse(result.data);
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
  const tags = new Map(prices?.sources.map((source) => [source.key, source.tag]));
  return (
    <article data-metals className="mx-auto max-w-[var(--page-max-reading)] pb-10">
      <h1 className="pb-2 pt-5 text-[22px] font-bold text-ink lg:pt-1 lg:text-[24px] lg:font-semibold">金属价格</h1>
      {!prices ? (
        <p className="mt-4 text-[14px] text-ink-3">价格数据暂时无法读取</p>
      ) : (
        <>
          <p className="text-[14px] leading-relaxed text-ink-3">{prices.intro}</p>
          <p className={`mt-2 text-[12px] ${refreshFailed ? "text-amber-ink" : "text-ink-4"}`} role="status">
            {refreshFailed ? "更新暂时失败，仍显示上次读取的结果。" : "页面可见时每 5 分钟检查更新，报价以官方发布期次为准。"}
          </p>
          {!hasData ? (
            <p className="mt-5 text-[14px] text-ink-3">暂无已授权价格数据</p>
          ) : (
            <>
              <section aria-label="最新一期" className="mt-5 rounded-control bg-bg-sunk px-3 py-2.5 text-[12px] leading-6 text-ink-3">
                <span className="mr-3 text-ink-4">最新一期</span>
                {prices.latest.map((period) => (
                  <span key={period.tag} className="mr-4 inline-block">
                    <Tag value={period.tag} />
                    {period.label ?? "暂无已授权价格数据"}
                    {period.stale && <span className="ml-1 text-amber-ink">数据已陈旧</span>}
                    {period.extras.map((extra) => (
                      <span key={extra.label}>
                        （{extra.metals.join("、")} {extra.label}
                        {extra.stale && " 数据已陈旧"}）
                      </span>
                    ))}
                  </span>
                ))}
              </section>
              <section
                aria-label="金属价格表"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: This scroll region must be keyboard reachable.
                tabIndex={0}
                className="mt-4 overflow-x-auto rounded-card border border-line bg-surface focus-visible:outline-accent"
              >
                <table className="w-full table-fixed border-collapse text-[12px] sm:text-[14px]">
                  <caption className="sr-only">按品种分组的官方机构报价及较上期变化</caption>
                  <thead className="bg-bg-sunk text-left text-[11px] font-medium text-ink-3 sm:text-[12px]">
                    <tr>
                      <th scope="col" className="w-11 px-2 py-2.5 sm:w-16 sm:px-4">
                        品种
                      </th>
                      <th scope="col" className="px-2 py-2.5 sm:w-44 sm:px-4">
                        报价
                      </th>
                      <th scope="col" className="w-24 px-2 py-2.5 text-right sm:w-32 sm:px-4">
                        价格
                      </th>
                      <th scope="col" className="w-16 px-2 py-2.5 text-right sm:w-22 sm:px-4">
                        较上期
                      </th>
                      <th scope="col" className="hidden px-4 py-2.5 sm:table-cell">
                        规格
                      </th>
                    </tr>
                  </thead>
                  {prices.metals.map((metal) => (
                    <tbody key={metal.key} className="border-t border-line sm:even:bg-bg-sunk/40">
                      {metal.quotes.map((quote, index) => {
                        const parts = quote.title.split(" · "),
                          percent = quote.change?.percent;
                        return (
                          <tr key={quote.key} className={`sm:hover:bg-bg-sunk/60 ${index ? "border-t border-line-soft" : ""}`}>
                            {index === 0 && (
                              <th scope="rowgroup" rowSpan={metal.quotes.length} className="px-2 py-3 text-left align-top font-semibold text-ink sm:px-4">
                                {metal.name}
                              </th>
                            )}
                            <td className="px-2 py-3 align-top sm:px-4">
                              <div className="leading-5 text-ink-2">
                                <Tag value={tags.get(quote.source)!} />
                                {parts.map((part, i) => (
                                  <span key={parts.slice(0, i + 1).join(" · ")} className="inline-block">
                                    {i > 0 && " · "}
                                    {part}
                                    {i === parts.length - 1 && quote.footnote !== null && (
                                      <sup className="ml-0.5">
                                        <a href={`#n${quote.footnote}`} aria-label={`见说明第 ${quote.footnote} 条`} className="text-accent hover:underline">
                                          {quote.footnote}
                                        </a>
                                      </sup>
                                    )}
                                  </span>
                                ))}
                              </div>
                              {quote.spec && <div className="mt-1 text-[10px] leading-4 text-ink-4 sm:hidden">{quote.spec}</div>}
                            </td>
                            <td className="px-2 py-3 text-right align-top sm:px-4">
                              <span className={`mono tabular-nums whitespace-nowrap ${quote.value === null ? "text-ink-4" : "font-semibold text-ink"}`}>
                                {quote.value === null ? "暂缺" : priceText(quote.value, quote.decimals)}
                              </span>
                              <span className="mt-1 block text-[10px] leading-4 text-ink-4 sm:text-[11px]">{quote.unit}</span>
                            </td>
                            <td
                              className={`mono whitespace-nowrap px-2 py-3 text-right align-top sm:px-4 ${!percent || percent === "0.0" ? "text-ink-3" : percent.startsWith("-") ? "text-ok" : "text-hot"}`}
                            >
                              {percent && `${percent === "0.0" ? percent : percent.startsWith("-") ? `−${percent.slice(1)}` : `+${percent}`}%`}
                            </td>
                            <td className="hidden px-4 py-3 align-top text-[12px] leading-5 text-ink-4 sm:table-cell">{quote.spec}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  ))}
                </table>
              </section>
              <section className="mt-7" aria-labelledby="metals-notes">
                <h2 id="metals-notes" className="text-[15px] font-semibold text-ink">
                  说明
                </h2>
                <ol className="mt-2 list-decimal space-y-2 pl-5 text-[12px] leading-relaxed text-ink-3">
                  {prices.notes.map((note, index) => {
                    const [before, after] = note.text.split("{link}");
                    return (
                      <li key={note.ref ?? `plain-${index}`} id={note.ref === null ? undefined : `n${note.ref}`} className="scroll-mt-16 pl-1">
                        {before}
                        {note.link && (
                          <a href={note.link.url} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2">
                            {note.link.name}
                            <NewWindow />
                          </a>
                        )}
                        {after}
                      </li>
                    );
                  })}
                </ol>
              </section>
            </>
          )}
          {prices.officialLinks.length > 0 && (
            <section className="mt-7" aria-labelledby="metals-official-links">
              <h2 id="metals-official-links" className="text-[15px] font-semibold text-ink">
                官方查询入口
              </h2>
              <ul className="mt-3 space-y-2.5 text-[13px] leading-relaxed">
                {prices.officialLinks.map((entry) => (
                  <li key={entry.url}>
                    <a href={entry.url} target="_blank" rel="noopener noreferrer" className="font-medium text-accent hover:underline">
                      {entry.name}
                      <IconExternal size={12} className="ml-1 inline" />
                      <NewWindow />
                    </a>
                    <span className="ml-2 text-ink-3">{entry.note}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      <Link to="/all?category=commodity_market" className="mt-7 inline-block text-[14px] font-medium text-accent hover:underline">
        浏览矿业市场动态 →
      </Link>
    </article>
  );
}
