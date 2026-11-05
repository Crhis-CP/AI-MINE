// The survey map above the feed (direction C, DEC-78): land as dots, no borders and no names (Owner
// 2026-11-05), and one gold circle per country with news in the chosen window (today, 7 or 30 days by
// archive time), sized by its count; a rise over the window before it is marked. A circle filters the list
// below to that country in place (the page keeps its scroll position); the selected country carries a ring.
// The dot layer is the cached file from scripts/world-dots.ts (Natural Earth 1:10m land, small islands kept).
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { type NewsMapWindow, SiteNewsMap } from "@amp/contracts/http/public";
import dotsUrl from "@amp/industry/brand/world-dots.svg?url&no-inline";
import frame from "@amp/industry/brand/world-dots.json";
import { PillTabs } from "../../components/ui/Tabs";
import { IntentLink as Link } from "../../components/ui/IntentLink";
import { apiFetch } from "../../lib/http.ts";
import { hrefWith } from "./Filters";

/**
 * A point inside each covered country (longitude, latitude), chosen on land and away from borders so
 * the circle reads as that country. Countries missing here are listed by the filter but not drawn.
 */
const POINTS: Record<string, readonly [number, number]> = {
  CN: [104, 34.5],
  US: [-99, 39],
  CA: [-104, 57],
  AU: [134, -25],
  AR: [-65, -34],
  CL: [-70.6, -27],
  PE: [-75, -9.5],
  BO: [-64.5, -17],
  EC: [-78.4, -1.6],
  CO: [-73.5, 4],
  VE: [-66, 7],
  GY: [-58.9, 5],
  SR: [-55.9, 4.1],
  GH: [-1.2, 7.9],
  ML: [-2, 17],
  CD: [23.5, -3],
  ZM: [27.8, -13.5],
  ZW: [29.8, -19],
  MZ: [35.3, -17.5],
  TZ: [34.8, -6.3],
  ZA: [24.5, -29.5],
  GB: [-1.8, 52.8],
  CH: [8.2, 46.8],
  RS: [20.8, 44],
  RU: [96, 62],
  KZ: [67, 48],
  UZ: [63.5, 41.4],
  KG: [74.6, 41.4],
  TJ: [71, 38.8],
  MN: [103.5, 46.8],
  IR: [54, 32.5],
  ID: [113.5, -1.5],
  SG: [103.82, 1.35],
};

const project = ([lon, lat]: readonly [number, number]) => [lon - frame.west, frame.north - lat] as const;

const WINDOWS: Array<{ key: NewsMapWindow; label: string; span: string }> = [
  { key: "1d", label: "今天", span: "近 24 小时" },
  { key: "7d", label: "7 天", span: "近 7 天" },
  { key: "30d", label: "30 天", span: "近 30 天" },
];

/** One read per window per page view; a failed read can be tried again by switching windows. */
const reads = new Map<NewsMapWindow, Promise<SiteNewsMap>>();
function readMap(period: NewsMapWindow): Promise<SiteNewsMap> {
  let read = reads.get(period);
  if (!read) {
    read = apiFetch(`/api/site/news-map?window=${period}`, { baseUrl: globalThis.location.origin })
      .then(async (response) => {
        if (!response.ok) throw new Error("news map unavailable");
        return SiteNewsMap.parse(await response.json());
      })
      .catch((error: unknown) => {
        reads.delete(period);
        throw error;
      });
    reads.set(period, read);
  }
  return read;
}

/** A rise worth marking: at least two more than the window before, and half again as many. */
const rising = (c: SiteNewsMap["countries"][number]) => c.count - c.previous >= 2 && c.count >= c.previous * 1.5;

export function WorldMap({ base, selected }: { base: string; selected: string | null }) {
  const [params] = useSearchParams();
  const [period, setPeriod] = useState<NewsMapWindow>("7d");
  const [map, setMap] = useState<SiteNewsMap | null>(null),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setFailed(false);
    readMap(period).then(
      (data) => live && setMap(data),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [period]);
  const shown = map?.window === period ? map : null;
  const countries = (shown?.countries ?? []).filter((c) => c.count > 0 && POINTS[c.code]);
  const max = Math.max(1, ...countries.map((c) => c.count));
  const radius = (n: number) => 1.6 + 4.4 * Math.sqrt(n / max);
  const labelled = new Set(countries.slice(0, 5).map((c) => c.code));
  const total = countries.reduce((sum, c) => sum + c.count, 0);
  const riser = [...countries].filter(rising).sort((a, b) => b.count - b.previous - (a.count - a.previous))[0];
  const current = selected ? shown?.countries.find((c) => c.code === selected) : undefined;
  const span = WINDOWS.find((w) => w.key === period)!.span;
  return (
    <section aria-labelledby="world-map" className="card mb-6 flex flex-col px-4 pb-3 pt-3.5 lg:px-5">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <h2 id="world-map" className="text-[15px] font-semibold text-ink">
          资讯地图
        </h2>
        <PillTabs
          size="sm"
          label="统计时段"
          layoutId="world-map-window"
          active={period}
          onSelect={(key) => setPeriod(key as NewsMapWindow)}
          items={WINDOWS.map((w) => ({ key: w.key, label: w.label }))}
        />
      </div>
      <p className="mb-1 min-h-[1.6em] text-[12.5px] text-ink-3" aria-live="polite">
        {failed
          ? "地图数据暂时不可用。"
          : !shown
            ? "正在读取…"
            : countries.length === 0
              ? `${span}暂无已识别国家的资讯。`
              : `${span} · ${countries.length} 个国家 · ${total} 条${riser ? ` · 增加最多：${riser.label}` : ""}`}
      </p>
      <nav aria-label="按国家筛选下方资讯：圆点越大，该时段资讯越多">
        <svg viewBox={`0 0 ${frame.width} ${frame.height}`} className="block h-auto w-full" aria-hidden={countries.length === 0 ? true : undefined}>
          <title>资讯地图</title>
          <use href={`${dotsUrl}#dots`} className="stroke-ink-4 opacity-40" />
          {countries.map((c, i) => {
            const [x, y] = project(POINTS[c.code]!);
            const r = radius(c.count);
            const on = selected === c.code;
            const up = rising(c);
            return (
              <Link
                key={`${period}-${c.code}`}
                to={hrefWith(base, params, { jurisdiction: on ? null : c.code })}
                preventScrollReset
                aria-label={`${c.label}，${span} ${c.count} 条${up ? "，比前一时段增加" : ""}${on ? "（已选，再点取消）" : ""}`}
                aria-current={on ? "true" : undefined}
              >
                <title>{`${c.label} · ${span} ${c.count} 条（前一时段 ${c.previous} 条）`}</title>
                {on && <circle cx={x} cy={y} r={r + 2.2} className="fill-none stroke-accent" strokeWidth={0.7} />}
                <circle
                  cx={x}
                  cy={y}
                  r={r}
                  className="map-bubble fill-accent"
                  style={{ animationDelay: `${0.06 + i * 0.04}s` }}
                  fillOpacity={on ? 0.95 : 0.7}
                />
                {(labelled.has(c.code) || on) && (
                  <text x={x + r + 1.8} y={y + 2.4} className="fill-ink-2 text-[7px] font-semibold">
                    {c.label}
                    {up && <tspan className="fill-hot">↑</tspan>}
                  </text>
                )}
              </Link>
            );
          })}
        </svg>
      </nav>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[12.5px] leading-[1.6] text-ink-4">
        {selected ? (
          <span className="text-ink-2">
            下方只看：<b className="font-semibold">{current?.label ?? "所选国家"}</b>
            {current ? `（${span} ${current.count} 条）` : ""}
            <Link to={hrefWith(base, params, { jurisdiction: null })} preventScrollReset className="ml-2 text-accent hover:underline">
              取消
            </Link>
          </span>
        ) : (
          <span>点击圆点，下方列表只看该国资讯。</span>
        )}
        <span>只示意陆地分布，不表示国界。</span>
      </div>
    </section>
  );
}
