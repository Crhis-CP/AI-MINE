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
  const on = starred;
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? "取消收藏" : "收藏"}
      title={on ? "取消收藏" : "收藏"}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const added = toggleStar({
          id: item.id,
          title: item.title,
          summary: item.summary,
          sourceName: item.source.name,
          publishedAt: item.publishedAt,
          score: item.score,
          aiSelected: item.selected,
        });
        if (added) setPulse((p) => p + 1);
      }}
      style={{ width: size, height: size }}
      className={`relative z-10 inline-flex shrink-0 items-center justify-center rounded-control transition-colors duration-150 ${on ? "text-accent" : "text-ink-4 hover:bg-bg-sunk hover:text-ink-2"} ${className}`}
    >
      <span key={pulse} className={`flex ${pulse ? "anim-bump" : ""}`}>
        <IconBookmark size={Math.round(size * 0.6)} filled={on} />
      </span>
    </button>
  );
}
