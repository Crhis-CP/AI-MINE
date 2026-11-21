// The top of the hot list when the film was recorded (TASK-0367), with the rule that admits events and the way to
// today's list. Without the figure the block names the rule only, with no number at all.
import { IntentLink as Link } from "../../../components/ui/IntentLink";
import { useTr } from "../../../i18n";
import type { FilmHot } from "./types";

/**
 * “热点榜上排在前面的 50 件”, the number large. Said as the top of the list, not as all that qualify: the list the
 * recording read is capped, so its count is not the number of qualifying events.
 */
function TopOfList({ count }: { count: number }) {
  const tr = useTr();
  const sentence = tr("热点榜上排在前面的 {n} 件", { n: count });
  const at = sentence.indexOf(String(count));
  return (
    <p className="text-[13px] leading-snug text-ink-2">
      {sentence.slice(0, at)}
      <span className="anim-pop-in num inline-block text-[40px] font-black leading-none text-hot">{count}</span>
      {sentence.slice(at + String(count).length)}
    </p>
  );
}

export function HotCount({ hot }: { hot: FilmHot | null }) {
  const tr = useTr();
  return (
    <div>
      {hot && <TopOfList count={hot.count} />}
      <p className="mt-2 text-[12.5px] leading-[1.7] text-ink-3">
        {tr("最近 {hours} 小时内被至少两家独立来源报道的矿业事件，按热度排列。", { hours: hot?.windowHours ?? 72 })}
      </p>
      <Link to="/hot" className="mt-1 inline-flex min-h-10 items-center text-[13px] font-semibold text-accent hover:text-hot">
        {tr("看现在的热点榜")} →
      </Link>
    </div>
  );
}
