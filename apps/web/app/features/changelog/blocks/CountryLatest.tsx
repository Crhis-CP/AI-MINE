// The newest items of each home-page country as the film recorded them, switchable (TASK-0367). Both lists are drawn in
// the same cell and only the chosen one is visible, so switching never moves the page. A recording: the headlines are
// shown, not linked; one taken down by hand since reads “（该条已撤下）”. The way to the home page is a link.
import { useState } from "react";
import { IntentLink as Link } from "../../../components/ui/IntentLink";
import { useLocale, useTr } from "../../../i18n";
import { dateFormatFor } from "../../../lib/format";
import { countryName } from "./format";
import type { FilmCountry } from "./types";

export function CountryLatest({ countries }: { countries: FilmCountry[] }) {
  const tr = useTr();
  const english = useLocale() === "en";
  const { monthDayTime } = dateFormatFor(english);
  const shown = countries.filter((c) => countryName(c.code) && c.items.length);
  const [code, setCode] = useState(shown[0]?.code ?? null);
  // A recording always holds both countries' lists; one without any shows only the way to the home page.
  if (!shown.length)
    return (
      <Link to="/" className="inline-flex min-h-10 items-center text-[13px] font-semibold text-accent hover:text-hot">
        {tr("打开首页看本国最新动态")} →
      </Link>
    );
  return (
    <div>
      <fieldset aria-label={tr("选择国家")} className="inline-flex gap-0.5 rounded-full bg-bg-sunk p-0.5">
        {shown.map((c) => (
          <button
            key={c.code}
            type="button"
            aria-pressed={c.code === code}
            onClick={() => setCode(c.code)}
            className={`min-h-9 rounded-full px-3.5 text-[13px] transition ${c.code === code ? "bg-surface font-semibold text-ink shadow-sm" : "text-ink-3 hover:text-ink"}`}
          >
            {tr(countryName(c.code)!)}
          </button>
        ))}
      </fieldset>
      <div className="mt-2 grid grid-cols-[minmax(0,1fr)]">
        {shown.map((c) => (
          <ol key={c.code} aria-hidden={c.code !== code} className={`col-start-1 row-start-1 divide-y divide-line-soft ${c.code === code ? "" : "invisible"}`}>
            {c.items.map((item, i) => (
              <li
                key={`${item.at}-${item.title}`}
                className={`flex flex-col gap-0.5 py-2 sm:flex-row sm:items-baseline sm:gap-3 ${c.code === code ? "animate-fade-up" : ""}`}
                style={{ animationDelay: `${i * 70}ms` }}
              >
                {item.removed ? (
                  <span className="text-[14px] leading-snug text-ink-4">{tr("（该条已撤下）")}</span>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate text-[14px] leading-snug text-ink">{(english && item.titleEn) || item.title}</span>
                    <span className="shrink-0 text-[12px] text-ink-4 sm:whitespace-nowrap">
                      {item.source} · {monthDayTime(item.at)}
                    </span>
                  </>
                )}
              </li>
            ))}
          </ol>
        ))}
      </div>
      <Link to="/" className="mt-1 inline-flex min-h-10 items-center text-[13px] font-semibold text-accent hover:text-hot">
        {tr("打开首页看本国最新动态")} →
      </Link>
    </div>
  );
}
