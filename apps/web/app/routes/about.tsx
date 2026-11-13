import { INTRO_REPLAY_EVENT } from "../components/shell/Intro";
import { PhoneBar } from "../components/shell/PhoneBar";
import { useTr } from "../i18n";
import { PipelineFlow } from "../features/about/PipelineFlow";
import { apiFetch } from "../lib/http.ts";
import { useCallback, useEffect, useRef, useState } from "react";
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
  const [at, setAt] = useState(0);
  const shown = useRef(0);
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
        <PipelineFlow
          stats={stats}
          onArrive={onArrive}
          notice={
            stats === null ? (
              <p role="status" className="mt-5 flex items-center gap-3 text-sm text-ink-3">
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
            ) : (
              stats.sources === 0 && <p className="mt-5 text-sm text-ink-3">{tr("暂无可展示的来源。")}</p>
            )
          }
        />
        <Latest item={latest[at % Math.max(1, latest.length)]} className="mt-6 border-t border-line pt-4" />
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
