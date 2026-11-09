// Small building blocks shared by feed items, detail pages and lists.
import { useState } from "react";
import { useT, useTr } from "../../i18n";
import type { FeedItemSummary } from "@amp/contracts/site";
import { IconBookmark } from "../../components/icons";
import { toggleStar, useIsStarred } from "../../lib/local-state";

/** The source's name, e.g. "IT之家". */
export function SourceLine({ item, className = "" }: { item: Pick<FeedItemSummary, "source" | "attribution">; className?: string }) {
  const credit = soleCredit(item);
  // When the only credited publisher is the source named here, the name itself is the credit and its link
  // (TASK-0587, Owner 2026-11-07: the card said the same source twice).
  if (credit)
    return (
      <a
        href={credit.url}
        target="_blank"
        rel="noopener noreferrer"
        className={`relative z-10 min-w-0 truncate hover:text-accent hover:underline ${className}`}
      >
        {item.source.name}
      </a>
    );
  return <span className={`min-w-0 truncate ${className}`}>{item.source.name}</span>;
}

/** The credited publisher when there is exactly one and it is the source itself; null when the credit adds a name. */
export function soleCredit(item: Pick<FeedItemSummary, "source" | "attribution">) {
  const publishers = item.attribution?.publishers ?? [];
  return publishers.length === 1 && publishers[0]!.name.trim() === item.source.name.trim() ? publishers[0]! : null;
}

/** Bookmark toggle kept in this browser (收藏). */
export function StarButton({
  item,
  size = 26,
  className = "",
}: {
  item: Pick<FeedItemSummary, "id" | "title" | "summary" | "source" | "publishedAt" | "score" | "selected">;
  size?: number;
  className?: string;
}) {
  const tl = useT().list;
  const tr = useTr();
  const starred = useIsStarred(item.id);
  const [pulse, setPulse] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const on = starred;
  return (
    <>
      <button
        type="button"
        aria-pressed={on}
        aria-label={on ? tl.unsave : tl.save}
        title={on ? tl.unsave : tl.save}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const result = toggleStar({ id: item.id });
          setError(result.ok ? null : result.message);
          if (result.ok && result.added) setPulse((p) => p + 1);
        }}
        style={{ width: size, height: size }}
        className={`relative z-10 inline-flex shrink-0 items-center justify-center rounded-control transition-colors duration-150 ${on ? "text-accent" : "text-ink-4 hover:bg-bg-sunk hover:text-ink-2"} ${className}`}
      >
        <span key={pulse} className={`flex ${pulse ? "anim-bump" : ""}`}>
          <IconBookmark size={Math.round(size * 0.6)} filled={on} />
        </span>
      </button>
      {error && (
        <span role="alert" className="relative z-20 text-[13px] text-hot">
          {tr.maybe(error)}
        </span>
      )}
    </>
  );
}

/** Attribution is supplied by the publication permission projection, never guessed from a host. */
export function Attribution({
  value,
  full = false,
  publishers = true,
}: {
  value: FeedItemSummary["attribution"];
  full?: boolean;
  /** False where the source name next to it already credits and links the one publisher (see SourceLine). */
  publishers?: boolean;
}) {
  const tl = useT().list;
  const tr = useTr();
  if (!value) return null;
  const extra = full && (value.license || value.notice || value.legalUrl);
  if (!publishers && !extra) return null;
  return (
    <div className="relative z-10 my-2 text-[13px] leading-relaxed text-ink-3">
      {publishers && value.publishers.length > 0 && (
        <p>
          {tl.attribution}
          {value.publishers.map((publisher, i) => (
            <span key={`${publisher.url}:${publisher.name}`}>
              {i > 0 ? tr("、") : ""}
              <a href={publisher.url} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                {publisher.name}
              </a>
            </span>
          ))}
        </p>
      )}
      {full && (
        <>
          {value.license && (
            <p>
              {tl.license}
              {value.license.url ? (
                <a href={value.license.url} target="_blank" rel="noopener noreferrer" className="text-accent">
                  {value.license.name}
                </a>
              ) : (
                value.license.name
              )}
            </p>
          )}
          {value.notice && <p>{value.notice}</p>}
          {value.legalUrl && (
            <a href={value.legalUrl} target="_blank" rel="noopener noreferrer" className="text-accent">
              {tl.legalInfo}
            </a>
          )}
        </>
      )}
    </div>
  );
}
