// Small building blocks shared by feed items, detail pages and lists.
import { useState } from "react";
import type { FeedItemSummary } from "@amp/contracts/site";
import { IconBookmark } from "../../components/icons";
import { toggleStar, useIsStarred } from "../../lib/local-state";

/** The source's name, e.g. "IT之家". */
export function SourceLine({ item, className = "" }: { item: Pick<FeedItemSummary, "source">; className?: string }) {
  return <span className={`min-w-0 truncate ${className}`}>{item.source.name}</span>;
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
  const starred = useIsStarred(item.id);
  const [pulse, setPulse] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const on = starred;
  return (
    <>
      <button
        type="button"
        aria-pressed={on}
        aria-label={on ? "取消收藏" : "收藏"}
        title={on ? "取消收藏" : "收藏"}
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
        <span role="alert" className="relative z-20 text-[12px] text-hot">
          {error}
        </span>
      )}
    </>
  );
}

/** Attribution is supplied by the publication permission projection, never guessed from a host. */
export function Attribution({ value, full = false }: { value: FeedItemSummary["attribution"]; full?: boolean }) {
  if (!value) return null;
  return (
    <div className="relative z-10 my-2 text-[12px] leading-relaxed text-ink-3">
      {value.publishers.length > 0 && (
        <p>
          来源署名：
          {value.publishers.map((publisher, i) => (
            <span key={`${publisher.url}:${publisher.name}`}>
              {i > 0 ? "、" : ""}
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
              许可：
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
              查看来源官网最新法律信息
            </a>
          )}
        </>
      )}
    </div>
  );
}
