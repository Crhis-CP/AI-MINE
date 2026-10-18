import { Link } from "react-router";
import type { HotStripEntry, TimelineCard } from "@amp/contracts/site";
import { EmptyState } from "../../components/ui/Page";
import { IconArrowRight, IconMinus, IconTrendDown, IconTrendUp } from "../../components/icons";

// As on the original list: the top three in the ranking colours at the heaviest weight.
const RANK_COLOR = ["text-[15px] font-black text-rank-1", "text-[15px] font-black text-rank-2", "text-[15px] font-black text-rank-3"];

function hrefOf(e: HotStripEntry): string {
  return e.storyPublicId ? `/story/${e.storyPublicId}` : e.itemId ? `/items/${e.itemId}` : "/hot";
}

/** Where the heat is heading, as a small arrow (a "新" mark for a story new to the ranking). */
function TrendMark({ trend }: { trend: HotStripEntry["trend"] }) {
  if (trend === "up") return <IconTrendUp size={14} strokeWidth={2.2} className="text-hot" aria-label="热度上升" />;
  if (trend === "down") return <IconTrendDown size={14} strokeWidth={2.2} className="text-ink-4" aria-label="热度回落" />;
  if (trend === "new") return <span className="rounded-full bg-accent-soft px-1.5 text-[10.5px] font-semibold leading-4 text-accent">新</span>;
  if (trend === "unknown") return null; // sources behind on collection: no comparison to show
  return <IconMinus size={14} strokeWidth={2.2} className="text-ink-4" aria-label="热度持平" />;
}

/** Representative source already on this page's featured card, plus how many other outlets folded under it. */
function sourcesUnder(entry: HotStripEntry, cards: TimelineCard[] | undefined): string | null {
  const card = cards?.find(
    (item) => (entry.itemId != null && item.item.id === entry.itemId) || (entry.storyPublicId != null && item.group?.story?.publicId === entry.storyPublicId),
  );
  if (!card?.item.source.name) return null;
  const others = card.group && card.group.reportCount > 1 ? card.group.additionalSourceCount : 0;
  return others > 0 ? `${card.item.source.name} · 另有 ${others} 家来源` : card.item.source.name;
}

/**
 * Hotspot board above 精选: one folded event per row, heat when it is a positive number, and an honest
 * empty state when nothing qualifies. The whole row lights up on hover.
 */
export function HotTopics({ entries, cards }: { entries: HotStripEntry[]; cards?: TimelineCard[] }) {
  return (
    <section
      aria-labelledby="hot-topics"
      className="card relative mb-6 overflow-hidden bg-[radial-gradient(120%_90%_at_100%_0%,var(--hot-soft),transparent_55%)] px-4 pb-2 pt-3.5 lg:px-5"
    >
      <div className="mb-1 flex items-center justify-between">
        <h2 id="hot-topics" className="flex items-center gap-2 text-[14px] font-semibold text-ink">
          <span className="relative flex size-2" aria-hidden="true">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-hot opacity-40" />
            <span className="relative inline-flex size-2 rounded-full bg-hot" />
          </span>
          热点榜
        </h2>
        <Link to="/hot" className="group inline-flex items-center gap-1 text-[12.5px] text-ink-3 transition-colors hover:text-accent">
          完整榜单 <IconArrowRight size={13} className="transition-transform duration-200 group-hover:translate-x-0.5" />
        </Link>
      </div>
      {entries.length === 0 ? (
        <EmptyState title="暂时没有热点">还没有足够多来源共同讨论的事件。</EmptyState>
      ) : (
        <ol>
          {entries.slice(0, 5).map((e, i) => {
            const sources = sourcesUnder(e, cards);
            return (
              <li key={e.rank}>
                <Link
                  to={hrefOf(e)}
                  className="group -mx-2 grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-x-3 rounded-tile px-2 py-2 transition-colors hover:bg-bg-sunk/70 sm:grid-cols-[20px_minmax(0,1fr)_64px_20px] sm:gap-x-4 dark:hover:bg-bg-muted/40"
                >
                  <span className={`num text-center leading-none ${RANK_COLOR[i] ?? "text-[14px] font-bold text-rank-rest"}`}>{e.rank}</span>
                  <span className="min-w-0">
                    <span className="line-clamp-2 block text-[14px] font-semibold leading-[1.5] text-ink transition-colors group-hover:text-accent lg:line-clamp-1">
                      {e.title}
                    </span>
                    {sources && <span className="mt-0.5 block truncate text-[12px] leading-snug text-ink-4">{sources}</span>}
                  </span>
                  <span className="flex items-center justify-end gap-2.5 sm:contents">
                    {Number.isFinite(e.heat) && e.heat > 0 ? (
                      <span className="whitespace-nowrap text-right text-[12.5px] text-ink-4" title="热度指数">
                        <span className="num text-[13.5px] font-semibold text-ink-2">{Math.round(e.heat)}</span> 热度
                      </span>
                    ) : (
                      <span />
                    )}
                    <span className="flex w-5 justify-center">
                      <TrendMark trend={e.trend} />
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
