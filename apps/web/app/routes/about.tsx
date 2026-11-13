import { INTRO_REPLAY_EVENT } from "../components/shell/Intro";
import { PhoneBar } from "../components/shell/PhoneBar";
import { type Tr, useLocale, useTr } from "../i18n";
import { SignalRiver, type RiverSource } from "../features/about/SignalRiver";
import { apiFetch } from "../lib/http.ts";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLoaderData, useRevalidator } from "react-router";
import { IntentLink as Link } from "../components/ui/IntentLink";
import type { SiteStats } from "@amp/contracts/site";
import { schemas as publicSchemas } from "@amp/contracts/http/public";
import { apiBaseFor } from "../../api-target.ts";
import { contractResult } from "../lib/api.server";
import { ABOUT, SITE } from "@amp/industry/site";
import { organizationLd, pageMeta, SITE_DESCRIPTION_EN } from "../lib/seo";
import { Kicker } from "../components/ui/Kicker.tsx";
import { buttonClass } from "../components/ui/Controls";
import { IconArrowRight } from "../components/icons";
import { useSiteFilings } from "../components/shell/Filings";

/** Revalidate page data; the API owns its short statistics snapshot. */
export function headers() {
  return { "Cache-Control": "public, max-age=0, must-revalidate" };
}

export async function loader({ request }: { request: Request }) {
  const informationRequest = apiFetch("/api/site/information", {
    cache: "no-store",
    headers: { accept: "application/json", "x-amp-ssr": "1" },
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
    baseUrl: apiBaseFor(),
  })
    .then((result) => contractResult(result, publicSchemas.SiteInformation))
    .catch(() => null);
  const stats = await apiFetch("/api/site/stats", {
    cache: "no-store",
    headers: { accept: "application/json", "x-amp-ssr": "1" },
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
    baseUrl: apiBaseFor(),
  })
    .then((result) => contractResult(result, publicSchemas.SiteStats))
    .catch(() => null);
  return { stats, information: await informationRequest };
}

export function meta() {
  return pageMeta({
    title: "关于",
    description: `关于 ${SITE.name}：${SITE.description}`,
    descriptionEn: `About AI-MINE. ${SITE_DESCRIPTION_EN}`,
    path: "/about",
    image: "/og/pages/about.png",
    jsonLd: organizationLd(),
  });
}

/** 3.6 万 from ten thousand up, digits with separators below. */
function figure(n: number): { value: string; unit: string } {
  return n >= 10_000 ? { value: (n / 10_000).toFixed(1).replace(/\.0$/, ""), unit: "万" } : { value: n.toLocaleString("en-US"), unit: "" };
}

function Figure({ n, unit }: { n: number; unit: string }) {
  // English shows the whole number; “万” is a Chinese grouping.
  const f = useLocale() === "en" ? { value: n.toLocaleString("en-US"), unit: "" } : figure(n);
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="num text-[30px] font-black leading-none tracking-[-0.03em] text-ink xl:text-[36px]">{f.value}</span>
      <span className="text-[14px] text-ink-3">
        {f.unit}
        {unit}
      </span>
    </div>
  );
}

/** The stage columns' rules: one column on phones, two by two from sm, four in a row from lg. */
const STAGE_CELL = [
  "sm:pr-6 lg:pr-6",
  "border-t sm:border-l sm:border-t-0 sm:pl-6 lg:px-6",
  "border-t sm:pr-6 lg:border-l lg:border-t-0 lg:px-6",
  "border-t sm:border-l sm:pl-6 lg:border-t-0 lg:px-6",
];

interface Stage {
  no: string;
  title: string;
  figure: ReactNode;
  text: string;
  note: ReactNode;
}

function stagesOf(stats: SiteStats | null, tr: Tr): Stage[] {
  return [
    {
      no: "01",
      title: tr("采集"),
      figure: stats && <Figure n={stats.sources} unit={tr("个来源")} />,
      text: tr.maybe(ABOUT.steps.collect),
      note: tr("当前跟踪的资讯来源"),
    },
    {
      no: "02",
      title: tr("归并"),
      figure: stats && <Figure n={stats.items} unit={tr("条动态")} />,
      text: tr.maybe(ABOUT.steps.store),
      note: stats && (
        <>
          {tr("过去 24 小时收进")} {stats.day.collected.toLocaleString("en-US")} {tr("条")}
        </>
      ),
    },
    {
      no: "03",
      title: tr("精选"),
      figure: stats && <Figure n={stats.selected} unit={tr("条精选")} />,
      text: tr.maybe(ABOUT.steps.select),
      note: stats && (
        <>
          {tr("过去 24 小时")} {stats.day.selected} {tr("条进了精选")}
        </>
      ),
    },
    {
      no: "04",
      title: tr("成刊"),
      figure: stats && <Figure n={stats.dailies} unit={tr("期日报")} />,
      text: tr.maybe(ABOUT.steps.publish),
      note: tr("也可以用 RSS、API、MCP 订阅"),
    },
  ];
}

const NO_SOURCES: RiverSource[] = [];
function Latest({ item, className = "" }: { item: NonNullable<SiteStats["latest"]>[number] | undefined; className?: string }) {
  const tr = useTr();
  if (!item) return null;
  return (
    <Link to={`/items/${item.id}`} className={`group block ${className}`}>
      <span className="text-[12px] font-semibold tracking-[0.2em] text-accent">{tr("最近精选")}</span>
      <span key={item.id} className="animate-fade-up mt-1.5 block">
        <span className="line-clamp-2 text-[14.5px] font-semibold leading-[1.55] text-ink group-hover:text-accent">{item.title}</span>
        <span className="mt-1 block truncate text-[13px] text-ink-4">{item.source}</span>
      </span>
    </Link>
  );
}

export default function AboutPage() {
  const tr = useTr();
  const { stats, information } = useLoaderData<typeof loader>();
  const filings = useSiteFilings();
  const revalidator = useRevalidator(),
    refresh = useRef(revalidator);
  refresh.current = revalidator;
  useEffect(() => {
    let pending = false;
    const update = () => {
      if (document.visibilityState !== "visible" || pending || refresh.current.state !== "idle") return;
      pending = true;
      void refresh.current.revalidate().finally(() => {
        pending = false;
      });
    };
    const timer = window.setInterval(update, 30_000);
    window.addEventListener("focus", update);
    window.addEventListener("pageshow", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      window.removeEventListener("pageshow", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  const stages = useMemo(() => stagesOf(stats, tr), [stats, tr]);
  const [focus, setFocus] = useState<number | null>(null),
    [at, setAt] = useState(0);
  const shown = useRef(0),
    sources = useMemo(() => stats?.sampleSources ?? NO_SOURCES, [stats]);
  const latest = stats?.latest ?? [];
  const onArrive = useCallback(() => {
    const now = Date.now();
    if (now - shown.current < 2800 || latest.length < 2) return;
    shown.current = now;
    setAt((i) => (i + 1) % latest.length);
  }, [latest.length]);

  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-14 lg:pt-3">
      <PhoneBar back={{ to: "/more", label: tr("我的") }} title={tr("关于 {name}", { name: SITE.name })} />
      <header className="grid items-end gap-8 pt-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:pt-0">
        <div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Kicker>{tr.maybe(ABOUT.kicker)}</Kicker>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event(INTRO_REPLAY_EVENT))}
              className="rounded-full border border-line px-3 py-1 text-[12.5px] text-ink-3 transition-colors hover:border-accent hover:text-accent motion-reduce:hidden"
            >
              ↻ {tr("重看开场动画")}
            </button>
          </div>
          <h1
            data-page-title=""
            className="mt-5 text-[34px] font-black leading-[1.18] tracking-[-0.03em] text-ink [text-wrap:balance] sm:text-[46px] xl:text-[56px] 2xl:text-[64px]"
          >
            {tr.maybe(ABOUT.headline[0])}
            <br />
            <span className="text-accent">{tr.maybe(ABOUT.headline[1])}</span>
          </h1>
          {information === null ? (
            <p role="status" className="mt-5 text-sm text-ink-3">
              {tr("网站资料暂时无法读取，请稍后重试。")}
            </p>
          ) : (
            information.about && (
              <p className="mt-5 max-w-[36em] whitespace-pre-wrap text-[15.5px] leading-[1.85] text-ink-3 xl:text-[17px]">{information.about}</p>
            )
          )}
        </div>
        <div className="flex flex-wrap gap-3 lg:pb-2">
          <Link to="/" className={buttonClass("primary", "lg")}>
            {tr("看今天的精选")} <IconArrowRight size={15} />
          </Link>
          <Link to="/daily" className={buttonClass("secondary", "lg")}>
            {tr("读最新")}
            {tr.subject("日报")}
          </Link>
        </div>
      </header>

      <section aria-labelledby="how" aria-busy={revalidator.state !== "idle"} className="mt-10 xl:mt-14">
        <h2 id="how" className="sr-only">
          {SITE.name} {tr("怎么工作")}
        </h2>
        {stats === null && (
          <p role="status" className="mb-4 flex items-center gap-3 text-sm text-ink-3">
            {tr("统计暂时无法读取，请稍后重试。")}
            <button
              type="button"
              disabled={revalidator.state !== "idle"}
              onClick={() => void revalidator.revalidate()}
              className="text-accent disabled:opacity-50"
            >
              {tr("重试")}
            </button>
          </p>
        )}
        <p className="mb-3 text-[13px] font-semibold tracking-wide text-ink-3">{tr("流程示意")}</p>
        {sources.length > 0 ? (
          <SignalRiver sources={sources} focus={focus} onArrive={onArrive} className="h-[230px] sm:h-[300px] lg:h-[360px] 2xl:h-[420px]">
            <Latest item={latest[at % Math.max(1, latest.length)]} className="absolute left-[75%] top-[calc(42%+42px)] hidden w-[25%] px-6 lg:block" />
          </SignalRiver>
        ) : (
          stats !== null && <p className="py-8 text-sm text-ink-3">{tr("暂无可展示的来源。")}</p>
        )}
        <p className="sr-only">{tr("来源的报道经过整理与精选，再编入日报。")}</p>
        <Latest item={latest[at % Math.max(1, latest.length)]} className={`mt-2 border-t border-line pt-4 ${sources.length ? "lg:hidden" : ""}`} />
        <ol className="mt-4 grid grid-cols-1 border-t border-line-strong sm:grid-cols-2 lg:mt-0 lg:grid-cols-4">
          {stages.map((s, i) => (
            <li
              key={s.no}
              onPointerEnter={() => setFocus(i)}
              onPointerLeave={() => setFocus(null)}
              onFocus={() => setFocus(i)}
              onBlur={() => setFocus(null)}
              className={`border-line py-6 ${STAGE_CELL[i]}`}
            >
              <div className="flex items-baseline gap-2.5">
                <span className="num text-[13px] font-bold tracking-[0.12em] text-accent">{s.no}</span>
                <h3 className="text-[17px] font-bold text-ink">{s.title}</h3>
              </div>
              {s.figure && <div className="mt-4">{s.figure}</div>}
              <p className="mt-3 text-[15px] leading-[1.8] text-ink-3">{s.text}</p>
              {s.note && <p className="mt-3 text-[13px] text-ink-4">{s.note}</p>}
            </li>
          ))}
        </ol>
      </section>

      {information && (information.contactEmail || information.contactPage) && (
        <section className="mt-10 rounded-card border border-line p-5" aria-labelledby="about-contact">
          <h2 id="about-contact" className="text-lg font-semibold">
            {tr("联系我们")}
          </h2>
          <div className="mt-3 flex flex-col items-start gap-3 text-sm">
            {information.contactEmail && (
              <a href={`mailto:${information.contactEmail}`} className="break-all text-accent hover:underline">
                {information.contactEmail}
              </a>
            )}
            {information.contactPage && (
              <a href={information.contactPage} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                {tr("联系页面 ↗")}
              </a>
            )}
          </div>
        </section>
      )}

      <p className="mt-16 well rounded-card px-5 py-4 text-[14px] leading-[1.85] text-ink-3">
        {tr.maybe(ABOUT.copyright)}
        <Link to="/feedback" className="text-accent hover:underline">
          {tr("反馈页")}
        </Link>
        {tr("联系我们。")}
      </p>

      {filings.newsLicense && (
        <p className="mt-4 text-[13.5px] text-ink-4">
          {tr("互联网新闻信息服务许可证：")}
          {filings.newsLicense}
        </p>
      )}

      <footer className="mt-8 flex flex-wrap items-center justify-end gap-3 border-t border-line pt-5 text-[13.5px] text-ink-4">
        <nav className="flex gap-5" aria-label={tr("规则与隐私")}>
          <Link to="/terms" className="transition-colors hover:text-accent">
            {tr("使用规则")}
          </Link>
          <Link to="/privacy" className="transition-colors hover:text-accent">
            {tr("隐私说明")}
          </Link>
        </nav>
      </footer>
    </div>
  );
}
