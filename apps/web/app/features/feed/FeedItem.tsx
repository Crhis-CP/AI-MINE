// One report in a feed. Desktop (≥ 961px): a white card beside the time rail. Mobile: a compact row
// with a divider and a short recommendation. One markup serves both layouts.
import { markRead, useIsRead } from "../../lib/local-state";
import { beijingDate, beijingTime, isDateOnlyInstant, NO_TIME } from "../../lib/format";
import { memo } from "react";
import { Link } from "react-router";
import { IntentLink } from "../../components/ui/IntentLink";
import type { GroupInfo, FeedItemSummary, TimelineFilters } from "@amp/contracts/site";
import { CATEGORY_LABELS } from "@amp/industry/taxonomy";
import { SelectedBadge } from "../../components/ui/Badge.tsx";
import { ScoreLabel } from "../../components/ui/Score.tsx";
import { SourceLine, StarButton, Attribution } from "./parts";
import { GroupDevelopments, GroupSources, LatestDevelopment } from "./ReadingGroup";

export interface FeedItemProps {
  item: FeedItemSummary;
  at?: string;
  group?: GroupInfo | null;
  filters?: TimelineFilters;
  /** Show category and tags under the text (全部动态, topics, search). */
  showTags?: boolean;
}

export const FeedItem = memo(function FeedItem({ item, group, filters, at = item.timelineAt, showTags = false }: FeedItemProps) {
  const read = useIsRead(item.id);
  const dateOnly =
    isDateOnlyInstant(at) && !(item.sourceTime?.utc && Date.parse(item.sourceTime.utc) === Date.parse(at) && item.sourceTime.precision !== "date");
  const showSources = !!group && (group.additionalSourceCount > 0 || (group.developmentCount <= 1 && group.reportCount > 1));
  const showDevelopments = !!group?.story && group.developmentCount > 1;
  const tags = showTags ? item.tags.slice(0, 3) : [];

  return (
    <article className="relative min-w-0 lg:card lg:card-hover lg:px-[18px] lg:pb-[14px] lg:pt-[15px]" data-item-id={item.id}>
      <header className="flex min-h-[18px] items-center gap-2 text-[12.5px] leading-[18px] text-ink-4">
        <SourceLine item={item} className="text-ink-4" />
        <time dateTime={dateOnly ? beijingDate(at) : at} title={dateOnly ? "按日期归档" : "本站时间线"} className="mono shrink-0 text-[12px] lg:hidden">
          · {dateOnly ? NO_TIME : beijingTime(at)}
        </time>
        {read && <span className="shrink-0 text-[11px] text-ink-4">已读</span>}
        {item.selected && (
          <span className="hidden lg:inline-flex">
            <SelectedBadge />
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
          <span className="hidden lg:inline-flex">
            <ScoreLabel score={item.score} />
          </span>
          <span className="lg:hidden">
            <ScoreLabel score={item.score} compact />
          </span>
          <span className="-my-1 inline-flex">
            <StarButton item={item} />
          </span>
        </span>
      </header>

      <h3 className={`mt-2 line-clamp-2 text-[17px] font-bold leading-[1.55] lg:line-clamp-none lg:font-[650] ${read ? "text-ink-3" : "text-ink"}`}>
        <IntentLink onClick={() => markRead(item.id)} to={`/items/${item.id}`} className="feed-title after:absolute after:inset-0 after:content-['']">
          {item.title}
        </IntentLink>
      </h3>
      <Attribution value={item.attribution} />
      {item.summary && <p className="mt-1.5 line-clamp-2 text-[14.5px] leading-[1.75] text-ink-3 lg:mt-2 lg:line-clamp-3 lg:text-[15px]">{item.summary}</p>}

      {(tags.length > 0 || (showTags && item.category)) && (
        <div className="relative z-10 mt-2 hidden flex-wrap gap-x-2.5 gap-y-1 text-[12px] text-ink-4 lg:flex">
          {showTags && item.category && (
            <Link to={`/all?category=${item.category}`} className="hover:text-accent">
              {CATEGORY_LABELS[item.category]}
            </Link>
          )}
          {tags.map((t) => (
            <Link key={t} to={`/all?tag=${encodeURIComponent(t)}`} className="hover:text-accent">
              #{t}
            </Link>
          ))}
        </div>
      )}

      {group && <LatestDevelopment group={group} />}
      {(showSources || showDevelopments) && (
        <div className="mt-2 flex flex-wrap items-start gap-x-4 gap-y-1">
          {showSources && <GroupSources group={group!} filters={filters} parentId={item.id} />}
          {showDevelopments && <GroupDevelopments group={{ ...group!, story: group!.story! }} filters={filters} parentId={item.id} />}
        </div>
      )}

      {item.reason && (
        <div className="mt-2.5 lg:mt-3 lg:border-t lg:border-line-soft lg:bg-transparent lg:px-0 lg:pb-0 lg:pt-3 lg:dark:bg-transparent">
          <p className="line-clamp-1 text-[13px] leading-[1.65] text-ink-3 lg:line-clamp-none lg:leading-[1.75] lg:text-note">推荐理由：{item.reason}</p>
        </div>
      )}
    </article>
  );
});
