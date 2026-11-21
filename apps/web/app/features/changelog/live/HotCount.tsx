// How many events are on the hot list right now (TASK-0367): the real count of its window, with the time it was taken.
// Without data the block names the rule and leads to the list, with no number at all.
import { IntentLink as Link } from "../../../components/ui/IntentLink";
import { useLocale, useTr } from "../../../i18n";
import { dateFormatFor } from "../../../lib/format";
import type { LiveHot } from "./types";

export function HotCount({ hot }: { hot: LiveHot | null }) {
  const tr = useTr();
  const { monthDayTime } = dateFormatFor(useLocale() === "en");
  return (
    <div>
      {hot && (
        <p className="flex items-baseline gap-2">
          <span className="anim-pop-in num text-[44px] font-black leading-none text-hot">{hot.count}</span>
          <span className="text-[13px] leading-snug text-ink-2">{tr("件事件在热点榜上")}</span>
        </p>
      )}
      <p className="mt-2 text-[12.5px] leading-[1.7] text-ink-3">
        {tr("最近 {hours} 小时内被至少两家独立来源报道的矿业事件，符合条件的全部列出。", { hours: hot?.windowHours ?? 72 })}
        {hot?.computedAt && <span className="text-ink-4"> {tr("统计于 {time}", { time: monthDayTime(hot.computedAt) })}</span>}
      </p>
      <Link to="/hot" className="mt-1 inline-flex min-h-10 items-center text-[13px] font-semibold text-accent hover:text-hot">
        {tr("看现在的热点榜")} →
      </Link>
    </div>
  );
}
