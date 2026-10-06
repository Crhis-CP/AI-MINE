import { Link } from "react-router";
import { pageMeta } from "../lib/seo";
import { IconExternal } from "../components/icons";

/**
 * 金属价格, tier 1 (PG-11): official entries and the notice only. No quote, number, table or price
 * endpoint until the owner approves a licensed data source (DEC-07, INV-47).
 */
const OFFICIAL_ENTRIES = [{ name: "LME 官方金属行情", note: "铜、铝、镍、锌、铅、锡等金属的官方信息。", href: "https://www.lme.com/metals" }];

/** Shared caches may keep this page for five minutes. */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

export function meta() {
  return pageMeta({ title: "金属价格", description: "通过伦敦金属交易所（LME）官方入口查看金属行情。", path: "/metals" });
}

export default function MetalsPage() {
  return (
    <article data-metals className="mx-auto max-w-[var(--page-max-reading)] pb-10">
      <h1 className="pb-2 pt-5 text-[22px] font-bold text-ink lg:pt-1 lg:text-[24px] lg:font-semibold">金属价格</h1>
      <p className="text-[14px] text-ink-3">通过伦敦金属交易所（LME）官方入口查看金属行情。</p>
      <ul className="mt-5 space-y-3">
        {OFFICIAL_ENTRIES.map((e) => (
          <li key={e.href}>
            <a
              href={e.href}
              target="_blank"
              rel="noopener noreferrer"
              className="card flex items-center gap-3 px-4 py-4 transition-colors active:bg-bg-sunk lg:hover:bg-bg-sunk"
            >
              <span className="flex-1">
                <span className="block text-[15px] font-semibold text-ink">{e.name}</span>
                <span className="mt-1 block text-[13px] text-ink-3">{e.note}</span>
              </span>
              <IconExternal size={16} className="text-ink-4" />
              <span className="sr-only">（在新窗口打开）</span>
            </a>
          </li>
        ))}
      </ul>
      <p className="mt-5 text-[13px] leading-relaxed text-ink-3">本站目前不展示或转售 LME 报价。行情的时间、计价单位与使用规则以 LME 官方页面为准。</p>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-3">站内价格表尚未开通，暂无已授权价格数据。</p>
      <Link to="/all?category=commodity_market" className="mt-6 inline-block text-[14px] font-medium text-accent hover:underline">
        浏览矿业市场动态 →
      </Link>
    </article>
  );
}
