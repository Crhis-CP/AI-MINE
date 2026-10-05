import { Link, useLoaderData } from "react-router";
import { EmptyState } from "../components/ui/Page";
import { apiGet } from "../lib/api.server";
import { pageMeta } from "../lib/seo";

interface TopicSummary {
  slug: string;
  name: string;
  group: "company" | "field" | "genre";
  definition: string;
  total: number;
  recent: number;
  indexable: boolean;
  latestAt: string | null;
}

export async function loader({ request }: { request: Request }) {
  return apiGet<{ topics: TopicSummary[] }>("/api/site/topics", { signal: request.signal });
}

export function meta({ loaderData }: { loaderData?: { topics: TopicSummary[] } }) {
  // The “正在规划” empty state, shown while no topic has content, is not indexed (PG-08).
  const empty = !loaderData?.topics.some((t) => t.total > 0);
  return pageMeta({
    title: "主题",
    description: "按国家与地区、金属、矿企聚合的金属矿业主题页：智利、刚果（金）、铜、锂、紫金矿业、必和必拓等。",
    path: "/topics",
    image: "/og/pages/topics.png",
    noindex: empty,
  });
}

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

const GROUPS = [
  { key: "genre", name: "国家与地区", blurb: "按国家与地区看金属矿业：政策、项目与市场" },
  { key: "field", name: "金属", blurb: "按金属看矿业：铜、金、锂、镍……" },
  { key: "company", name: "矿企", blurb: "按公司追踪：项目、产量、并购与经营" },
] as const;

export default function TopicsPage() {
  // Only topics with content are listed; an axis without any stays out of the index (PG-08).
  const topics = useLoaderData<typeof loader>().topics.filter((t) => t.total > 0);
  return (
    <div className="pb-10">
      <header className="pb-2 pt-5 lg:pt-1">
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">按主题看矿业</h1>
        {topics.length > 0 && (
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
            按国家与地区、金属、矿企浏览 <span className="num">{topics.length}</span> 个主题，持续汇集近期动态。
          </p>
        )}
      </header>
      {topics.length === 0 && (
        <EmptyState
          title="主题浏览正在规划"
          action={
            <Link to="/all" className="text-[13px] font-medium text-accent hover:underline">
              查看全部矿业动态
            </Link>
          }
        >
          后续将按国家、金属、矿企、项目和法律监管整理内容。当前可以搜索全部矿业动态，或按来源与日期查找。
        </EmptyState>
      )}
      {GROUPS.filter((g) => topics.some((t) => t.group === g.key)).map((g) => (
        <section key={g.key} aria-labelledby={`topics-${g.key}`} className="pt-8">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h2 id={`topics-${g.key}`} className="text-[15px] font-bold text-ink">
              {g.name}
            </h2>
            <p className="text-[12px] text-ink-4">{g.blurb}</p>
          </div>
          <ul className="mt-3.5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {topics
              .filter((t) => t.group === g.key)
              // Metals and companies by their last 30 days; countries keep the pack's order (PG-08).
              .sort((a, b) => (g.key === "genre" ? 0 : b.recent - a.recent))
              .map((t) => (
                <li key={t.slug}>
                  <Link
                    to={`/topics/${t.slug}`}
                    prefetch="intent"
                    aria-label={`查看${t.name}相关动态`}
                    className="card card-hover group flex h-full flex-col px-5 py-[18px]"
                  >
                    <span className="text-[15px] font-bold text-ink transition-colors group-hover:text-accent">{t.name}</span>
                    <span className="mt-1.5 line-clamp-2 flex-1 text-[12.5px] leading-[1.7] text-ink-3">{t.definition}</span>
                    <span className="mono mt-3 text-[11.5px] text-accent">
                      近 30 天 <span className="num">{t.recent}</span> 条{" "}
                      <span className="inline-block transition-transform duration-200 group-hover:translate-x-0.5">→</span>
                    </span>
                  </Link>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
