// The survey map above the feed (direction C, DEC-78): land as dots, no borders and no names (Owner
// 2026-11-05), and one gold circle per country with news in the chosen window (today, 7 or 30 days by
// archive time), sized by its count; a rise over the window before it is marked. A circle opens 全部动态 for
// that country from the window's first day, so the list there is the news its count stands for (TASK-0568:
// on the home page it used to filter 精选, which held far fewer). The selected country carries a ring.
// The dot layer is the cached file from scripts/world-dots.ts (Natural Earth 1:10m land, small islands kept).
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { type NewsMapWindow, SiteNewsMap } from "@amp/contracts/http/public";
import dotsUrl from "@amp/industry/brand/world-dots.svg?url&no-inline";
import frame from "@amp/industry/brand/world-dots.json";
import { PillTabs } from "../../components/ui/Tabs";
import { IntentLink as Link } from "../../components/ui/IntentLink";
import { useNavigate } from "../../i18n/navigation";
import { apiFetch } from "../../lib/http.ts";
import { hrefWith } from "./Filters";
import { beijingDate } from "@amp/contracts/time";
import { fmt, useT } from "../../i18n";
import { useRegionName } from "./jurisdictions";

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

const WINDOWS: NewsMapWindow[] = ["1d", "7d", "30d"];

/** One read per window per page view; a failed read can be tried again by switching windows. */
const reads = new Map<NewsMapWindow, Promise<SiteNewsMap>>();
/** How long the map and the country list wait before reading again after a failed read. */
const RETRY_MS = 2500;

export function readMap(period: NewsMapWindow): Promise<SiteNewsMap> {
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

/** 全部动态 for one country over the map's window: the same items its count is made of. */
export function countryNewsPath(code: string, map: Pick<SiteNewsMap, "from"> | null) {
  const sp = new URLSearchParams({ jurisdiction: code });
  if (map) sp.set("from", beijingDate(map.from));
  return `/all?${sp}`;
}

/** How far from a circle (in map units, about 13px on a 390px phone) a finger may land and still choose it. */
const TOUCH_REACH = 14;

/**
 * The country a tap at map point (x, y) means: the nearest drawn circle within reach, so on a phone a finger
 * need not hit the small dot itself, and between close neighbours (Chile, Argentina, Peru) the nearer one wins.
 */
export function nearestCountry(x: number, y: number, codes: readonly string[]): string | null {
  let best: string | null = null,
    gap = TOUCH_REACH;
  for (const code of codes) {
    const [cx, cy] = project(POINTS[code]!);
    const d = Math.hypot(cx - x, cy - y);
    if (d <= gap) {
      best = code;
      gap = d;
    }
  }
  return best;
}

/**
 * `selected` is the country the page below is filtered by, and `base` that page, for the “取消” link; a circle
 * itself always opens 全部动态. `hint` replaces the line under the map (e.g. the changelog's preview).
 */
export function WorldMap({ base, selected, hint }: { base: string; selected: string | null; hint?: string }) {
  const [params] = useSearchParams();
  const t = useT().map;
  const nameOf = useRegionName();
  const navigate = useNavigate();
  const pointer = useRef<string>("mouse");
  const [period, setPeriod] = useState<NewsMapWindow>("7d");
  const [map, setMap] = useState<SiteNewsMap | null>(null),
    [failed, setFailed] = useState(false);
  // Names stay hidden: one appears beside the dot under the pointer or keyboard focus, and beside the selected country.
  const [hovered, setHovered] = useState<string | null>(null);
  useEffect(() => {
    let live = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    setFailed(false);
    // One quiet retry: a read that fails while the service restarts (TASK-0568 Q2) or on a flaky connection would
    // otherwise leave the map empty until the reader changes the window.
    const attempt = (retries: number) =>
      readMap(period).then(
        (data) => live && setMap(data),
        () => {
          if (!live) return;
          if (retries > 0) timer = setTimeout(() => attempt(retries - 1), RETRY_MS);
          else setFailed(true);
        },
      );
    attempt(1);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [period]);
  const shown = map?.window === period ? map : null;
  const countries = (shown?.countries ?? []).filter((c) => c.count > 0 && POINTS[c.code]);
  const codes = countries.map((c) => c.code);
  const max = Math.max(1, ...countries.map((c) => c.count));
  const radius = (n: number) => 1.6 + 4.4 * Math.sqrt(n / max);
  const total = countries.reduce((sum, c) => sum + c.count, 0);
  const riser = [...countries].filter(rising).sort((a, b) => b.count - b.previous - (a.count - a.previous))[0];
  const current = selected ? shown?.countries.find((c) => c.code === selected) : undefined;
  const span = t.spans[period];
  return (
    <section aria-labelledby="world-map" className="card mb-6 flex flex-col px-4 pb-3 pt-3.5 lg:px-5">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <h2 id="world-map" className="text-[15px] font-semibold text-ink">
          {t.title}
        </h2>
        <PillTabs
          size="sm"
          label={t.windowLabel}
          layoutId="world-map-window"
          active={period}
          onSelect={(key) => setPeriod(key as NewsMapWindow)}
          items={WINDOWS.map((w) => ({ key: w, label: t.windows[w] }))}
        />
      </div>
      <p className="mb-1 min-h-[1.6em] text-[12.5px] text-ink-3 first-letter:uppercase" aria-live="polite">
        {failed
          ? t.unavailable
          : !shown
            ? t.loading
            : countries.length === 0
              ? `${span} · ${t.empty}`
              : `${span} · ${countries.length} ${t.countries} · ${total} ${t.items}${riser ? ` · ${t.rising}${nameOf(riser)}` : ""}`}
      </p>
      <nav aria-label={t.navLabel} className="relative">
        {/* A touch that misses every circle chooses the nearest one within reach (TASK-0568: the dots were too
            small to tap). Keyboard and screen-reader users have the links themselves. */}
        <svg
          viewBox={`0 0 ${frame.width} ${frame.height}`}
          className="block h-auto w-full"
          aria-hidden={countries.length === 0 ? true : undefined}
          onPointerDown={(event) => {
            pointer.current = event.pointerType;
          }}
          onClick={(event) => {
            if (pointer.current === "mouse" || (event.target as Element).closest("a") || !shown) return;
            const box = event.currentTarget.getBoundingClientRect();
            const scale = frame.width / box.width;
            const code = nearestCountry((event.clientX - box.left) * scale, (event.clientY - box.top) * scale, codes);
            if (code) navigate(countryNewsPath(code, shown));
          }}
        >
          <title>{t.title}</title>
          <use href={`${dotsUrl}#dots`} className="stroke-ink-4 opacity-40" />
          {countries.map((c, i) => {
            const [x, y] = project(POINTS[c.code]!);
            const r = radius(c.count);
            const on = selected === c.code;
            const up = rising(c);
            return (
              <Link
                key={`${period}-${c.code}`}
                to={countryNewsPath(c.code, shown)}
                className="map-dot-link"
                aria-label={`${fmt(t.bubble, { label: nameOf(c), span, count: c.count })}${up ? t.bubbleRise : ""}${on ? t.bubbleSelected : ""}`}
                aria-current={on ? "true" : undefined}
                onMouseEnter={() => setHovered(c.code)}
                onMouseLeave={() => setHovered((code) => (code === c.code ? null : code))}
                onFocus={() => setHovered(c.code)}
                onBlur={() => setHovered((code) => (code === c.code ? null : code))}
              >
                {/* A soft ring keeps breathing out of each dot, out of step with its neighbours; a fast riser's ring is hot. */}
                <circle
                  cx={x}
                  cy={y}
                  r={r}
                  className={`map-pulse fill-none ${up ? "stroke-hot" : "stroke-accent"}`}
                  strokeWidth={0.6}
                  style={{ animationDelay: `${0.6 + ((i * 0.53) % 3.2)}s` }}
                />
                {on && <circle cx={x} cy={y} r={r + 2.2} className="fill-none stroke-accent" strokeWidth={0.7} />}
                {/* An invisible target a little larger than the smallest dots, so they are easy to point at and tap. */}
                <circle cx={x} cy={y} r={Math.max(r + 1.2, 3.6)} className="fill-transparent" />
                <g className="map-dot">
                  <circle
                    cx={x}
                    cy={y}
                    r={r}
                    className={`map-bubble ${up ? "fill-hot" : "fill-accent"}`}
                    style={{ animationDelay: `${0.06 + i * 0.04}s` }}
                    fillOpacity={on || hovered === c.code ? 0.95 : 0.7}
                  />
                </g>
              </Link>
            );
          })}
        </svg>
        {/* The name sits beside its dot as ordinary text over the map, so it reads at the same size on a phone and a
            desktop; it flips to the left of the dot near the right edge. Screen readers get it from the link's label. */}
        {countries
          .filter((c) => c.code === hovered || c.code === selected)
          .map((c) => {
            const [x, y] = project(POINTS[c.code]!);
            const gap = `${((radius(c.count) * 1.3) / frame.width) * 100}% + 6px`;
            const left = x > frame.width * 0.8;
            return (
              <span
                key={`label-${c.code}`}
                aria-hidden="true"
                className="map-label pointer-events-none absolute z-10 -translate-y-1/2 whitespace-nowrap rounded-full border border-line bg-surface px-2 py-0.5 text-[12px] font-semibold leading-[1.5] text-ink shadow-sm"
                style={{
                  top: `${(y / frame.height) * 100}%`,
                  ...(left ? { right: `calc(${100 - (x / frame.width) * 100}% + ${gap})` } : { left: `calc(${(x / frame.width) * 100}% + ${gap})` }),
                }}
              >
                {nameOf(c)}
                <span className="ml-1 font-normal text-ink-3">
                  {c.count} {t.items}
                </span>
                {rising(c) && <span className="ml-0.5 text-hot">↑</span>}
              </span>
            );
          })}
      </nav>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[12.5px] leading-[1.6] text-ink-4">
        {selected ? (
          <span className="text-ink-2">
            {t.showingOnly}
            <b className="font-semibold">{current ? nameOf(current) : selected}</b>
            {current ? fmt(t.currentCount, { span, count: current.count }) : ""}
            <Link to={hrefWith(base, params, { jurisdiction: null })} preventScrollReset className="ml-2 text-accent hover:underline">
              {t.clear}
            </Link>
            {current && current.count > 0 && (
              <Link to={countryNewsPath(current.code, shown)} className="ml-3 text-accent hover:underline">
                {fmt(t.viewAll, { span, count: current.count })}
              </Link>
            )}
          </span>
        ) : (
          <span>{hint ?? t.hint}</span>
        )}
        <span>{t.noBorders}</span>
      </div>
    </section>
  );
}
