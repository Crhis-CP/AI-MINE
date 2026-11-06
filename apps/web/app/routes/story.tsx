import { SITE } from "@amp/industry/site";
import { useTr, useDateFormat } from "../i18n";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { redirect, useLoaderData } from "react-router";
import { IntentLink as Link } from "../components/ui/IntentLink";
import type { Route } from "./+types/story";
import type { StoryDetail, StoryReportView } from "@amp/contracts/site";
import { data as routeData } from "react-router";
import { breadcrumbLd, pageMeta, titled } from "../lib/seo";
import { beijingDate, isDateOnlyInstant, NO_TIME, newsSourceDate, sourceMonthDayTime } from "../lib/format";
import { ShareLink } from "../components/ShareLink";
import { StorySaveButton } from "../features/story/StorySaved";
import { HeatChart } from "../features/story/HeatChart";
import { KeyChanges, Storyline } from "../features/story/Storyline";
import { Badge, SelectedBadge } from "../components/ui/Badge.tsx";
import { PillTabs } from "../components/ui/Tabs";
import { Select } from "../components/ui/Controls";
import { IconArrowLeft, IconChevronRight, IconClock, IconDoc, IconUsers } from "../components/icons";

export async function loader({ params, request }: Route.LoaderArgs) {
  const res = await fetch(`${process.env.API_BASE_URL || "http://127.0.0.1:3001"}/api/site/stories/${encodeURIComponent(params.publicId)}`, {
    redirect: "manual",
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
  });
  if (res.status === 308) {
    const target = (await res.json()) as { mergedInto: string };
    throw redirect(`/story/${target.mergedInto}`, 308);
  }
  if (res.status === 404) throw routeData({ message: "not_found" }, { status: 404 });
  if (!res.ok) throw routeData({ message: "unavailable" }, { status: 503 });
  return { story: (await res.json()) as StoryDetail };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: titled("事件不存在") }, { name: "robots", content: "noindex" }];
  const s = loaderData.story;
  return pageMeta({
    title: s.title,
    description: (s.digest ?? s.summary)?.slice(0, 150) ?? `${s.sourceCount} 个报道来源 ${s.reportCount} 篇报道，完整时间线与最新进展。`,
    path: `/story/${s.publicId}`,
    image: `/og/stories/${s.publicId}.png`,
    type: "article",
    jsonLd: breadcrumbLd([
      { name: SITE.name, path: "/" },
      { name: "热点榜", path: "/hot" },
      { name: s.title, path: `/story/${s.publicId}` },
    ]),
  });
}

export function headers() {
  return { "Cache-Control": "no-store" };
}

const STATUS = {
  active: { label: "持续更新", tone: "hot" },
  watching: { label: "观察中", tone: "amber" },
  settled: { label: "历史事件", tone: "neutral" },
} as const;

// Section anchors keep the old page's ids so shared links still land in the right place.
const SECTIONS = { overview: "event-overview", storyline: "event-storyline", reports: "event-reports", heat: "event-heat" } as const;
type SectionKey = keyof typeof SECTIONS;

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** A main-column card: 17px title, 24px padding. */
function Panel({
  id,
  title,
  sub,
  right,
  children,
  className = "",
}: {
  id?: string;
  title: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`card scroll-mt-[64px] p-5 lg:p-6 ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[17px] font-[650] leading-[1.5] text-ink">{title}</h2>
          {sub && <p className="mt-0.5 text-[13.5px] text-ink-4">{sub}</p>}
        </div>
        {right && <div className="shrink-0 text-[12.5px] text-ink-4">{right}</div>}
      </div>
      <div className="mt-3.5">{children}</div>
    </section>
  );
}

/** A rail card: 14px title, 22px padding. */
function RailCard({ title, right, children, className = "" }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card p-5 lg:p-[22px] ${className}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[15px] font-[650] text-ink">{title}</h2>
        {right && <span className="num text-[12.5px] text-ink-4">{right}</span>}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}

/** Highlights the section nav entry whose section is under the sticky bar. */
function useActiveSection(keys: SectionKey[]): [SectionKey, (k: SectionKey) => void] {
  const [active, setActive] = useState<SectionKey>("overview");
  useEffect(() => {
    const els = keys.map((k) => document.getElementById(SECTIONS[k])).filter((e): e is HTMLElement => !!e);
    const onScroll = () => {
      let cur: SectionKey = keys[0]!;
      for (const [i, el] of els.entries()) if (el.getBoundingClientRect().top <= 96) cur = keys[i]!;
      // The last section may never reach the bar; at the bottom of the page it is the one being read.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) cur = keys[keys.length - 1]!;
      setActive(cur);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [keys.join()]);
  const go = (k: SectionKey) => {
    const el = document.getElementById(SECTIONS[k]);
    if (!el) return;
    el.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    history.replaceState(history.state, "", `#${SECTIONS[k]}`);
  };
  return [active, go];
}

function dayLabelOf(day: string): string {
  const [, m, d] = day.split("-").map(Number) as [number, number, number];
  return `${m}月${d}日`;
}

/** One report on the story timeline: time, source and marks, title, a summary that opens on demand. */
function TimelineRow({ r }: { r: StoryReportView }) {
  const tr = useTr();
  const [open, setOpen] = useState(false);
  const sourceDate = newsSourceDate(r.sourceTime, r.publishedAt);
  const [clamped, setClamped] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [r.summary, open]);
  return (
    <li className="grid gap-x-3 border-b border-line-soft py-4 last:border-b-0 lg:grid-cols-[48px_minmax(0,1fr)]">
      <time
        dateTime={sourceDate?.dateTime}
        title={sourceDate ? `${sourceDate.label}：${sourceDate.text}` : tr("原文时间尚未确认")}
        className="mono text-[13px] leading-[20px] text-ink-4"
      >
        {sourceDate?.clock ?? NO_TIME}
      </time>
      <div className="min-w-0">
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[13px] leading-[20px] text-ink-4 lg:mt-0">
          <span className="min-w-0 truncate">{r.source.name.replace(/（RSS）|（网页）|（API）/g, "")}</span>
          {r.selected && <SelectedBadge />}
        </div>
        <Link to={`/items/${r.id}`} className="mt-1 block text-[16px] font-[650] leading-[1.6] text-ink transition-colors hover:text-accent lg:text-[15.5px]">
          {r.title}
        </Link>
        {r.summary && (
          <>
            <p ref={ref} className={`mt-1 text-[15px] leading-[1.75] text-ink-3 ${open ? "" : "line-clamp-2"}`}>
              {r.summary}
            </p>
            {(clamped || open) && (
              <button
                type="button"
                onClick={() => setOpen(!open)}
                aria-expanded={open}
                className="mt-1 text-[13.5px] text-note transition-colors hover:text-accent"
              >
                {open ? tr("收起摘要") : tr("展开摘要")}
              </button>
            )}
          </>
        )}
      </div>
    </li>
  );
}

type Filter = "all" | "official" | "selected";

export default function StoryPage() {
  const df = useDateFormat();
  const tr = useTr();
  const { story } = useLoaderData<typeof loader>();
  const [filter, setFilter] = useState<Filter>("all");
  const [order, setOrder] = useState<"desc" | "asc">("desc");
  const status = STATUS[story.status];
  // A settled story nobody watched (history pages) has no heat to explain or chart.
  const observed = story.status !== "settled" || story.heat.length > 0 || story.whyHot.participants48h > 0 || story.whyHot.rank !== null;
  // The line has a node whenever there is a development, earlier background or a dated milestone ahead.
  const hasLine = story.developments.length > 0 || !!story.background?.length || !!story.next?.length;
  const sectionKeys: SectionKey[] = ["overview", ...(hasLine ? (["storyline"] as const) : []), "reports", ...(observed ? (["heat"] as const) : [])];
  const [activeSection, goSection] = useActiveSection(sectionKeys);
  const counts = {
    all: story.timeline.length,
    official: story.timeline.filter((r) => r.source.firstParty).length,
    selected: story.timeline.filter((r) => r.selected).length,
  };
  const days = useMemo(() => {
    const list = story.timeline.filter((r) => (filter === "official" ? r.source.firstParty : filter === "selected" ? r.selected : true));
    const sorted = [...list].sort((a, b) =>
      order === "desc" ? Date.parse(b.publishedAt) - Date.parse(a.publishedAt) : Date.parse(a.publishedAt) - Date.parse(b.publishedAt),
    );
    const out: Array<{ day: string; rows: StoryReportView[] }> = [];
    for (const r of sorted) {
      const d = beijingDate(r.publishedAt);
      const last = out[out.length - 1];
      if (last && last.day === d) last.rows.push(r);
      else out.push({ day: d, rows: [r] });
    }
    return out;
  }, [story.timeline, filter, order]);
  const newest = story.timeline.reduce<StoryReportView | null>((a, b) => (!a || Date.parse(b.publishedAt) > Date.parse(a.publishedAt) ? b : a), null);
  const overview = story.digest
    ? {
        label: tr("AI 综述"),
        text: story.digest,
        note: story.digestUpdatedAt
          ? tr("AI 根据报道生成 · {digestUpdatedAt}更新", { digestUpdatedAt: df.relativeTime(story.digestUpdatedAt) })
          : tr("AI 根据报道生成"),
      }
    : story.summary
      ? { label: tr("事实说明"), text: story.summary, note: null }
      : story.excerpt
        ? { label: tr("报道摘要"), text: story.excerpt.text, note: tr("摘自 {sourceName}", { sourceName: story.excerpt.sourceName }) }
        : null;
  const showOfficial = () => {
    setFilter("official");
    goSection("reports");
  };

  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-10">
      <nav aria-label={tr("位置")} className="flex items-center gap-2.5 pb-4 pt-5 text-[13px] text-ink-4 lg:pb-5 lg:pt-4">
        <Link to="/hot" className="inline-flex items-center gap-1.5 transition-colors hover:text-ink">
          <IconArrowLeft size={15} /> {tr("热点榜")}
        </Link>
        <span className="h-3 w-px bg-line-strong" aria-hidden="true" />
        <span>{tr("事件详情")}</span>
      </nav>

      <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1">
        <StorySaveButton id={story.publicId} />
        <ShareLink path={`/story/${story.publicId}`} title={story.title} />
      </div>
      <header className="max-w-[960px]">
        <div className="flex items-center gap-2 text-[13px] text-ink-4">
          {tr("热点事件")}
          <Badge tone={status.tone}>{tr.maybe(status.label)}</Badge>
        </div>
        <h1 className="mt-2.5 text-[27px] font-bold leading-[1.5] tracking-[-0.01em] text-ink lg:mt-3 lg:text-[36px] lg:font-[730]">{story.title}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[13.5px] text-ink-3">
          <span className="inline-flex items-center gap-1.5">
            <IconDoc size={15} className="text-ink-4" />
            <b className="num font-semibold text-ink">{story.reportCount}</b> {tr("篇报道")}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <IconUsers size={15} className="text-ink-4" />
            <b className="num font-semibold text-ink">{story.sourceCount}</b> {tr("个报道来源")}
          </span>
          {story.latestAt && (
            <span className="inline-flex items-center gap-1.5" suppressHydrationWarning>
              <IconClock size={15} className="text-ink-4" />
              {isDateOnlyInstant(story.latestAt) ? sourceMonthDayTime(story.latestAt) : df.relativeTime(story.latestAt)}
              {tr("更新")}
            </span>
          )}
        </div>
      </header>

      <div className="sticky top-0 z-20 -mx-4 mt-5 bg-bg/90 px-4 py-2 backdrop-blur-md lg:mx-0 lg:px-0">
        <PillTabs
          size="sm"
          layoutId="story-sections"
          label={tr("事件内容导航")}
          active={activeSection}
          onSelect={(k) => goSection(k as SectionKey)}
          items={[
            { key: "overview", label: tr("事件概览") },
            ...(hasLine ? [{ key: "storyline", label: tr("事件脉络"), count: story.developments.length || undefined }] : []),
            { key: "reports", label: tr("全部报道"), count: story.reportCount },
            ...(observed ? [{ key: "heat", label: tr("热度走势") }] : []),
          ]}
        />
      </div>

      <div className="mt-5 grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:mt-6 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-6 2xl:grid-cols-[minmax(0,1fr)_340px]">
        {/* On phones the main column dissolves so the rail's cards can sit between its sections. */}
        <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-6">
          <Panel id={SECTIONS.overview} title={tr("先了解这件事")} right={overview?.label} className="order-1">
            {overview ? (
              <>
                <p className="whitespace-pre-line text-[16px] leading-[1.85] text-ink-2">{overview.text}</p>
                {overview.note && (
                  <p className="mt-2 text-[13px] text-ink-4" suppressHydrationWarning>
                    {overview.note}
                  </p>
                )}
                {story.digest && !!story.keyChanges?.length && <KeyChanges changes={story.keyChanges} />}
              </>
            ) : (
              <p className="text-[14.5px] text-ink-4">{tr("还没有综述，先看下面的事件脉络。")}</p>
            )}
            {story.latest && (
              <div className="-mx-5 mt-5 border-t border-line-soft px-5 pt-4 lg:-mx-6 lg:px-6">
                <div className="flex items-center gap-2.5 text-[13px]">
                  <span className="font-semibold text-ink">{tr("最新进展")}</span>
                  {story.latestAt && <span className="num text-ink-4">{sourceMonthDayTime(story.latestAt)}</span>}
                </div>
                {newest ? (
                  <Link to={`/items/${newest.id}`} className="group mt-1.5 inline text-[15px] leading-[1.7] text-ink-2 transition-colors hover:text-accent">
                    {story.latest}
                    <IconChevronRight size={14} className="ml-0.5 inline -translate-y-px text-ink-4 transition-transform group-hover:translate-x-0.5" />
                  </Link>
                ) : (
                  <p className="mt-1.5 text-[15px] leading-[1.7] text-ink-2">{story.latest}</p>
                )}
              </div>
            )}
          </Panel>

          {hasLine && (
            <Panel
              id={SECTIONS.storyline}
              title={tr("事件脉络")}
              sub={story.developments.length > 1 ? tr("{developments} 个进展，按时间先后", { developments: story.developments.length }) : undefined}
              className="order-2"
            >
              <Storyline story={story} />
            </Panel>
          )}

          <Panel
            id={SECTIONS.reports}
            title={tr("全部报道")}
            sub={tr("按时间查看每一篇报道。")}
            className="order-4"
            right={
              <Select value={order} onChange={(e) => setOrder(e.target.value as "desc" | "asc")} aria-label={tr("排序")}>
                <option value="desc">{tr("最新在前")}</option>
                <option value="asc">{tr("最早在前")}</option>
              </Select>
            }
          >
            <PillTabs
              size="xs"
              layoutId="story-report-filter"
              label={tr("报道筛选")}
              active={filter}
              onSelect={(k) => setFilter(k as Filter)}
              items={[
                { key: "all", label: tr("全部报道"), count: counts.all },
                { key: "official", label: tr("官方一手"), count: counts.official },
                { key: "selected", label: tr("精选报道"), count: counts.selected },
              ]}
            />
            {days.length === 0 ? (
              <p className="py-10 text-center text-[14px] text-ink-4">{tr("这个筛选下没有报道。")}</p>
            ) : (
              days.map(({ day, rows }) => (
                <div key={day}>
                  <div className="pb-0.5 pt-5 text-[15px] font-semibold text-ink">{dayLabelOf(day)}</div>
                  <ol>
                    {rows.map((r) => (
                      <TimelineRow key={r.id} r={r} />
                    ))}
                  </ol>
                </div>
              ))
            )}
            {story.reportCount > story.timeline.length && (
              <p className="pt-3 text-center text-[13px] text-ink-4">
                {tr("显示最近")} {story.timeline.length} {tr("篇，共")} {story.reportCount} {tr("篇报道。")}
              </p>
            )}
          </Panel>

          {observed && (
            <Panel id={SECTIONS.heat} title={tr("本事件热度走势")} className="order-5">
              <HeatChart points={story.heat} />
            </Panel>
          )}

          {story.related.length > 0 && (
            <Panel title={tr("关联事件")} className="order-6">
              <ul className="-my-1 divide-y divide-line-soft">
                {story.related.map((r) => (
                  <li key={r.publicId}>
                    <Link to={`/story/${r.publicId}`} className="group flex items-baseline gap-3 py-3">
                      <span className="shrink-0 text-[13px] text-ink-4">{r.relation === "storyline" ? tr("同一故事线") : tr("相关事件")}</span>
                      <span className="min-w-0 flex-1 text-[15.5px] font-medium text-ink-2 transition-colors group-hover:text-accent">{r.title}</span>
                      <IconChevronRight size={14} className="shrink-0 self-center text-ink-4" />
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>

        <aside className="order-3 flex min-w-0 flex-col gap-4 lg:order-none lg:gap-5">
          {observed && (
            <RailCard title={tr("为什么热")}>
              <p className="text-[13.5px] leading-[1.75] text-ink-3">
                {tr("过去 48 小时，已观察到")} <b className="num font-semibold text-ink">{story.whyHot.participants48h}</b>{" "}
                {tr("个独立主体参与讨论或报道，最近 6 小时新增")} <b className="num font-semibold text-ink">{story.whyHot.newParticipants6h}</b> {tr("个。")}
              </p>
              {!story.whyHot.observationComplete && (
                <p className="mt-2 text-[13px] leading-relaxed text-ink-4">{tr("部分信源观测不完整，以上仅为已观察到的参与。")}</p>
              )}
              <p className="mt-2 text-[13px] text-ink-4">
                <span className="num">{story.whyHot.recentReports24h}</span> {tr("篇近期报道")}
                {story.whyHot.rank && (
                  <>
                    <span className="mx-1">·</span>
                    <Link to="/hot" className="text-accent hover:underline">
                      {tr("热点榜第")} {story.whyHot.rank} {tr("名")}
                    </Link>
                  </>
                )}
              </p>
            </RailCard>
          )}
          {story.officialReports.length > 0 && (
            <RailCard title={tr("官方一手")} right={tr("{officialReports} 篇", { officialReports: counts.official || story.officialReports.length })}>
              <p className="text-[13px] text-ink-4">{tr("直接了解当事方的说法")}</p>
              <ul className="mt-1 divide-y divide-line-soft">
                {story.officialReports.slice(0, 5).map((r) => (
                  <li key={r.id} className="py-3">
                    <div className="truncate text-[12.5px] text-ink-4">{r.source.name}</div>
                    <Link
                      to={`/items/${r.id}`}
                      className="group mt-1 block text-[14.5px] font-semibold leading-[1.6] text-ink transition-colors hover:text-accent"
                    >
                      {r.title}
                      <IconChevronRight size={13} className="ml-0.5 inline -translate-y-px text-ink-4 transition-transform group-hover:translate-x-0.5" />
                    </Link>
                  </li>
                ))}
              </ul>
              {counts.official > 0 && (
                <button type="button" onClick={showOfficial} className="text-[13px] text-ink-4 transition-colors hover:text-accent">
                  {tr("在时间线筛选全部官方报道")}
                </button>
              )}
            </RailCard>
          )}
          <RailCard title={tr("事件记录")} className="hidden lg:block">
            <dl className="space-y-2 text-[13.5px]">
              {story.firstReportAt && (
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-4">{tr("最早报道")}</dt>
                  <dd className="num text-ink-2">
                    <time dateTime={story.firstReportAt}>{sourceMonthDayTime(story.firstReportAt)}</time>
                  </dd>
                </div>
              )}
              {story.latestAt && (
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-4">{tr("最近更新")}</dt>
                  <dd className="num text-ink-2">
                    <time dateTime={story.latestAt}>{sourceMonthDayTime(story.latestAt)}</time>
                  </dd>
                </div>
              )}
            </dl>
            <p className="mt-3 border-t border-line-soft pt-3 text-[13px] leading-relaxed text-ink-4">{tr("同一事件的报道集中在这里，新的进展会继续补充。")}</p>
          </RailCard>
        </aside>
      </div>
    </div>
  );
}
