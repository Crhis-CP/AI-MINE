// The survey map above the feed (direction C, DEC-78): land as dots, no borders and no names (Owner
// 2026-11-05), and one gold circle per country with news in the chosen window (today, 7 or 30 days by
// archive time), sized by its count; a rise over the window before it is marked. A circle filters the list
// below to that country in place (the page keeps its scroll position); the selected country carries a ring.
// The dot layer is the cached file from scripts/world-dots.ts (Natural Earth 1:10m land, small islands kept).
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { type NewsMapWindow, SiteNewsMap } from "@amp/contracts/http/public";
import dotsUrl from "@amp/industry/brand/world-dots.svg?url&no-inline";
import frame from "@amp/industry/brand/world-dots.json";
import { PillTabs } from "../../components/ui/Tabs";
import { IntentLink as Link } from "../../components/ui/IntentLink";
import { apiFetch } from "../../lib/http.ts";
import { hrefWith } from "./Filters";
import { fmt, useLocale, useT } from "../../i18n";

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

/** `hint` replaces the line under the map where clicking a circle does something else (e.g. the changelog's preview). */
export function WorldMap({ base, selected, hint }: { base: string; selected: string | null; hint?: string }) {
  const [params] = useSearchParams();
  const t = useT().map;
  const locale = useLocale();
  // The English interface names countries itself (the API's labels are Chinese).
  const regionNames = useMemo(
    () => (locale === "en" && typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["en"], { type: "region" }) : null),
    [locale],
  );
  const nameOf = (c: { code: string; label: string }) => regionNames?.of(c.code) ?? c.label;
  const [period, setPeriod] = useState<NewsMapWindow>("7d");
  const [map, setMap] = useState<SiteNewsMap | null>(null),
    [failed, setFailed] = useState(false);
  // Names stay hidden: one appears beside the dot under the pointer or keyboard focus, and beside the selected country.
  const [hovered, setHovered] = useState<string | null>(null);
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
        <svg viewBox={`0 0 ${frame.width} ${frame.height}`} className="block h-auto w-full" aria-hidden={countries.length === 0 ? true : undefined}>
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
                to={hrefWith(base, params, { jurisdiction: on ? null : c.code })}
                preventScrollReset
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
          </span>
        ) : (
          <span>{hint ?? t.hint}</span>
        )}
        <span>{t.noBorders}</span>
      </div>
    </section>
  );
}
