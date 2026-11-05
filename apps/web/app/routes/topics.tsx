import { PhoneBar } from "../components/shell/PhoneBar";
import { useTr } from "../i18n";
import { useLoaderData } from "react-router";
import { IntentLink as Link } from "../components/ui/IntentLink";
import { apiGet } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { schemas as publicSchemas } from "@amp/contracts/http/public";
import { BrandMark } from "../components/BrandMark";

export async function loader({ request }: { request: Request }) {
  return publicSchemas.TopicDirectory.parse(await apiGet<unknown>("/api/site/topics", { signal: request.signal }));
}

export function meta() {
  return pageMeta({
    title: "主题",
    description: "按国家与地区、金属、矿企聚合的金属矿业主题页：智利、刚果（金）、铜、锂、紫金矿业、必和必拓等。",
    path: "/topics",
    image: "/og/pages/topics.png",
  });
}

export function headers() {
  return { "Cache-Control": "no-store" };
}

const GROUPS = [
  { key: "genre", name: "国家与地区", blurb: "按国家与地区看金属矿业：政策、项目与市场" },
  { key: "field", name: "金属", blurb: "按金属看矿业：铜、金、锂、镍……" },
  { key: "company", name: "矿企", blurb: "按公司追踪：项目、产量、并购与经营" },
  { key: "project", name: "项目", blurb: "按核实的矿业项目追踪建设、运营与关键进展" },
] as const;

export default function TopicsPage() {
  const tr = useTr();
  const { topics: allTopics } = useLoaderData<typeof loader>();
  const topics = allTopics.filter((topic) => topic.total > 0);
  const picks = topics[0]?.basis !== "all";
  return (
    <div className="pb-10">
      <PhoneBar back={{ to: "/more", label: tr("我的") }} title={tr("主题")} />
      <header className="pb-2 pt-5 lg:pt-1">
        <h1 data-page-title="" className="text-[24px] font-semibold leading-[1.3] text-ink">
          {tr("按主题看矿业")}
        </h1>
        <p className="mt-1.5 text-[14px] leading-relaxed text-ink-3">
          {tr("按国家与地区、金属、矿企浏览")} <span className="num">{topics.length}</span> {tr("个主题，持续汇集近期")}
          {picks ? tr("焦点与精选") : tr("动态")}。
        </p>
      </header>
      {GROUPS.filter((group) => topics.some((topic) => topic.group === group.key)).map((g) => (
        <section key={g.key} aria-labelledby={`topics-${g.key}`} className="pt-8">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h2 id={`topics-${g.key}`} className="text-[16px] font-bold text-ink">
              {tr.maybe(g.name)}
            </h2>
            <p className="text-[13px] text-ink-4">{tr.maybe(g.blurb)}</p>
          </div>
          <ul className="mt-3.5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {topics
              .filter((t) => t.group === g.key)
              .sort((a, b) => b.recent - a.recent || a.name.localeCompare(b.name, "zh-CN"))
              .map((t) => (
                <li key={t.slug}>
                  <Link
                    to={`/topics/${t.slug}`}
                    aria-label={`查看${t.name}相关${picks ? tr("精选文章") : tr("动态")}`}
                    className="card card-hover group flex h-full flex-col px-5 py-[18px]"
                  >
                    <span className="flex items-center gap-2.5 text-[16px] font-bold text-ink transition-colors group-hover:text-accent">
                      {t.brand && <BrandMark brand={t.brand} />}
                      {t.name}
                    </span>
                    <span className="mt-1.5 line-clamp-2 flex-1 text-[13.5px] leading-[1.7] text-ink-3">{t.definition}</span>
                    <span className="mono mt-3 text-[12.5px] text-accent">
                      {tr("近 30 天")} {t.recent} {tr("条")}
                      {picks ? tr("精选") : tr("动态")} <span className="inline-block transition-transform duration-200 group-hover:translate-x-0.5">→</span>
                    </span>
                  </Link>
                </li>
              ))}
          </ul>
        </section>
      ))}
      <section className="mt-8 border-t border-line pt-5">
        <h2 className="text-[16px] font-bold">{tr("法律监管")}</h2>
        <Link to="/policies" className="mt-3 inline-block text-[15px] text-accent">
          {tr("查看法规政策动态 →")}
        </Link>
      </section>
    </div>
  );
}
