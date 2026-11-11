// 访问概况 (TASK-0571): the site's own visit statistics — daily and monthly visitors, page views, the most read pages,
// referring sites and devices, and the 读者兴趣记录 (TASK-0596). Counts only; the page never sees an address, a browser string or a visitor key.
import { apiFetch } from "@amp/web/extension";
import { useState, type ReactNode } from "react";
import { SITE } from "@amp/industry/site";
import { schemas as privateSchemas } from "@amp/contracts/http/private";
import type { z } from "zod";
import type { LoaderFunctionArgs } from "react-router";
import { adminGet } from "@amp/web/admin-extension.server";
import { AdminPage, Card, Empty, Stat } from "@amp/web/admin-ui";

type Overview = z.infer<typeof privateSchemas.VisitOverview>;
export const meta = () => [{ title: `访问概况 · ${SITE.name} 后台` }];
export async function loader({ request }: LoaderFunctionArgs) {
  const path = "/api/admin/visits";
  return privateSchemas.VisitOverview.parse(
    await adminGet(request, path, (url, init) => apiFetch(path, { baseUrl: new URL(url).origin, headers: init.headers, signal: init.signal, method: "GET" })),
  );
}

const number = (value: number | null | undefined) => (value === null || value === undefined ? "—" : value.toLocaleString("zh-CN"));
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

/**
 * One series as columns over time, on its own axis (visitors and page views have different scales, so each gets
 * its own chart rather than a second axis). Each column carries its value on hover; the busiest and the latest
 * are labelled; a table below gives every value.
 */
function Columns({ label, points }: { label: string; points: Array<{ key: string; tick: string; value: number | null; title: string }> }) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 640,
    height = 132,
    top = 18,
    bottom = 20,
    max = Math.max(1, ...points.map((p) => p.value ?? 0)),
    step = width / points.length,
    bar = Math.max(2, step - 2),
    peak = points.reduce((best, p, i) => ((p.value ?? -1) > (points[best]?.value ?? -1) ? i : best), 0);
  const y = (value: number) => top + (height - top - bottom) * (1 - value / max);
  const shown = hover ?? points.length - 1;
  return (
    <figure className="min-w-0">
      <figcaption className="mb-1 flex items-baseline justify-between gap-3 text-[12.5px] text-ink-3">
        <span>{label}</span>
        <span className="num text-ink-2" aria-live="polite">
          {points[shown]?.title}
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
        <line x1={0} x2={width} y1={height - bottom} y2={height - bottom} className="stroke-line" strokeWidth={1} />
        {points.map((p, i) => {
          const value = p.value ?? 0,
            x = i * step + (step - bar) / 2,
            h = Math.max(value > 0 ? 2 : 0, height - bottom - y(value)),
            r = Math.min(4, bar / 2, h);
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: the hover only mirrors the table below the chart.
            <g key={p.key} onMouseEnter={() => setHover(i)}>
              <rect x={i * step} y={0} width={step} height={height} fill="transparent" />
              {h > 0 && (
                <path
                  d={`M${x},${height - bottom} v${-(h - r)} q0,${-r} ${r},${-r} h${bar - 2 * r} q${r},0 ${r},${r} v${h - r} z`}
                  className={hover === i ? "fill-accent-ink" : "fill-accent"}
                />
              )}
              {p.value === null && <circle cx={x + bar / 2} cy={height - bottom - 3} r={1.5} className="fill-ink-4" />}
              <title>{p.title}</title>
              {(i === peak || i === points.length - 1) && p.value !== null && p.value > 0 && (
                <text x={x + bar / 2} y={y(value) - 4} textAnchor="middle" className="num fill-ink-2 text-[10px]">
                  {number(p.value)}
                </text>
              )}
              {(i === 0 || i === points.length - 1 || (i % Math.ceil(points.length / 6) === 0 && points.length - i > points.length / 8)) && (
                <text
                  x={i === 0 ? x : i === points.length - 1 ? x + bar : x + bar / 2}
                  y={height - 5}
                  textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
                  className="num fill-ink-4 text-[10px]"
                >
                  {p.tick}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

function Ranked({ rows, empty }: { rows: Array<{ key: string; label: ReactNode; views: number }>; empty: string }) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  const total = rows[0]!.views || 1;
  return (
    <ol className="space-y-1.5 text-[13px]">
      {rows.map((row) => (
        <li key={row.key} className="relative overflow-hidden rounded-control px-2.5 py-1.5">
          <span aria-hidden="true" className="absolute inset-y-0 left-0 bg-accent-softer" style={{ width: `${(row.views / total) * 100}%` }} />
          <span className="relative flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-ink-2">{row.label}</span>
            <span className="num shrink-0 text-ink">{number(row.views)}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function Range({ value, onChange }: { value: "week" | "month"; onChange: (value: "week" | "month") => void }) {
  return (
    <fieldset className="flex gap-1">
      <legend className="sr-only">时间范围</legend>
      {(["week", "month"] as const).map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={`rounded-full px-2.5 py-0.5 text-[12px] ${value === v ? "bg-accent-soft font-medium text-accent" : "text-ink-3 hover:text-ink"}`}
        >
          {v === "week" ? "近 7 天" : "近 30 天"}
        </button>
      ))}
    </fieldset>
  );
}

function pageLabel(page: Overview["pages"]["week"][number]) {
  const name = ROUTES[page.route] ?? page.route;
  return (
    <a href={page.path} target="_blank" rel="noopener noreferrer" className="hover:text-accent">
      {page.title ? `${page.title}` : page.path === page.route ? name : `${name} ${page.path}`}
    </a>
  );
}

const INTEREST_NOTE =
  "每天凌晨把前一天的文章浏览按分类、矿种、公司、国家和地区汇总，并记下当天最常读的 50 篇和列表、专题页的浏览，长期保存，作为了解读者的参考；前期访问少，数字不一定准，不据此自动改变选材。一篇文章同时属于几个矿种或公司时，每一项都计入。";

function interestPageLabel(row: { key: string; label: string }) {
  return row.key.startsWith("/topics/") && row.label !== row.key ? `专题 · ${row.label}` : (ROUTES[row.key] ?? row.label);
}

/**
 * 读者兴趣记录 (TASK-0596): complete days only, summed by the filters the site already has. A reference for
 * understanding readers; it changes nothing on the site.
 */
function Interest({ interest }: { interest: NonNullable<Overview["interest"]> }) {
  const [range, setRange] = useState<"week" | "month">("week");
  const r = interest[range];
  const rows = (list: Array<{ key: string; label: string; views: number }>, label = (row: { key: string; label: string }) => row.label) =>
    list.map((row) => ({ key: row.key, label: label(row), views: row.views }));
  const empty = "这段时间还没有记录";
  return (
    <Card title="读者兴趣记录" right={<Range value={range} onChange={setRange} />} className="mt-5">
      <p className="mb-4 text-[12.5px] text-ink-3">
        {INTEREST_NOTE}
        {interest.since ? ` 记录自 ${interest.since} 起；` : " "}
        {r.days ? `这段时间有 ${r.days} 天记录，文章浏览 ${number(r.item_views)}，其中 ${number(r.classified_views)} 来自现在仍可阅读的文章。` : ""}
      </p>
      {r.days ? (
        <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
          <section>
            <h3 className="mb-2 text-[13px] font-medium text-ink-2">分类</h3>
            <Ranked empty={empty} rows={rows(r.category)} />
          </section>
          <section>
            <h3 className="mb-2 text-[13px] font-medium text-ink-2">矿种</h3>
            <Ranked empty={empty} rows={rows(r.mineral)} />
          </section>
          <section>
            <h3 className="mb-2 text-[13px] font-medium text-ink-2">公司</h3>
            <Ranked empty={empty} rows={rows(r.company)} />
          </section>
          <section>
            <h3 className="mb-2 text-[13px] font-medium text-ink-2">国家和地区</h3>
            <Ranked empty={empty} rows={rows(r.country)} />
          </section>
          <section>
            <h3 className="mb-2 text-[13px] font-medium text-ink-2">列表与专题页</h3>
            <Ranked empty={empty} rows={rows(r.page, interestPageLabel)} />
          </section>
          <section>
            <h3 className="mb-2 text-[13px] font-medium text-ink-2">最常读的文章</h3>
            <Ranked
              empty={empty}
              rows={r.items.map((item) => ({
                key: item.article_id,
                label: (
                  <a href={`/items/${item.article_id}`} target="_blank" rel="noopener noreferrer" className="hover:text-accent">
                    {item.title ?? `文章 ${item.article_id}（已不可阅读）`}
                  </a>
                ),
                views: item.views,
              }))}
            />
          </section>
        </div>
      ) : (
        <Empty>{interest.since ? empty : "还没有记录：每天凌晨记录前一天，第一份记录在统计开始后的第二天出现。"}</Empty>
      )}
    </Card>
  );
}

export default function Visits({ loaderData }: { loaderData: Overview }) {
  const o = loaderData,
    [pagesRange, setPagesRange] = useState<"week" | "month">("week"),
    [refRange, setRefRange] = useState<"week" | "month">("week");
  const subtitle = `读者页面的访客与浏览量，由本站自己统计：不用 Cookie、不接第三方统计。访客按当天（日活）和当月（月活）的匿名标识去重，换浏览器或换网络会算作新访客；浏览量按打开的页面计，已排除后台、预加载和常见的爬虫。${o.since ? `统计自 ${o.since} 起。` : ""}`;
  if (!o.since)
    return (
      <AdminPage title="访问概况" subtitle={subtitle}>
        <Card>
          <Empty title="还没有访问记录">读者打开页面后约 10 秒写入，这里随后显示；数字每 10 分钟汇总一次，今日与本月访客实时计算。</Empty>
        </Card>
      </AdminPage>
    );
  const c = o.cards,
    devicesTotal = o.devices.reduce((sum, d) => sum + d.views, 0) || 1;
  const pv = (n: number) => `浏览 ${number(n)}`;
  return (
    <AdminPage title="访问概况" subtitle={subtitle}>
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat label="今日访客" value={number(c.today.visitors ?? 0)} hint={pv(c.today.page_views)} />
        <Stat label="昨日访客" value={number(c.yesterday.visitors)} hint={pv(c.yesterday.page_views)} />
        <Stat
          label="近 7 天日均访客"
          value={number(c.week_average.visitors)}
          hint={
            c.week_average.days
              ? `日均浏览 ${number(c.week_average.page_views)}${c.week_average.days < 7 ? `（${c.week_average.days} 天）` : ""}`
              : "还没有完整的一天"
          }
        />
        <Stat label="本月访客（月活）" value={number(c.this_month.visitors ?? 0)} hint={pv(c.this_month.page_views)} />
        <Stat label="上月访客" value={number(c.last_month.visitors)} hint={pv(c.last_month.page_views)} />
      </div>

      <Card title="近 30 天日访客与浏览量" className="mb-5">
        <div className="grid gap-6 lg:grid-cols-2">
          <Columns
            label="日访客"
            points={o.days.map((d) => ({ key: d.day, tick: d.day.slice(5), value: d.visitors, title: `${d.day} 访客 ${number(d.visitors)}` }))}
          />
          <Columns
            label="日浏览量"
            points={o.days.map((d) => ({ key: d.day, tick: d.day.slice(5), value: d.page_views, title: `${d.day} 浏览 ${number(d.page_views)}` }))}
          />
        </div>
        <details className="mt-4 text-[12.5px]">
          <summary className="cursor-pointer text-ink-3">按天查看数字</summary>
          <table className="mt-2 w-full max-w-xl text-left">
            <thead>
              <tr className="border-b border-line text-ink-3">
                <th className="py-1.5 pr-3 font-medium">日期</th>
                <th className="px-3 py-1.5 text-right font-medium">访客</th>
                <th className="px-3 py-1.5 text-right font-medium">浏览量</th>
                <th className="py-1.5 pl-3 text-right font-medium">其中英文页</th>
              </tr>
            </thead>
            <tbody>
              {[...o.days].reverse().map((d) => (
                <tr key={d.day} className="border-b border-line/70 last:border-0">
                  <td className="num py-1 pr-3">{d.day}</td>
                  <td className="num px-3 py-1 text-right">{number(d.visitors)}</td>
                  <td className="num px-3 py-1 text-right">{number(d.page_views)}</td>
                  <td className="num py-1 pl-3 text-right">{number(d.english_views)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </Card>

      <Card title="近 12 个月月访客" className="mb-5">
        <div className="max-w-3xl">
          <Columns
            label="月访客（月活）"
            points={o.months.map((m) => ({
              key: m.month,
              tick: `${Number(m.month.slice(5))}月`,
              value: m.visitors,
              title: `${m.month} 访客 ${number(m.visitors)} · 浏览 ${number(m.page_views)}`,
            }))}
          />
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="热门页面" right={<Range value={pagesRange} onChange={setPagesRange} />}>
          <Ranked empty="这段时间没有浏览记录" rows={o.pages[pagesRange].map((p) => ({ key: p.path, label: pageLabel(p), views: p.views }))} />
        </Card>
        <Card title="来源网站" right={<Range value={refRange} onChange={setRefRange} />}>
          <Ranked
            empty="这段时间没有从其他网站点进来的访问（直接打开、收藏夹和应用内打开不计来源）"
            rows={o.referrers[refRange].map((r) => ({ key: r.host, label: r.host, views: r.views }))}
          />
        </Card>
        <Card title="栏目浏览（近 30 天）">
          <Ranked empty="近 30 天没有浏览记录" rows={o.sections.map((s) => ({ key: s.route, label: ROUTES[s.route] ?? s.route, views: s.views }))} />
        </Card>
        <Card title="设备占比（近 30 天）">
          {o.devices.length ? (
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-line text-[12px] text-ink-3">
                  <th className="py-1.5 pr-3 font-medium">设备</th>
                  <th className="px-3 py-1.5 text-right font-medium">浏览量</th>
                  <th className="px-3 py-1.5 text-right font-medium">占比</th>
                  <th className="py-1.5 pl-3 text-right font-medium" title="每位访客每天计一次">
                    访客·天
                  </th>
                </tr>
              </thead>
              <tbody>
                {o.devices.map((d) => (
                  <tr key={d.device} className="border-b border-line/70 last:border-0">
                    <td className="py-1.5 pr-3 text-ink-2">{DEVICES[d.device]}</td>
                    <td className="num px-3 py-1.5 text-right">{number(d.views)}</td>
                    <td className="num px-3 py-1.5 text-right">{Math.round((d.views / devicesTotal) * 100)}%</td>
                    <td className="num py-1.5 pl-3 text-right">{number(d.visitor_days)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>近 30 天没有浏览记录</Empty>
          )}
          <p className="mt-3 text-[12px] text-ink-4">按浏览器自报的类型区分；部分 iPad 自报为电脑，会算作电脑。</p>
        </Card>
      </div>
      {o.interest && <Interest interest={o.interest} />}
    </AdminPage>
  );
}
