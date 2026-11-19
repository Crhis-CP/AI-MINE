// The rewritten home page, minimal until plan 3.4: the latest featured reports as plain text, from the same one read
// the old home page makes. That read is the first page of a timeline running over several days, so the heading names
// no date. No scores, no filters and no links to item pages until those pages exist here, so a preview never shows a
// dead link. An empty list says so plainly (rule 14).
import { data, useLocation } from "react-router";
import { SITE } from "@amp/industry/site";
import { schemas as publicSchemas } from "@amp/contracts/http/public";
import { sourceMonthDayTime } from "../../app/lib/format.ts";
import { readerPageHeaders } from "../../app/lib/api.server.ts";
import { localeOf, wordsFor } from "../i18n/locale.ts";
import { readSite } from "../lib/api.server.ts";
import type { Route } from "./+types/home";

export async function loader({ request }: Route.LoaderArgs) {
  const { body, upstream } = await readSite(request, "/api/site/timeline", publicSchemas.ReportGroupedTimelineResponse, { readingGroups: "reports-v1" });
  const cards = body.cards.map(({ key, item }) => ({
    key,
    title: item.title,
    source: item.source.name,
    at: item.publishedAt ? sourceMonthDayTime(item.publishedAt) : null,
  }));
  // Each language is its own page in search: it names itself (canonical) and both point at each other (hreflang),
  // Chinese standing for every other language, as the old pages do. SITE_URL is the address crawlers read.
  const site = (process.env.SITE_URL || SITE.defaultUrl).replace(/\/+$/, "");
  const links = { zh: `${site}/`, en: `${site}/en`, self: localeOf(new URL(request.url).pathname) };
  // The HTML may be shared briefly, never past the next scheduled release in this scope (TASK-0672).
  return data({ cards, links }, { headers: readerPageHeaders(body.refreshAt, upstream) });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: SITE.homeTitle }];
  const { zh, en, self } = loaderData.links;
  return [
    { title: SITE.homeTitle },
    { tagName: "link", rel: "canonical", href: self === "en" ? en : zh },
    { tagName: "link", rel: "alternate", hrefLang: SITE.locale, href: zh },
    { tagName: "link", rel: "alternate", hrefLang: "en", href: en },
    { tagName: "link", rel: "alternate", hrefLang: "x-default", href: zh },
  ];
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { cards } = loaderData;
  const words = wordsFor(localeOf(useLocation().pathname));
  return (
    <section>
      <h1 className="text-[20px] font-bold">{words.picks}</h1>
      {cards.length === 0 ? (
        <p className="mt-4 text-[14px] text-ink-3">{words.empty}</p>
      ) : (
        <ol className="mt-4 divide-y divide-line">
          {cards.map((card) => (
            <li key={card.key} className="py-3">
              <p className="text-[15px] font-semibold leading-snug">{card.title}</p>
              <p className="mt-1 text-[12px] text-ink-4">
                {card.source}
                {card.at && ` · ${card.at}`}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
