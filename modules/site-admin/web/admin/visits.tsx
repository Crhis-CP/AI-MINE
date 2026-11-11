// 访问概况 (TASK-0571, redrawn in TASK-0623 after the Owner's preview “更酷炫、更动态、更 3D、更有科技感”): the site's own
// visit statistics as a dark, moving screen — today's visitors counting up, a turning globe of the countries readers
// read about, a glowing 30-day line, raised columns for page views, and ranked lists that fill in. Counts only; the
// page never sees an address, a browser string or a visitor key. Every number drawn is also plain text on the page,
// and everything stands still when the reader asks for reduced motion.
import { apiFetch } from "@amp/web/extension";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useRevalidator } from "react-router";
import { SITE } from "@amp/industry/site";
import { schemas as privateSchemas } from "@amp/contracts/http/private";
import type { z } from "zod";
import type { LoaderFunctionArgs } from "react-router";
import { adminGet } from "@amp/web/admin-extension.server";
import { VisitGlobe, globeCountries } from "@amp/web/admin-globe";

type Overview = z.infer<typeof privateSchemas.VisitOverview>;
type Span = "week" | "month";
export const meta = () => [{ title: `访问概况 · ${SITE.name} 后台` }];
export async function loader({ request }: LoaderFunctionArgs) {
  const path = "/api/admin/visits";
  return privateSchemas.VisitOverview.parse(
    await adminGet(request, path, (url, init) => apiFetch(path, { baseUrl: new URL(url).origin, headers: init.headers, signal: init.signal, method: "GET" })),
  );
}

const number = (value: number | null | undefined) => (value === null || value === undefined ? "—" : Math.round(value).toLocaleString("zh-CN"));
const monthDay = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const ROUTES: Record<string, string> = {
  "/": "首页",
  "/all": "全部矿业动态",
  "/hot": "热点",
  "/items/:id": "文章",
  "/items/:id/original": "文章原文",
  "/story/:id": "事件脉络",
  "/daily": "日报",
  "/daily/:key": "日报（某一期）",
  "/daily/archive": "日报往期",
  "/weekly": "周报",
  "/weekly/:key": "周报（某一期）",
  "/monthly": "月报",
  "/monthly/:key": "月报（某一期）",
  "/topics": "专题",
  "/topics/:slug": "专题页",
  "/topics/:slug/page/:page": "专题页（翻页）",
  "/metals": "金属价格",
  "/policies": "法规政策动态",
  "/policies/:id": "法规文书",
  "/policies/:id/history": "法规文书历史",
  "/policies/reports": "法规周报月报",
  "/policies/reports/:id": "法规周报月报（某一期）",
  "/policy-threads/:id": "法规脉络",
  "/about": "关于",
  "/terms": "使用规则",
  "/privacy": "隐私说明",
  "/changelog": "更新日志",
  "/feedback": "反馈",
  "/more": "我的",
  "/starred": "收藏",
  "/agent": "给 AI 助手",
};
const DEVICES: Record<string, string> = { phone: "手机", tablet: "平板", desktop: "电脑" };
/** How often the open page reads the figures again. */
const REFRESH_MS = 60_000;

// The screen's own palette: the site's gold on near-black. Scoped to this page by the variables below.
const NIGHT = {
  "--v-bg": "#0d0b08",
  "--v-panel": "rgba(30,25,18,.72)",
  "--v-line": "rgba(226,176,79,.16)",
  "--v-ink": "#f5efe2",
  "--v-ink2": "#c9bfab",
  "--v-ink3": "#8f8573",
  "--v-gold": "#e2b04f",
  "--v-gold2": "#f6d48a",
} as CSSProperties;
const CSS = `
.vz{color:var(--v-ink);background:radial-gradient(900px 500px at 50% -80px,rgba(226,176,79,.16),transparent 70%),radial-gradient(700px 500px at 100% 40%,rgba(111,214,232,.06),transparent 70%),var(--v-bg)}
.vz-grid{background-image:linear-gradient(rgba(226,176,79,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(226,176,79,.045) 1px,transparent 1px);background-size:44px 44px;mask-image:radial-gradient(ellipse at 50% 20%,#000 20%,transparent 75%)}
.vz-card{position:relative;background:var(--v-panel);border:1px solid var(--v-line);border-radius:16px;box-shadow:0 1px 0 rgba(255,255,255,.05) inset,0 18px 40px -24px rgba(0,0,0,.9);animation:vz-rise .7s cubic-bezier(.25,1,.5,1) both;transition:transform .25s cubic-bezier(.25,1,.5,1),border-color .25s}
.vz-card:hover{border-color:rgba(226,176,79,.45)}
.vz-card::after{content:"";position:absolute;left:18px;right:18px;top:-1px;height:1px;background:linear-gradient(90deg,transparent,rgba(246,212,138,.7),transparent)}
.vz-big{background:linear-gradient(180deg,#fff3d6,var(--v-gold) 60%,#8a5a17);-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 0 22px rgba(226,176,79,.35))}
.vz-bar{background:linear-gradient(90deg,rgba(226,176,79,.38),rgba(226,176,79,.06));border-left:2px solid var(--v-gold);border-radius:3px;transition:width 1.1s cubic-bezier(.25,1,.5,1)}
.vz-live{box-shadow:0 0 0 0 rgba(95,211,154,.6);animation:vz-ping 1.8s infinite}
.vz-draw{stroke-dasharray:1;stroke-dashoffset:1;animation:vz-draw 1.8s cubic-bezier(.25,1,.5,1) .3s forwards}
.vz-fade{animation:vz-fade 1s ease 1.3s both}
.vz-grow{transform:scaleY(0);transform-box:fill-box;transform-origin:50% 100%;animation:vz-grow .9s cubic-bezier(.25,1,.5,1) forwards}
.vz-ring{transition:stroke-dashoffset 1.4s cubic-bezier(.25,1,.5,1) .3s}
.vz-pulse{animation:vz-pulse 2s ease-in-out infinite}
@keyframes vz-rise{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
@keyframes vz-ping{to{box-shadow:0 0 0 9px rgba(95,211,154,0)}}
@keyframes vz-draw{to{stroke-dashoffset:0}}
@keyframes vz-fade{from{opacity:0}to{opacity:1}}
@keyframes vz-grow{to{transform:scaleY(1)}}
@keyframes vz-pulse{0%,100%{r:6px;opacity:.35}50%{r:13px;opacity:.12}}
@media (prefers-reduced-motion:reduce){.vz *{animation:none!important;transition:none!important}.vz-draw{stroke-dashoffset:0}.vz-grow{transform:none}}
`;

/** A number that runs up to its value when it first appears, and from the old value when the figures refresh. */
function CountUp({ value }: { value: number | null }) {
  const [shown, setShown] = useState(value);
  const from = useRef(0);
  useEffect(() => {
    if (value === null || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(value);
      return;
    }
    const start = from.current,
      began = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - began) / 1400),
        eased = 1 - (1 - progress) ** 4;
      setShown(start + (value - start) * eased);
      if (progress < 1) frame = requestAnimationFrame(tick);
      else from.current = value;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  // The server renders the real number, so the page reads correctly before any script runs.
  return <span className="num">{number(shown)}</span>;
}

function Panel({
  title,
  note,
  right,
  delay = 0,
  tilt,
  className = "",
  children,
}: {
  title?: ReactNode;
  note?: ReactNode;
  right?: ReactNode;
  delay?: number;
  tilt?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  return (
    <section
      ref={ref}
      className={`vz-card min-w-0 p-[18px] sm:px-5 ${className}`}
      style={{ animationDelay: `${delay}s` }}
      onPointerMove={
        tilt
          ? (event) => {
              const el = ref.current;
              if (!el || event.pointerType !== "mouse" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
              const box = el.getBoundingClientRect();
              const x = (event.clientX - box.left) / box.width - 0.5,
                y = (event.clientY - box.top) / box.height - 0.5;
              el.style.transform = `perspective(900px) rotateY(${x * 7}deg) rotateX(${-y * 7}deg) translateZ(4px)`;
            }
          : undefined
      }
      onPointerLeave={
        tilt
          ? () => {
              if (ref.current) ref.current.style.transform = "";
            }
          : undefined
      }
    >
      {(title || right) && (
        <header className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="text-[14.5px] font-semibold">{title}</h2>
          <span className="text-[12px] text-[color:var(--v-ink3)]">{right ?? note}</span>
        </header>
      )}
      {children}
    </section>
  );
}

function Switch({ value, onChange }: { value: Span; onChange: (value: Span) => void }) {
  return (
    <fieldset className="inline-flex rounded-full border border-white/10 bg-white/5 p-[3px]">
      <legend className="sr-only">时间范围</legend>
      {(
        [
          ["week", "近 7 天"],
          ["month", "近 30 天"],
        ] as const
      ).map(([key, label]) => (
        <button
          key={key}
          type="button"
          aria-pressed={value === key}
          onClick={() => onChange(key)}
          className={`rounded-full px-3.5 py-1 text-[13px] ${value === key ? "font-bold text-[#2a1d06] shadow-[0_0_18px_rgba(226,176,79,.45)]" : "text-[color:var(--v-ink2)]"}`}
          style={value === key ? { background: "linear-gradient(180deg,var(--v-gold2),var(--v-gold))" } : undefined}
        >
          {label}
        </button>
      ))}
    </fieldset>
  );
}

function Ranked({ rows, empty }: { rows: Array<{ key: string; label: ReactNode; tag?: string | null; views: number }>; empty: string }) {
  // Bars start empty and fill once mounted; without script they are simply full.
  const [filled, setFilled] = useState(false);
  useEffect(() => setFilled(true), []);
  if (!rows.length) return <p className="py-6 text-center text-[13px] text-[color:var(--v-ink3)]">{empty}</p>;
  const top = rows[0]!.views || 1;
  return (
    <ol className="text-[13.5px]">
      {rows.map((row) => (
        <li key={row.key} className="relative grid grid-cols-[1fr_auto] items-center gap-2.5 py-[7px]">
          <span aria-hidden="true" className="vz-bar absolute inset-y-1 left-0" style={{ width: filled ? `${Math.max(3, (row.views / top) * 100)}%` : 0 }} />
          <span className="relative min-w-0 truncate pl-[9px]">
            {row.label}
            {row.tag && <span className="ml-1.5 text-[12px] text-[color:var(--v-ink3)]">{row.tag}</span>}
          </span>
          <span className="num relative font-bold text-[color:var(--v-gold2)]">{number(row.views)}</span>
        </li>
      ))}
    </ol>
  );
}

/** Daily visitors as one glowing line that draws itself; the point under the pointer shows that day's figures. */
function Trend({ days }: { days: Overview["days"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640,
    H = 250,
    left = 34,
    right = 10,
    top = 18,
    bottom = 24;
  const known = days.map((d, i) => ({ ...d, i })).filter((d) => d.visitors !== null);
  if (known.length < 2) return <p className="py-10 text-center text-[13px] text-[color:var(--v-ink3)]">访客数每 10 分钟汇总一次，满两天后这里出现曲线。</p>;
  const peak = Math.max(1, ...known.map((d) => d.visitors!));
  const step = 10 ** Math.floor(Math.log10(peak * 1.25)),
    max = Math.ceil((peak * 1.25) / step) * step;
  const x = (i: number) => left + ((W - left - right) * i) / Math.max(1, days.length - 1),
    y = (v: number) => top + (H - top - bottom) * (1 - v / max);
  const path = `M${known.map((d) => `${x(d.i)},${y(d.visitors!)}`).join(" L")}`;
  const last = known.at(-1)!,
    first = known[0]!;
  const at = hover === null ? null : known.reduce((best, d) => (Math.abs(d.i - hover) < Math.abs(best.i - hover) ? d : best), last);
  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full overflow-visible"
        role="img"
        aria-label="近 30 天每天的访客"
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setHover((((event.clientX - box.left) / box.width) * W - left) / ((W - left - right) / Math.max(1, days.length - 1)));
        }}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="vz-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="rgba(226,176,79,.42)" />
            <stop offset="1" stopColor="rgba(226,176,79,0)" />
          </linearGradient>
        </defs>
        {[0, max / 2, max].map((g) => (
          <g key={g}>
            <line x1={left} x2={W - right} y1={y(g)} y2={y(g)} stroke="rgba(255,255,255,.07)" />
            <text x={left - 6} y={y(g) + 4} textAnchor="end" className="num fill-[color:var(--v-ink3)] text-[11px]">
              {number(g)}
            </text>
          </g>
        ))}
        {first.i > 2 && (
          <>
            <line x1={x(first.i - 0.5)} x2={x(first.i - 0.5)} y1={top} y2={H - bottom} stroke="rgba(226,176,79,.3)" strokeDasharray="3 4" />
            <text x={(x(0) + x(first.i - 0.5)) / 2} y={y(max / 2) - 6} textAnchor="middle" className="fill-[color:var(--v-ink3)] text-[11px]">
              {monthDay(first.day)} 开始统计
            </text>
          </>
        )}
        <path className="vz-fade" d={`${path} L${x(last.i)},${y(0)} L${x(first.i)},${y(0)}Z`} fill="url(#vz-area)" />
        <path
          className="vz-draw"
          pathLength={1}
          d={path}
          fill="none"
          stroke="#f0c366"
          strokeWidth={2.5}
          strokeLinejoin="round"
          style={{ filter: "drop-shadow(0 0 6px rgba(226,176,79,.9))" }}
        />
        <circle className="vz-pulse" cx={x(last.i)} cy={y(last.visitors!)} r={9} fill="#e2b04f" opacity={0.25} />
        <circle cx={x(last.i)} cy={y(last.visitors!)} r={4.5} fill="#fff3d6" />
        <text x={x(last.i)} y={top - 6} textAnchor="end" className="num fill-[color:var(--v-ink)] text-[12.5px] font-bold">
          今天 {number(last.visitors)}
        </text>
        {days.map((d, i) =>
          i === 0 || i === days.length - 1 || (i % 5 === 4 && days.length - i > 3) ? (
            <text
              key={d.day}
              x={x(i)}
              y={H - 6}
              textAnchor={i === 0 ? "start" : i === days.length - 1 ? "end" : "middle"}
              className="num fill-[color:var(--v-ink3)] text-[11px]"
            >
              {monthDay(d.day)}
            </text>
          ) : null,
        )}
        {at && (
          <g>
            <line x1={x(at.i)} x2={x(at.i)} y1={top} y2={H - bottom} stroke="rgba(246,212,138,.6)" />
            <circle cx={x(at.i)} cy={y(at.visitors!)} r={5} fill="#0d0b08" stroke="#f6d48a" strokeWidth={2} />
          </g>
        )}
      </svg>
      {at && (
        <div
          className="pointer-events-none absolute rounded-lg border border-[rgba(226,176,79,.5)] bg-[#1c1710] px-2.5 py-1.5 text-[12.5px] shadow-[0_8px_24px_rgba(0,0,0,.6)]"
          style={{ left: `min(calc(100% - 120px), ${(x(at.i) / W) * 100}% + 12px)`, top: `${Math.max(0, (y(at.visitors!) / H) * 100 - 22)}%` }}
        >
          <b className="num text-[color:var(--v-gold2)]">{number(at.visitors)} 人</b> · <span className="num">{number(at.page_views)}</span> 页
          <br />
          <span className="text-[color:var(--v-ink3)]">{monthDay(at.day)}</span>
        </div>
      )}
    </div>
  );
}

/** Page views of the last two weeks as raised columns; the bright strip on each top is the share read in English. */
function Pillars({ days }: { days: Overview["days"] }) {
  const data = days.slice(-14);
  const W = 520,
    H = 250,
    left = 10,
    right = 22,
    top = 30,
    bottom = 30,
    dx = 9,
    dy = 7;
  const max = Math.max(1, ...data.map((d) => d.page_views)),
    slot = (W - left - right) / Math.max(1, data.length),
    face = slot * 0.56,
    base = H - bottom,
    busiest = data.reduce((best, d, i) => (d.page_views > data[best]!.page_views ? i : best), 0);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full overflow-visible" role="img" aria-label="近 14 天每天的浏览量">
      <defs>
        <linearGradient id="vz-front" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e9bd63" />
          <stop offset="1" stopColor="#7c5214" />
        </linearGradient>
        <linearGradient id="vz-side" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#9c6a1e" />
          <stop offset="1" stopColor="#3f2a0b" />
        </linearGradient>
      </defs>
      <path
        d={`M${left - 4},${base} L${W - right + 4},${base} L${W - right + 4 + dx * 2},${base - dy * 2} L${left - 4 + dx * 2},${base - dy * 2}Z`}
        fill="rgba(226,176,79,.07)"
        stroke="rgba(226,176,79,.2)"
      />
      {data.map((d, i) => {
        const tall = ((H - bottom - top - dy) * d.page_views) / max,
          x = left + slot * i + (slot - face) / 2,
          y = base - tall,
          english = d.page_views ? Math.min(1, d.english_views / d.page_views) : 0,
          latest = i === data.length - 1;
        return (
          <g key={d.day}>
            <title>{`${monthDay(d.day)}：${number(d.page_views)} 页，其中英文页 ${number(d.english_views)}`}</title>
            {tall > 0 && (
              <g className="vz-grow" style={{ animationDelay: `${0.4 + i * 0.05}s`, filter: latest ? "drop-shadow(0 0 10px rgba(226,176,79,.8))" : undefined }}>
                <rect x={x} y={y} width={face} height={tall} fill="url(#vz-front)" />
                <path d={`M${x + face},${y} l${dx},${-dy} v${tall} l${-dx},${dy}Z`} fill="url(#vz-side)" />
                <path d={`M${x},${y} l${dx},${-dy} h${face} l${-dx},${dy}Z`} fill="#f8e0a8" />
                {english > 0 && <path d={`M${x},${y} l${dx},${-dy} h${face * english} l${-dx},${dy}Z`} fill="#6fd6e8" />}
              </g>
            )}
            {(i % 2 === (data.length - 1) % 2 || latest) && (
              <text x={x + face / 2} y={H - 10} textAnchor="middle" className="num fill-[color:var(--v-ink3)] text-[11px]">
                {monthDay(d.day)}
              </text>
            )}
            {(latest || i === busiest) && d.page_views > 0 && (
              <text x={x + face / 2 + dx / 2} y={y - dy - 6} textAnchor="middle" className="num fill-[color:var(--v-ink)] text-[12px] font-bold">
                {number(d.page_views)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function Rings({ devices }: { devices: Overview["devices"] }) {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => setDrawn(true), []);
  const total = devices.reduce((sum, d) => sum + d.views, 0);
  if (!total) return <p className="py-4 text-[13px] text-[color:var(--v-ink3)]">近 30 天还没有记录。</p>;
  const around = 2 * Math.PI * 30;
  return (
    <div className="mt-1.5 flex justify-between gap-2.5">
      {(["phone", "desktop", "tablet"] as const).map((key) => {
        const share = (devices.find((d) => d.device === key)?.views ?? 0) / total;
        return (
          <div key={key} className="flex-1 text-center">
            <svg viewBox="0 0 74 74" className="mx-auto h-[74px] w-[74px]" role="img" aria-label={`${DEVICES[key]} ${Math.round(share * 100)}%`}>
              <circle cx={37} cy={37} r={30} fill="none" stroke="rgba(255,255,255,.08)" strokeWidth={6} />
              <circle
                className="vz-ring"
                cx={37}
                cy={37}
                r={30}
                fill="none"
                stroke="#e9bd63"
                strokeWidth={6}
                strokeLinecap="round"
                strokeDasharray={around}
                strokeDashoffset={drawn ? around * (1 - share) : around}
                transform="rotate(-90 37 37)"
                style={{ filter: "drop-shadow(0 0 5px rgba(226,176,79,.7))" }}
              />
              <text x={37} y={42} textAnchor="middle" className="num fill-[color:var(--v-ink)] text-[15px] font-bold">
                {Math.round(share * 100)}%
              </text>
            </svg>
            <div className="mt-0.5 text-[12px] text-[color:var(--v-ink2)]">{DEVICES[key]}</div>
          </div>
        );
      })}
    </div>
  );
}

function pageLabel(page: Overview["pages"]["week"][number]) {
  const name = ROUTES[page.route] ?? page.route;
  return (
    <a href={page.path} target="_blank" rel="noopener noreferrer" className="hover:text-[color:var(--v-gold2)]">
      {page.title ? `${page.title}` : page.path === page.route ? name : `${name} ${page.path}`}
    </a>
  );
}
function interestPageLabel(row: { key: string; label: string }) {
  return row.key.startsWith("/topics/") && row.label !== row.key ? `专题 · ${row.label}` : (ROUTES[row.key] ?? row.label);
}

export default function Visits({ loaderData: o }: { loaderData: Overview }) {
  const [span, setSpan] = useState<Span>("week");
  const revalidator = useRevalidator();
  const revalidate = useRef(revalidator.revalidate);
  revalidate.current = revalidator.revalidate;
  useEffect(() => {
    const timer = setInterval(() => document.visibilityState === "visible" && void revalidate.current(), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  const words = span === "week" ? "近 7 天" : "近 30 天";
  const interest = o.interest?.[span];
  const countries = (interest?.country ?? []).map((row) => ({ code: row.key, label: row.label, value: row.views }));
  const perVisitor = o.cards.today.visitors ? o.cards.today.page_views / o.cards.today.visitors : null;
  const week = o.days.slice(-7);
  const sparkMax = Math.max(1, ...week.map((d) => d.visitors ?? 0));
  const empty = `${words}还没有记录。`;
  return (
    <div className="mx-auto w-full max-w-[1320px] px-3 pb-24 pt-4 sm:px-6 lg:px-8 lg:pt-6">
      <style>{CSS}</style>
      <div className="vz relative overflow-hidden rounded-[22px] px-3.5 pb-10 pt-5 sm:px-7 sm:pt-7" style={NIGHT} data-visits-screen>
        <div aria-hidden="true" className="vz-grid pointer-events-none absolute inset-0" />
        <header className="relative mb-[18px] flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[22px] font-bold tracking-[.02em] sm:text-[24px]">访问概况</h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[12.5px] text-[color:var(--v-ink3)]">
              <span className="inline-flex items-center gap-1.5 text-[#5fd39a]">
                <i className="vz-live h-[7px] w-[7px] rounded-full bg-[#5fd39a]" />
                每分钟自动更新
              </span>
              <span>· {o.since ? `统计自 ${o.since} 起` : "还没有访问记录"} · 只有汇总数字，没有任何访客信息</span>
            </p>
          </div>
          <Switch value={span} onChange={setSpan} />
        </header>

        <div className="relative grid gap-3.5 lg:grid-cols-[1fr_1.25fr_1fr]">
          <Panel tilt>
            <div className="text-[13.5px] text-[color:var(--v-ink2)]">今天来了多少人</div>
            <div className="vz-big mb-1.5 mt-2.5 text-[72px] font-extrabold leading-none tracking-[-.03em] sm:text-[84px]">
              <CountUp value={o.cards.today.visitors} />
            </div>
            <p className="text-[13px] text-[color:var(--v-ink2)]">
              昨天全天 <span className="num">{number(o.cards.yesterday.visitors)}</span> 人 · 近 7 天平均{" "}
              <span className="num">{number(o.cards.week_average.visitors)}</span> 人
            </p>
            <svg viewBox="0 0 300 40" className="mt-3.5 block h-10 w-full" role="img" aria-label="最近 7 天每天的访客">
              <path
                d={`M${week.map((d, i) => `${4 + (292 * i) / Math.max(1, week.length - 1)},${35 - (28 * (d.visitors ?? 0)) / sparkMax}`).join(" L")}`}
                fill="none"
                stroke="#e2b04f"
                strokeWidth={2}
                strokeLinejoin="round"
                style={{ filter: "drop-shadow(0 0 4px rgba(226,176,79,.8))" }}
              />
            </svg>
            <div className="text-[11.5px] text-[color:var(--v-ink3)]">最近 7 天</div>
            <dl className="mt-[18px] grid grid-cols-2 gap-2.5">
              <div className="border-t border-white/10 pt-2.5">
                <dd className="text-[26px] font-bold">
                  <CountUp value={o.cards.today.page_views} />
                </dd>
                <dt className="text-[12px] text-[color:var(--v-ink3)]">今天看了多少页{perVisitor ? ` · 人均 ${perVisitor.toFixed(1)} 页` : ""}</dt>
              </div>
              <div className="border-t border-white/10 pt-2.5">
                <dd className="text-[26px] font-bold">
                  <CountUp value={o.cards.week_average.visitors} />
                </dd>
                <dt className="text-[12px] text-[color:var(--v-ink3)]">近 7 天平均每天来的人</dt>
              </div>
            </dl>
          </Panel>

          <Panel title="读者在看哪些国家的矿业" note={`${words} · 可拖动旋转`} delay={0.08} className="flex min-h-[400px] flex-col">
            <div className="min-h-[300px] flex-1">
              <VisitGlobe points={countries} label={`${words}读者读得最多的国家和地区`} />
            </div>
            {!globeCountries(countries).length && (
              <p className="text-center text-[12.5px] text-[color:var(--v-ink3)]">有了读者兴趣记录后，光柱会立在读得最多的国家上。</p>
            )}
          </Panel>

          <div className="flex flex-col gap-3.5">
            <Panel tilt delay={0.14} className="flex-1">
              <div className="text-[13px] text-[color:var(--v-ink2)]">本月来过的人（月活）</div>
              <div className="mt-1 text-[38px] font-extrabold leading-[1.1]">
                <CountUp value={o.cards.this_month.visitors} />
              </div>
              <p className="mt-1 text-[12.5px] text-[color:var(--v-ink3)]">
                上月 <span className="num">{number(o.cards.last_month.visitors)}</span> 人 · 本月共{" "}
                <span className="num">{number(o.cards.this_month.page_views)}</span> 页
              </p>
            </Panel>
            <Panel title="用什么设备看" note="近 30 天" delay={0.2} className="flex-1">
              <Rings devices={o.devices} />
            </Panel>
          </div>
        </div>

        <div className="relative mt-3.5 grid gap-3.5 lg:grid-cols-[1.25fr_1fr]">
          <Panel title="每天的访客" note="近 30 天 · 人 · 移上去看当天数字" delay={0.26}>
            <Trend days={o.days} />
          </Panel>
          <Panel title="每天的浏览量" note="近 14 天 · 页 · 顶上亮色是英文页占比" delay={0.32}>
            <Pillars days={o.days} />
          </Panel>
        </div>

        <div className="relative mt-3.5 grid gap-3.5 lg:grid-cols-[1.3fr_1fr_1fr]">
          <Panel title="读得最多的页面" note={`${words} · 次`} delay={0.38}>
            <Ranked empty={empty} rows={o.pages[span].slice(0, 8).map((page) => ({ key: page.path, label: pageLabel(page), views: page.views }))} />
          </Panel>
          <Panel title="哪些栏目最常打开" note="近 30 天 · 次" delay={0.44}>
            <Ranked
              empty="近 30 天还没有记录。"
              rows={o.sections.slice(0, 8).map((row) => ({ key: row.route, label: ROUTES[row.route] ?? row.route, views: row.views }))}
            />
          </Panel>
          <Panel title="从哪里来" note={`${words} · 次`} delay={0.5}>
            <Ranked empty={empty} rows={o.referrers[span].slice(0, 6).map((row) => ({ key: row.host, label: row.host, views: row.views }))} />
            <p className="mt-2 text-[12px] leading-relaxed text-[color:var(--v-ink3)]">
              从微信、收藏夹或直接输入网址打开的，浏览器不告诉我们来源，所以不在这里。
            </p>
          </Panel>
        </div>

        <Panel title="每月来过的人" note="近 12 个月 · 人" delay={0.54} className="relative mt-3.5">
          <ol className="flex items-end gap-3 overflow-x-auto pb-1">
            {o.months.map((m) => {
              const top = Math.max(1, ...o.months.map((x) => x.visitors ?? 0));
              return (
                <li key={m.month} className="flex w-[52px] shrink-0 flex-col items-center gap-1">
                  <span className="num text-[12px] font-bold">{number(m.visitors)}</span>
                  <span
                    className="w-full max-w-[46px] rounded-t-[4px]"
                    style={{ height: `${Math.max(2, ((m.visitors ?? 0) / top) * 72)}px`, background: "linear-gradient(180deg,#e9bd63,#7c5214)" }}
                  />
                  <span className="num text-[11px] text-[color:var(--v-ink3)]">{m.month.slice(2)}</span>
                </li>
              );
            })}
          </ol>
        </Panel>

        {o.interest && (
          <>
            <h2 className="relative mb-3 mt-6 flex items-center gap-2.5 text-[12.5px] font-semibold tracking-[.14em] text-[color:var(--v-gold)]">
              读者兴趣记录 · {words}
              <span className="h-px flex-1" style={{ background: "linear-gradient(90deg,var(--v-line),transparent)" }} />
            </h2>
            <p className="relative mb-3 text-[12px] leading-relaxed text-[color:var(--v-ink3)]">
              {o.interest.since ? `记录自 ${o.interest.since} 起；` : ""}
              每天凌晨把前一天的文章浏览按分类、矿种、公司、国家和地区汇总，只作了解读者的参考，不据此自动改变选材。一篇文章同时属于几个矿种或公司时，每一项都计入。
              {interest && interest.days > 0 ? ` 这里是 ${interest.days} 天、${number(interest.item_views)} 次文章浏览。` : ""}
            </p>
            <div className="relative grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
              {(
                [
                  ["分类", interest?.category],
                  ["矿种", interest?.mineral],
                  ["国家和地区", interest?.country],
                  ["公司", interest?.company],
                ] as const
              ).map(([title, rows], i) => (
                <Panel key={title} title={title} delay={0.58 + i * 0.04}>
                  <Ranked
                    empty={o.interest?.since ? empty : "第一份记录在统计开始后的第二天出现。"}
                    rows={(rows ?? []).slice(0, 6).map((row) => ({ key: row.key, label: row.label, views: row.views }))}
                  />
                </Panel>
              ))}
            </div>
            <div className="relative mt-3.5 grid gap-3.5 lg:grid-cols-2">
              <Panel title="最常读的文章" note={`${words} · 次`} delay={0.74}>
                <Ranked
                  empty={empty}
                  rows={(interest?.items ?? []).slice(0, 8).map((item) => ({
                    key: item.article_id,
                    label: item.title ? (
                      <a
                        href={`/items/${encodeURIComponent(item.article_id)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-[color:var(--v-gold2)]"
                      >
                        {item.title}
                      </a>
                    ) : (
                      "已撤回或不再有阅读页的文章"
                    ),
                    tag: item.category,
                    views: item.views,
                  }))}
                />
              </Panel>
              <Panel title="列表和专题页" note={`${words} · 次`} delay={0.78}>
                <Ranked
                  empty={empty}
                  rows={(interest?.page ?? []).slice(0, 8).map((row) => ({ key: row.key, label: interestPageLabel(row), views: row.views }))}
                />
              </Panel>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
