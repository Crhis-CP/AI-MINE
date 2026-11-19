// The rewritten home page, minimal until plan 3.4: today's date and the featured reports as plain text, the same
// one read the old home page makes. No scores, no filters and no links to item pages until those pages exist here,
// so a preview never shows a dead link. An empty list says so plainly (rule 14).
import { data, useLocation } from "react-router";
import { SITE } from "@amp/industry/site";
import { schemas as publicSchemas } from "@amp/contracts/http/public";
import { beijingDate, sourceMonthDayTime } from "../../app/lib/format.ts";
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
  // The HTML may be shared briefly, never past the next scheduled release in this scope (TASK-0672).
  return data({ today: beijingDate(Date.now()), cards }, { headers: readerPageHeaders(body.refreshAt, upstream) });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

export function meta() {
  return [{ title: SITE.homeTitle }];
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { today, cards } = loaderData;
  const words = wordsFor(localeOf(useLocation().pathname));
  return (
    <section>
      <h1 className="text-[20px] font-bold">
        {words.picks} <span className="mono text-[13px] font-normal text-ink-4">{today}</span>
      </h1>
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
