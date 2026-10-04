import { useMemo, type ReactNode } from "react";
import { Link, useLoaderData } from "react-router";
import type { SiteStats } from "@amp/contracts/site";
import { createPublicClient, publicSchemas } from "@amp/api-client/public";
import { apiBaseFor } from "../../api-target.ts";
import { contractResult } from "../lib/api.server";
import { ABOUT, SITE, withSubject } from "@amp/industry/site";
import { organizationLd, pageMeta } from "../lib/seo";
import { Kicker } from "../components/ui/Kicker";
import { buttonClass } from "../components/ui/Controls";
import { IconArrowRight } from "../components/icons";

/** Shared caches may keep this page for five minutes. */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

export async function loader({ request }: { request: Request }) {
  const stats = await createPublicClient({ baseUrl: apiBaseFor("/api/site/stats") })
    .GET("/api/site/stats", {
      headers: { accept: "application/json", "x-amp-ssr": "1" },
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
    })
    .then((result) => contractResult(result, publicSchemas.SiteStats))
    .catch(() => null);
  return { stats };
}

export function meta() {
  return pageMeta({
    title: "关于",
    description: `关于 ${SITE.name}：${SITE.description}`,
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
  const f = figure(n);
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="num text-[30px] font-black leading-none tracking-[-0.03em] text-ink xl:text-[36px]">{f.value}</span>
      <span className="text-[13px] text-ink-3">
        {f.unit}
        {unit}
      </span>
    </div>
  );
}

const KIND_ORDER: Array<[string, string]> = [
  ["rss", "RSS"],
  ["web_list", "网页"],
  ["mp_account", "公众号"],
  ["json_list", "接口"],
];

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

function stagesOf(stats: SiteStats | null): Stage[] {
  const kinds = stats
    ? KIND_ORDER.filter(([k]) => stats.sourceKinds[k])
        .map(([k, label]) => `${label} ${stats.sourceKinds[k]}`)
        .join(" · ")
    : null;
  return [
    {
      no: "01",
      title: "采集",
      figure: stats && <Figure n={stats.sources} unit="个信源" />,
      text: ABOUT.steps.collect,
      note: kinds,
    },
    {
      no: "02",
      title: "收录",
      figure: stats && <Figure n={stats.items} unit="条动态" />,
      text: ABOUT.steps.store,
      note: stats && <>过去 24 小时收进 {stats.day.collected.toLocaleString("en-US")} 条</>,
    },
    {
      no: "03",
      title: "精选",
      figure: stats && <Figure n={stats.selected} unit="条精选" />,
      text: ABOUT.steps.select,
      note: stats && <>过去 24 小时 {stats.day.selected} 条进了精选</>,
    },
    {
      no: "04",
      title: "成刊",
      figure: stats && <Figure n={stats.dailies} unit="期日报" />,
      text: ABOUT.steps.publish,
      note: "也可以用 RSS、API、MCP 订阅",
    },
  ];
}

export default function AboutPage() {
  const { stats } = useLoaderData<typeof loader>();
  const stages = useMemo(() => stagesOf(stats), [stats]);

  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-14 pt-6 lg:pt-3">
      <header className="grid items-end gap-8 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div>
          <Kicker>{ABOUT.kicker}</Kicker>
          <h1 className="mt-5 text-[34px] font-black leading-[1.18] tracking-[-0.03em] text-ink [text-wrap:balance] sm:text-[46px] xl:text-[56px] 2xl:text-[64px]">
            {ABOUT.headline[0]}
            <br />
            <span className="text-accent">{ABOUT.headline[1]}</span>
          </h1>
          <p className="mt-5 max-w-[36em] text-[15.5px] leading-[1.85] text-ink-3 xl:text-[17px]">
            {ABOUT.lead.split("{sources}").map((part, i) => (
              <span key={i}>
                {i > 0 && (stats ? <span className="num font-semibold text-ink">{stats.sources}</span> : "上百")}
                {part}
              </span>
            ))}
          </p>
        </div>
        <div className="flex flex-wrap gap-3 lg:pb-2">
          <Link to="/" prefetch="intent" className={buttonClass("primary", "lg")}>
            看今天的精选 <IconArrowRight size={15} />
          </Link>
          <Link to="/daily" prefetch="intent" className={buttonClass("secondary", "lg")}>
            读最新{withSubject("日报")}
          </Link>
        </div>
      </header>

      <section aria-labelledby="how" className="mt-10 xl:mt-14">
        <h2 id="how" className="sr-only">
          {SITE.name} 怎么工作
        </h2>
        <ol className="grid grid-cols-1 border-t border-line-strong sm:grid-cols-2 lg:grid-cols-4">
          {stages.map((s, i) => (
            <li key={s.no} className={`border-line py-6 ${STAGE_CELL[i]}`}>
              <div className="flex items-baseline gap-2.5">
                <span className="num text-[12px] font-bold tracking-[0.12em] text-accent">{s.no}</span>
                <h3 className="text-[17px] font-bold text-ink">{s.title}</h3>
              </div>
              {s.figure && <div className="mt-4">{s.figure}</div>}
              <p className="mt-3 text-[14px] leading-[1.8] text-ink-3">{s.text}</p>
              {s.note && <p className="mt-3 text-[12px] text-ink-4">{s.note}</p>}
            </li>
          ))}
        </ol>
      </section>

      <p className="mt-16 well rounded-card px-5 py-4 text-[13px] leading-[1.85] text-ink-3">
        {ABOUT.copyright}
        <Link to="/feedback" className="text-accent hover:underline">
          反馈页
        </Link>
        联系我们。
      </p>

      <footer className="mt-8 flex flex-wrap items-center justify-end gap-3 border-t border-line pt-5 text-[12.5px] text-ink-4">
        <nav className="flex gap-5" aria-label="规则与隐私">
          <Link to="/terms" className="transition-colors hover:text-accent">
            使用规则
          </Link>
          <Link to="/privacy" className="transition-colors hover:text-accent">
            隐私说明
          </Link>
        </nav>
      </footer>
    </div>
  );
}
