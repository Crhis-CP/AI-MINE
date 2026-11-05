// The survey map above the feed (direction C, DEC-78): land as dots, no borders and no names (Owner
// 2026-11-05), and one gold circle per country with identified news, sized by its count. A circle links
// to the same page filtered to that country; the selected country carries a ring. The dot layer is the
// cached file from scripts/world-dots.ts (Natural Earth 1:10m land, small islands always kept).
import { useSearchParams } from "react-router";
import dotsUrl from "@amp/industry/brand/world-dots.svg?url&no-inline";
import frame from "@amp/industry/brand/world-dots.json";
import { IntentLink as Link } from "../../components/ui/IntentLink";
import { hrefWith } from "./Filters";
import { useJurisdictionChoices } from "./jurisdictions";

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

export function WorldMap({ base, selected }: { base: string; selected: string | null }) {
  const { choices, failed } = useJurisdictionChoices();
  const [params] = useSearchParams();
  const countries = (choices ?? []).filter((c) => c.kind === "country" && c.news_count > 0 && POINTS[c.code]).sort((a, b) => b.news_count - a.news_count);
  const max = Math.max(1, ...countries.map((c) => c.news_count));
  const radius = (n: number) => 1.6 + 4.4 * Math.sqrt(n / max);
  const labelled = new Set(countries.slice(0, 5).map((c) => c.code));
  return (
    <section aria-labelledby="world-map" className="card mb-6 flex flex-col px-4 pb-3 pt-3.5 lg:px-5">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 id="world-map" className="text-[15px] font-semibold text-ink">
          资讯地图
        </h2>
        {selected && (
          <Link to={hrefWith(base, params, { jurisdiction: null })} className="text-[13.5px] text-ink-3 hover:text-accent">
            查看全部国家
          </Link>
        )}
      </div>
      <nav aria-label="按国家查看资讯：圆点越大，已识别资讯越多">
        <svg viewBox={`0 0 ${frame.width} ${frame.height}`} className="block h-auto w-full" aria-hidden={countries.length === 0 ? true : undefined}>
          <title>资讯地图</title>
          <use href={`${dotsUrl}#dots`} className="stroke-ink-4 opacity-40" />
          {countries.map((c, i) => {
            const [x, y] = project(POINTS[c.code]!);
            const r = radius(c.news_count);
            const on = selected === c.code;
            return (
              <Link
                key={c.code}
                to={hrefWith(base, params, { jurisdiction: c.code })}
                aria-label={`${c.label}，${c.news_count} 条资讯`}
                aria-current={on ? "true" : undefined}
              >
                <title>{`${c.label} · ${c.news_count}`}</title>
                {on && <circle cx={x} cy={y} r={r + 2.2} className="fill-none stroke-accent" strokeWidth={0.7} />}
                <circle
                  cx={x}
                  cy={y}
                  r={r}
                  className="map-bubble fill-accent"
                  style={{ animationDelay: `${0.08 + i * 0.05}s` }}
                  fillOpacity={on ? 0.95 : 0.7}
                />
                {(labelled.has(c.code) || on) && (
                  <text x={x + r + 1.8} y={y + 2.4} className="fill-ink-2 text-[7px] font-semibold">
                    {c.label}
                  </text>
                )}
              </Link>
            );
          })}
        </svg>
      </nav>
      <p className="mt-2 text-[12.5px] leading-[1.6] text-ink-4">
        {failed ? "国家数据暂时不可用。" : choices ? "按事件或影响地区统计；点击圆点筛选该国资讯。" : "正在读取国家数据…"}
        地图只示意陆地分布，不表示国界。
      </p>
    </section>
  );
}
