// The real newest items of each home-page country, switchable (TASK-0367). Both lists are drawn in the same cell and
// only the chosen one is visible, so switching never moves the page; each title opens the item's own page, which
// answers as usual if the item has since been taken down. Without data: a still sketch and the way to the home page.
import { useState } from "react";
import { IntentLink as Link } from "../../../components/ui/IntentLink";
import { useLocale, useTr } from "../../../i18n";
import { dateFormatFor } from "../../../lib/format";
import { countryName } from "./format";
import type { LiveCountry } from "./types";

export function Sketch({ rows = 5 }: { rows?: number }) {
  return (
    <svg viewBox={`0 0 200 ${rows * 16}`} className="h-auto w-full text-accent" aria-hidden="true">
      {[...Array(rows).keys()].map((i) => (
        <g key={i} className="anim-fade-in" style={{ animationDelay: `${i * 90}ms` }}>
          <rect x={0} y={i * 16 + 4} width={3} height={8} rx={1} className="fill-current" />
          <rect x={10} y={i * 16 + 5} width={150 - (i % 3) * 22} height={6} rx={3} className="fill-current" opacity={0.28} />
          <rect x={172} y={i * 16 + 5} width={28} height={6} rx={3} className="fill-current" opacity={0.14} />
        </g>
      ))}
    </svg>
  );
}

export function CountryLatest({ countries }: { countries: LiveCountry[] | null }) {
  const tr = useTr();
  const english = useLocale() === "en";
  const { monthDayTime } = dateFormatFor(english);
  const shown = (countries ?? []).filter((c) => countryName(c.code) && c.items.length);
  const [code, setCode] = useState(shown[0]?.code ?? null);
  if (!shown.length)
    return (
      <div>
        <Sketch />
        <Link to="/" className="mt-2 inline-flex min-h-10 items-center text-[13px] font-semibold text-accent hover:text-hot">
          {tr("打开首页看本国最新动态")} →
        </Link>
      </div>
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
      <div className="mt-2 grid">
        {shown.map((c) => (
          <ol key={c.code} aria-hidden={c.code !== code} className={`col-start-1 row-start-1 divide-y divide-line-soft ${c.code === code ? "" : "invisible"}`}>
            {c.items.map((item, i) => (
              <li key={item.id} className={c.code === code ? "animate-fade-up" : ""} style={{ animationDelay: `${i * 70}ms` }}>
                <Link
                  to={`/items/${item.id}`}
                  tabIndex={c.code === code ? undefined : -1}
                  className="group flex flex-col gap-0.5 py-2 sm:flex-row sm:items-baseline sm:gap-3"
                >
                  <span className="min-w-0 flex-1 truncate text-[14px] leading-snug text-ink group-hover:text-accent">
                    {(english && item.titleEn) || item.title}
                  </span>
                  <span className="shrink-0 text-[12px] text-ink-4 sm:whitespace-nowrap">
                    {item.source} · {monthDayTime(item.at)}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        ))}
      </div>
    </div>
  );
}
