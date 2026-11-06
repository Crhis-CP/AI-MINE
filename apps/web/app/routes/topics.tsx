import { PhoneBar } from "../components/shell/PhoneBar";
import { useTr } from "../i18n";
import { useLoaderData, useSearchParams } from "react-router";
import { PillTabs } from "../components/ui/Tabs";
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

/**
 * The topic directory (UI update, Owner 2026-11-05): one group at a time behind a switch, compact tiles with the
 * 30-day count and a bar for its size within the group, so the busiest topics stand out without reading every card.
 * The group is in the address (?g=), so it works without scripts and keeps its place on back.
 */
export default function TopicsPage() {
  const tr = useTr();
  const { topics: allTopics } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const topics = allTopics.filter((topic) => topic.total > 0);
  const picks = topics[0]?.basis !== "all";
  const groups = GROUPS.filter((group) => topics.some((topic) => topic.group === group.key));
  const current = groups.find((g) => g.key === params.get("g")) ?? groups[0];
  const shown = topics.filter((t) => t.group === current?.key).sort((a, b) => b.recent - a.recent || a.name.localeCompare(b.name, "zh-CN"));
  const most = Math.max(1, ...shown.map((t) => t.recent));
  return (
    <div className="pb-10">
      <PhoneBar back={{ to: "/more", label: tr("我的") }} title={tr("主题")} />
      <header className="pb-2 pt-5 lg:pt-1">
        <h1 data-page-title="" className="text-[24px] font-semibold leading-[1.3] text-ink">
          {tr("按主题看矿业")}
        </h1>
        <p className="mt-1.5 text-[14px] leading-relaxed text-ink-3">
          {tr("按国家与地区、金属、矿企浏览")} <span className="num">{topics.length}</span> {tr("个主题，持续汇集近期")}
          {picks ? tr("焦点与精选") : tr("动态")}
          {tr("。")}
        </p>
      </header>
      {groups.length > 1 && (
        <PillTabs
          className="mt-4"
          label={tr("主题分组")}
          layoutId="topic-groups"
          active={current?.key ?? ""}
          items={groups.map((g) => ({
            key: g.key,
            label: tr.maybe(g.name),
            count: topics.filter((t) => t.group === g.key).length,
            to: g.key === groups[0]?.key ? "/topics" : `/topics?g=${g.key}`,
            replace: true,
          }))}
        />
      )}
      {current && (
        <section aria-labelledby={`topics-${current.key}`} className="pt-5">
          <h2 id={`topics-${current.key}`} className="sr-only">
            {tr.maybe(current.name)}
          </h2>
          <p className="text-[13px] text-ink-4">{tr.maybe(current.blurb)}</p>
          <ul className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {shown.map((t) => (
              <li key={t.slug}>
                <Link
                  to={`/topics/${t.slug}`}
                  title={t.definition}
                  aria-label={tr("查看{name}相关{what}", { name: t.name, what: picks ? tr("精选文章") : tr("动态") })}
                  className="card card-hover group flex h-full flex-col gap-2 px-4 py-3.5"
                >
                  <span className="flex min-w-0 items-center gap-2 text-[15.5px] font-semibold text-ink transition-colors group-hover:text-accent">
                    {t.brand && <BrandMark brand={t.brand} />}
                    <span className="truncate">{t.name}</span>
                  </span>
                  <span className="flex items-baseline gap-1.5">
                    <span className="num text-[20px] font-semibold leading-none text-ink">{t.recent}</span>
                    <span className="text-[12px] text-ink-4">
                      {tr("近 30 天")} · {picks ? tr("精选") : tr("动态")}
                    </span>
                  </span>
                  <span aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-bg-sunk">
                    <span className="block h-full rounded-full bg-accent/60" style={{ width: `${Math.max(4, (t.recent / most) * 100)}%` }} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="mt-8 border-t border-line pt-5">
        <Link to="/policies" className="card card-hover flex items-center justify-between px-5 py-4">
          <span>
            <span className="block text-[15.5px] font-semibold text-ink">{tr("法律监管")}</span>
            <span className="mt-0.5 block text-[13px] text-ink-3">{tr("按国家和经营主题查看官方法规")}</span>
          </span>
          <span className="text-accent" aria-hidden="true">
            →
          </span>
        </Link>
      </section>
    </div>
  );
}
