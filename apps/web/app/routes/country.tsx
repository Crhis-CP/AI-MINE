import { schemas } from "@amp/contracts/http/public";
import { useEffect, useState } from "react";
import { useLoaderData } from "react-router";
import type { Route } from "./+types/country";
import { apiBaseFor } from "../../api-target.ts";
import { apiFetch } from "../lib/http.ts";
import { contractResult, loadOr404, readerPageHeaders } from "../lib/api.server";
import { markDegraded } from "../lib/cache.server";
import { pageMeta, requestLocale } from "../lib/seo";
import { fmt, useLocale, useT, useTr } from "../i18n";
import { en } from "../i18n/en";
import { zh } from "../i18n/zh";
import { Link, useNavigate } from "../i18n/navigation";
import { DayList } from "../features/feed/DayList";
import { useRegionName } from "../features/feed/jurisdictions";
import { HOME_COUNTRIES, WORLD, writeHomeCountry } from "../features/region/home-country";

export async function loader({ params, request }: Route.LoaderArgs) {
  const code = params.code!;
  if (!HOME_COUNTRIES.includes(code)) throw new Response("Not found", { status: 404 });
  const read = <T,>(path: string, schema: { parse: (value: unknown) => T }) =>
    apiFetch(path, {
      baseUrl: apiBaseFor(),
      headers: { accept: "application/json", "x-amp-ssr": "1" },
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
    }).then((response) => contractResult(response, schema));
  // A count or list that could not be read is left out of the page, and that page is not cached (TASK-0679 R13).
  const missing = () => {
    markDegraded();
    return null;
  };
  const [places, news, today, week] = await Promise.all([
    loadOr404(() => read("/api/site/jurisdictions", schemas.PolicyJurisdictionList), { signal: request.signal }),
    loadOr404(() => read(`/api/site/pool?jurisdiction=${code}&readingGroups=reports-v1`, schemas.ReportGroupedPoolResponse), { signal: request.signal }),
    read("/api/site/news-map?window=1d", schemas.SiteNewsMap).catch(missing),
    read("/api/site/news-map?window=7d", schemas.SiteNewsMap).catch(missing),
  ]);
  const place = places.find((one) => one.code === code);
  const policies = place?.policy_scope ? await read(`/api/site/policies?jurisdiction=${code}&page_size=5`, schemas.PolicyListResponse).catch(missing) : null;
  return {
    code,
    place,
    places,
    news,
    policies,
    today: today?.countries.find((one) => one.code === code)?.count ?? null,
    week: week?.countries.find((one) => one.code === code)?.count ?? null,
  };
}

/** The HTML may be shared briefly (TASK-0672); its data is read fresh. */
export function headers() {
  return readerPageHeaders();
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [];
  const { code, place } = loaderData;
  const english = requestLocale() === "en";
  const country = english ? new Intl.DisplayNames(["en"], { type: "region" }).of(code)! : (place?.label ?? code);
  return pageMeta({
    title: fmt((english ? en : zh).country.title, { country }),
    description: fmt(zh.country.description, { country: place?.label ?? code }),
    descriptionEn: fmt(en.country.description, { country }),
    path: `/country/${code}`,
  });
}

export default function CountryPage() {
  const { code, place, places, news, policies, today, week } = useLoaderData<typeof loader>();
  const { country: t, local } = useT();
  const english = useLocale() === "en";
  const nameOf = useRegionName();
  const navigate = useNavigate();
  const name = nameOf(place ?? { code, label: code });
  const countries = places.filter((one) => HOME_COUNTRIES.includes(one.code) && one.news_scope && one.news_count > 0);
  const counts = [today !== null ? fmt(t.today, { count: today }) : null, week !== null ? fmt(local.week, { count: week }) : null].filter(Boolean);
  return (
    <div className="pb-8">
      <header className="flex flex-wrap items-start justify-between gap-3 pb-4 pt-5">
        <div>
          <h1 className="text-[24px] font-semibold text-ink">{fmt(t.title, { country: name })}</h1>
          {counts.length > 0 && <p className="mt-2 text-[13px] text-ink-3">{counts.join(" · ")}</p>}
        </div>
        <label className="flex flex-wrap items-center gap-2 text-[13px] text-ink-3">
          {local.change}
          <select
            aria-label={local.pick}
            value={code}
            className="rounded-md border border-line bg-surface px-2 py-1 text-ink"
            onChange={(event) => {
              const value = event.target.value;
              writeHomeCountry(value);
              navigate(value === WORLD ? "/" : `/country/${value}`);
            }}
          >
            <option value={WORLD}>{local.world}</option>
            {!countries.some((one) => one.code === code) && <option value={code}>{name}</option>}
            {countries
              .map((one) => ({ code: one.code, name: nameOf(one) }))
              .sort((a, b) => a.name.localeCompare(b.name, english ? "en" : "zh-Hans-CN"))
              .map((one) => (
                <option key={one.code} value={one.code}>
                  {one.name}
                </option>
              ))}
          </select>
        </label>
      </header>
      <section aria-labelledby="country-news">
        <h2 id="country-news" className="mb-3 text-[16px] font-semibold text-ink">
          {t.latest}
        </h2>
        {news.items.length ? (
          <DayList items={news.items} cards={news.cards} filters={news.filters} todayCount={news.todayCount} />
        ) : (
          <p className="py-5 text-[14px] text-ink-3">
            {fmt(t.empty, { country: name })}{" "}
            <Link to="/" className="text-accent hover:underline">
              {t.world}
            </Link>
          </p>
        )}
        <Link to={`/all?jurisdiction=${code}`} className="mt-4 inline-block text-[14px] font-medium text-accent hover:underline">
          {fmt(t.more, { country: name })} →
        </Link>
      </section>
      {place?.policy_scope && <CountryPolicies key={code} code={code} name={name} initial={policies} />}
    </div>
  );
}

function CountryPolicies({ code, name, initial }: { code: string; name: string; initial: Awaited<ReturnType<typeof loader>>["policies"] }) {
  const [policies, setPolicies] = useState(initial);
  const { country: t } = useT();
  const tr = useTr();
  // Policy changes need their own public read, without bypassing the news reader's update controls.
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const check = async () => {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      try {
        const response = await apiFetch(`/api/site/policies?jurisdiction=${code}&page_size=5`, {
          baseUrl: window.location.origin,
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        });
        if (!response.ok) throw new Error("policy list unavailable");
        const next = schemas.PolicyListResponse.parse(await response.json());
        if (!controller.signal.aborted) setPolicies(next);
      } catch {
        if (!controller.signal.aborted) setPolicies(null);
      } finally {
        pending = false;
      }
    };
    void check();
    const timer = setInterval(check, 60_000);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [code]);
  if (!policies?.items.length) return null;
  return (
    <section aria-labelledby="country-policies" className="mt-8 border-t border-line pt-5">
      <h2 id="country-policies" className="text-[16px] font-semibold text-ink">
        {t.policies}
      </h2>
      <ul className="divide-y divide-line-soft">
        {policies.items.slice(0, 5).map((policy) => {
          const facts = [
            policy.instrument_number,
            policy.nature.code === "unknown" ? null : tr.maybe(policy.nature.label),
            t.stages[policy.legal_brief.stage],
            policy.change_kind ? tr.maybe(policy.change_kind.label) : null,
          ].filter(Boolean);
          return (
            <li key={policy.id} className="py-4">
              <Link to={`/policies/${encodeURIComponent(policy.id)}`} className="text-[16px] font-medium leading-relaxed text-ink hover:text-accent">
                {policy.title}
              </Link>
              {facts.length > 0 && <p className="mt-1 text-[12px] text-ink-4">{facts.join(" · ")}</p>}
            </li>
          );
        })}
      </ul>
      <Link to={`/policies?jurisdiction=${code}`} className="mt-3 inline-block text-[14px] font-medium text-accent hover:underline">
        {fmt(t.allPolicies, { country: name })} →
      </Link>
    </section>
  );
}
