// A page of reports grouped by Beijing day with the same rail and rows as the home timeline
// (全部动态, topics, search results, 收藏).
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import type { FeedItemSummary, ReportGroupedTimelineCard } from "@amp/contracts/site";
import { IconChevronRight } from "../../components/icons";
import { beijingDate } from "../../lib/format";
import { DayHeader, TimelineSlot } from "./Timeline";
import { useReaderItemScope } from "./ContentVersionGuard";
import { FeedItem } from "./FeedItem";
import type { ReadingGroupFilters } from "./ReadingGroup";

export function DayList({
  items,
  cards,
  filters,
  todayCount = null,
  showTags = true,
  animate = false,
}: {
  items: FeedItemSummary[];
  cards?: ReportGroupedTimelineCard[];
  filters?: ReadingGroupFilters;
  todayCount?: number | null;
  showTags?: boolean;
  animate?: boolean;
}) {
  const allowedIds = useReaderItemScope();
  const today = beijingDate(Date.now());
  const location = useLocation();
  const foldKey = `amp:day-fold:${location.pathname}${location.search}`;
  const [collapsed, setCollapsed] = useState<string[]>([]);
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(foldKey) ?? "[]");
      setCollapsed(Array.isArray(saved) ? saved.filter((v) => typeof v === "string") : []);
    } catch {
      setCollapsed([]);
    }
  }, [foldKey]);
  const toggleDay = (day: string) =>
    setCollapsed((prev) => {
      const next = prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day];
      try {
        sessionStorage.setItem(foldKey, JSON.stringify(next));
      } catch {
        /* Folding still works for this view. */
      }
      return next;
    });
  const days = useMemo(() => {
    const out: Array<{ day: string; items: FeedItemSummary[] }> = [];
    for (const it of items) {
      if (allowedIds && !allowedIds.has(it.id)) continue;
      const d = beijingDate(cards?.find((card) => card.item.id === it.id)?.anchorAt ?? it.timelineAt);
      const last = out[out.length - 1];
      if (last && last.day === d) last.items.push(it);
      else out.push({ day: d, items: [it] });
    }
    return out;
  }, [items, cards, allowedIds]);
  let order = 0;
  return (
    <div>
      {days.map(({ day, items: list }) => (
        <section key={day} aria-label={day}>
          <DayHeader
            day={day}
            today={today}
            count={day === today ? todayCount : list.length}
            collapsed={collapsed.includes(day)}
            onToggle={() => toggleDay(day)}
          />
          <ol className="lg:pt-1" hidden={collapsed.includes(day)}>
            {list.map((it) => (
              <TimelineSlot
                key={it.id}
                at={cards?.find((card) => card.item.id === it.id)?.anchorAt ?? it.timelineAt}
                sourceTime={it.sourceTime}
                fresh={animate}
                delay={animate ? Math.min(order++, 12) * 25 : 0}
              >
                <FeedItem
                  item={it}
                  group={cards?.find((card) => card.item.id === it.id)?.group}
                  reportGroup={cards?.find((card) => card.item.id === it.id)?.reportGroup}
                  at={cards?.find((card) => card.item.id === it.id)?.anchorAt ?? it.timelineAt}
                  filters={cards ? { channel: "all", category: null, tag: null, ...filters, scope: "all" } : undefined}
                  showTags={showTags}
                />
              </TimelineSlot>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

/** Numbered pages (the list stays crawlable), with previous / next at the ends. */
export function Pagination({ page, pageCount, href }: { page: number; pageCount: number; href: (p: number) => string }) {
  const navigate = useNavigate();
  if (pageCount <= 1) return null;
  const pages = [...new Set([1, pageCount, page - 2, page - 1, page, page + 1, page + 2].filter((p) => p >= 1 && p <= pageCount))].sort((a, b) => a - b);
  const btn = "inline-flex h-9 min-w-9 items-center justify-center rounded-full px-2.5 text-[13px] transition-colors";
  return (
    <nav aria-label="分页" className="mt-6 flex flex-wrap items-center justify-center gap-1">
      {page > 1 && (
        <Link to={href(page - 1)} className={`${btn} border border-line-strong bg-surface px-3 text-ink-3 hover:border-ink-4 hover:text-ink`}>
          上一页
        </Link>
      )}
      {pages.map((p, i) => (
        <span key={p} className="flex items-center gap-1">
          {i > 0 && p - pages[i - 1]! > 1 && <span className="px-0.5 text-ink-4">…</span>}
          <Link
            to={href(p)}
            aria-current={p === page ? "page" : undefined}
            className={`num ${btn} ${p === page ? "bg-ink font-semibold text-bg" : "text-ink-3 hover:bg-bg-sunk hover:text-ink"}`}
          >
            {p}
          </Link>
        </span>
      ))}
      {page < pageCount && (
        <Link to={href(page + 1)} className={`${btn} gap-0.5 border border-line-strong bg-surface px-3 text-ink-3 hover:border-ink-4 hover:text-ink`}>
          下一页 <IconChevronRight size={14} />
        </Link>
      )}
      <form
        className="ml-2 flex items-center gap-2 text-[13px]"
        onSubmit={(event) => {
          event.preventDefault();
          const value = Number(new FormData(event.currentTarget).get("jump"));
          if (Number.isFinite(value)) navigate(href(Math.max(1, Math.min(pageCount, Math.floor(value)))));
        }}
      >
        <label>
          跳到第{" "}
          <input
            name="jump"
            type="number"
            min="1"
            required
            defaultValue={page}
            key={page}
            aria-label="跳到第几页"
            className="w-16 rounded-control border border-line bg-surface px-2 py-1"
          />{" "}
          页
        </label>
        <button type="submit" className={`${btn} border border-line`}>
          跳转
        </button>
      </form>
    </nav>
  );
}
