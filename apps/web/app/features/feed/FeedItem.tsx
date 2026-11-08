// One report in a feed. Desktop (≥ 961px): a white card beside the time rail. Mobile: a compact row
// with a divider and a short recommendation. One markup serves both layouts.
import { markRead, useIsRead } from "../../lib/local-state";
import { useCategoryLabel, useLocale, useT, useTagLabel } from "../../i18n";
import { beijingDate, beijingTime, isDateOnlyInstant, NO_TIME } from "../../lib/format";
import { memo } from "react";
import { Link } from "../../i18n/navigation";
import { IntentLink } from "../../components/ui/IntentLink";
import type { GroupInfo, ReportGroupInfo, FeedItemSummary, StoryProgress } from "@amp/contracts/site";
import { XPostFeedView } from "@amp/contracts/http/public";
import { SelectedBadge } from "../../components/ui/Badge.tsx";
import { ScoreLabel } from "../../components/ui/Score.tsx";
import { SourceLine, StarButton, Attribution } from "./parts";
import { GroupDevelopments, GroupSources, LatestDevelopment, type ReadingGroupFilters } from "./ReadingGroup";
import { PostAuthor, PostMedia, QuotedPost } from "../item/OriginalPost";
import { StoryProgressLine } from "./StoryProgressLine";

export interface FeedItemProps {
  item: FeedItemSummary;
  at?: string;
  read?: boolean;
  group?: GroupInfo | null;
  reportGroup?: ReportGroupInfo | null;
  /** Where this report's development sits in its story, when the story has more than this step. */
  storyProgress?: StoryProgress | null;
  filters?: ReadingGroupFilters;
  /** Show category and tags under the text (全部动态, topics, search). */
  showTags?: boolean;
}

export const FeedItem = memo(function FeedItem({
  item,
  group,
  reportGroup,
  storyProgress,
  filters,
  at = item.timelineAt,
  read: readOverride,
  showTags = false,
}: FeedItemProps) {
  const tl = useT().list;
  const cat = useCategoryLabel();
  const tagLabel = useTagLabel();
  // On the English interface a card shows the item's English title and summary when it has them (TASK-0595, Owner
  // 2026-11-08); otherwise its Chinese copy, marked as Chinese (brief: 中文导读加 lang="zh-CN").
  const english = useLocale() === "en";
  const copy = english ? (item.english ?? null) : null;
  const title = copy?.title ?? item.title;
  const summary = copy?.summary ?? item.summary;
  const contentLang = english && !copy ? "zh-CN" : undefined;
  // The recommendation stays Chinese: marked so under an English title.
  const reasonLang = copy ? "zh-CN" : undefined;
  const markedRead = useIsRead(item.id);
  const read = readOverride ?? markedRead;
  const dateOnly =
    isDateOnlyInstant(at) && !(item.sourceTime?.utc && Date.parse(item.sourceTime.utc) === Date.parse(at) && item.sourceTime.precision !== "date");
  const showSources = reportGroup
    ? reportGroup.reportCount > 1
    : !!group && (group.additionalSourceCount > 0 || (group.developmentCount <= 1 && group.reportCount > 1));
  const showDevelopments = !!group?.story && group.developmentCount > 1;
  const tags = showTags ? item.tags.slice(0, 3) : [];
  const post = item.x ? XPostFeedView.parse(item.x) : null;

  return (
    <article
      lang={contentLang}
      className="relative min-w-0 lg:card lg:card-hover lg:px-[18px] lg:pb-[14px] lg:pt-[15px]"
      data-item-id={item.id}
      data-member-ids={JSON.stringify(reportGroup?.memberIds ?? group?.memberIds ?? [])}
    >
      <header className="flex min-h-[18px] items-center gap-2 text-[13.5px] leading-[18px] text-ink-4">
        <SourceLine item={item} className="text-ink-4" />
        <time dateTime={dateOnly ? beijingDate(at) : at} title={dateOnly ? tl.dateArchive : tl.siteTimeline} className="mono shrink-0 text-[13px] lg:hidden">
          · {dateOnly ? NO_TIME : beijingTime(at)}
        </time>
        {read && <span className="shrink-0 text-[12px] text-ink-4">{tl.read}</span>}
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
      {post && <PostAuthor post={post} />}

      <h3 className={`mt-2 line-clamp-2 text-[17px] font-bold leading-[1.55] lg:line-clamp-none lg:font-[650] ${read ? "text-ink-3" : "text-ink"}`}>
        <IntentLink onClick={() => markRead(item.id)} to={`/items/${item.id}`} className="feed-title after:absolute after:inset-0 after:content-['']">
          {title}
        </IntentLink>
      </h3>
      <Attribution value={item.attribution} />
      {summary && <p className="mt-1.5 line-clamp-2 text-[15.5px] leading-[1.75] text-ink-3 lg:mt-2 lg:line-clamp-3 lg:text-[16px]">{summary}</p>}
      {post && <PostMedia key={item.id} media={post.media} href={`/items/${item.id}`} compact />}
      {post?.quoted && <QuotedPost quoted={post.quoted} compact />}

      {(tags.length > 0 || (showTags && item.category)) && (
        <div className="relative z-10 mt-2 hidden flex-wrap gap-x-2.5 gap-y-1 text-[13px] text-ink-4 lg:flex">
          {showTags && item.category && (
            <Link to={`/all?category=${item.category}`} className="hover:text-accent">
              {cat(item.category)}
            </Link>
          )}
          {tags.map((t) => (
            <Link key={t} to={`/all?tag=${encodeURIComponent(t)}`} className="hover:text-accent">
              #{tagLabel(t)}
            </Link>
          ))}
        </div>
      )}

      {storyProgress ? <StoryProgressLine progress={storyProgress} /> : group && <LatestDevelopment group={group} />}
      {(showSources || showDevelopments) && (
        <div className="mt-2 flex flex-wrap items-start gap-x-4 gap-y-1">
          {showSources && <GroupSources group={reportGroup ?? group!} filters={filters} parentId={item.id} />}
          {showDevelopments && <GroupDevelopments group={{ ...group!, story: group!.story! }} filters={filters} parentId={item.id} />}
        </div>
      )}

      {item.reason && (
        <div className="mt-2.5 lg:mt-3 lg:border-t lg:border-line-soft lg:bg-transparent lg:px-0 lg:pb-0 lg:pt-3 lg:dark:bg-transparent">
          <p className="line-clamp-1 text-[14px] leading-[1.65] text-ink-3 lg:line-clamp-none lg:leading-[1.75] lg:text-note">
            {tl.reason}
            <span lang={reasonLang}>{item.reason}</span>
          </p>
        </div>
      )}
    </article>
  );
});
