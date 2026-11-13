// The home page's opening block: the newest items of the reader's country above the worldwide picks (TASK-0633, Owner
// 2026-11-13: “不同国家的人看到的是一开始不同的……但是也是支持看其他国家”). It is drawn after hydration from the public
// list APIs, so the page itself stays one page for everyone: the same HTML for every reader, cache and search engine.
import { useEffect, useState } from "react";
import { schemas as publicSchemas } from "@amp/contracts/http/public";
import type { z } from "zod";
import { IntentLink as Link } from "../../components/ui/IntentLink";
import { apiFetch } from "../../lib/http.ts";
import { dateFormatFor } from "../../lib/format";
import { fmt, useLocale, useT } from "../../i18n";
import { readMap } from "../feed/WorldMap";
import { useJurisdictionChoices, useRegionName } from "../feed/jurisdictions";
import { type HomeCountry as Choice, HOME_COUNTRIES, WORLD, resolveHomeCountry, writeHomeCountry } from "./home-country";

type Item = z.infer<typeof publicSchemas.ReportGroupedPoolResponse>["items"][number];
type Local = { code: string; items: Item[]; week: number | null; from: string | null };
/** How many of the country's newest items open the page. */
export const HOME_COUNTRY_ROWS = 5;

async function readLocal(code: string): Promise<Local> {
  const response = await apiFetch(`/api/site/pool?jurisdiction=${code}&readingGroups=reports-v1`, { baseUrl: globalThis.location.origin });
  if (!response.ok) throw new Error("country items unavailable");
  const pool = publicSchemas.ReportGroupedPoolResponse.parse(await response.json());
  // The week's count is a nicety: without the map the block still shows the items.
  const map = await readMap("7d").catch(() => null);
  return { code, items: pool.items.slice(0, HOME_COUNTRY_ROWS), week: map?.countries.find((c) => c.code === code)?.count ?? null, from: map?.from ?? null };
}

export function HomeCountry() {
  const t = useT().local;
  const english = useLocale() === "en";
  const { relativeTime } = dateFormatFor(english);
  const nameOf = useRegionName();
  const { choices } = useJurisdictionChoices();
  const [choice, setChoice] = useState<Choice | null>(null);
  const [local, setLocal] = useState<Local | "none" | null>(null);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    let live = true;
    resolveHomeCountry().then((found) => live && setChoice(found));
    return () => {
      live = false;
    };
  }, []);
  const code = choice?.code ?? null;
  useEffect(() => {
    if (!code) return setLocal(null);
    let live = true;
    setLocal(null);
    readLocal(code).then(
      (found) => live && setLocal(found.items.length ? found : "none"),
      () => live && setLocal("none"),
    );
    return () => {
      live = false;
    };
  }, [code]);

  const countries = (choices ?? []).filter((place) => HOME_COUNTRIES.includes(place.code) && place.news_scope && place.news_count > 0);
  const choose = (value: string) => {
    writeHomeCountry(value);
    setPicking(false);
    setChoice({ code: value === WORLD ? null : value, chosen: true });
  };
  // Nothing is drawn until the country is known and, for a country, its items are read: no empty frame flashes.
  if (!choice || !choices || (code && local === null)) return null;
  const place = code ? (choices.find((one) => one.code === code) ?? { code, label: code, kind: "country" }) : null;
  const name = place ? nameOf(place) : null;
  const picker = (
    <select
      aria-label={t.pick}
      className="rounded-md border border-line bg-surface px-2 py-1 text-[13px] text-ink"
      value={code ?? WORLD}
      onChange={(event) => choose(event.target.value)}
    >
      <option value={WORLD}>{t.world}</option>
      {code && !countries.some((one) => one.code === code) && <option value={code}>{name}</option>}
      {countries
        .map((one) => ({ code: one.code, name: nameOf(one) }))
        .sort((a, b) => a.name.localeCompare(b.name, english ? "en" : "zh-Hans-CN"))
        .map((one) => (
          <option key={one.code} value={one.code}>
            {one.name}
          </option>
        ))}
    </select>
  );
  const change = picking ? (
    picker
  ) : (
    <button type="button" className="text-[13px] text-ink-3 underline-offset-2 hover:text-accent hover:underline" onClick={() => setPicking(true)}>
      {code ? t.change : t.choose}
    </button>
  );

  if (!code || !name || local === "none" || local === null)
    return (
      <p data-home-country="line" className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-3">
        <span>{code && name ? fmt(t.nothing, { country: name }) : t.worldFirst}</span>
        {change}
      </p>
    );
  return (
    <section data-home-country={code} aria-labelledby="home-country" className="card home-country mb-6 px-4 pb-3 pt-3.5 lg:px-5">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="home-country" className="text-[15px] font-semibold text-ink">
          {fmt(t.title, { country: name })}
          {local.week !== null && <span className="ml-2 text-[12.5px] font-normal text-ink-3">{fmt(t.week, { count: local.week })}</span>}
        </h2>
        <div className="flex items-center gap-3">{change}</div>
      </div>
      <ol className="divide-y divide-line-soft">
        {local.items.map((item) => (
          <li key={item.id}>
            <Link to={`/items/${item.id}`} className="group flex flex-col gap-0.5 py-2 sm:flex-row sm:items-baseline sm:gap-3">
              <span className="min-w-0 flex-1 text-[14.5px] leading-snug text-ink group-hover:text-accent">
                {(english && item.english?.title) || item.title}
              </span>
              <span className="shrink-0 text-[12px] text-ink-4 sm:whitespace-nowrap">
                {item.source.name} · {relativeTime(item.timelineAt)}
              </span>
            </Link>
          </li>
        ))}
      </ol>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[13px]">
        <Link to={`/country/${code}`} className="font-medium text-accent hover:underline">
          {fmt(t.all, { country: name })} →
        </Link>
        {!choice.chosen && <span className="text-[12px] text-ink-4">{t.guessed}</span>}
      </div>
    </section>
  );
}
