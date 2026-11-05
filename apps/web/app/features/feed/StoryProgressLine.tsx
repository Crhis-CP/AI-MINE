// "事件进展 · 第 2 次 · 上次：11月1日 下调指引": a picked report that continues a story says so, and links
// to the story's line of developments. Shown only when the story has more than this one step.
import type { StoryProgress } from "@amp/contracts/site";
import { IntentLink as Link } from "../../components/ui/IntentLink";
import { IconChevronRight } from "../../components/icons";
import { useDateFormat, useTr } from "../../i18n";
import { beijingDate } from "../../lib/format";

export function StoryProgressLine({ progress }: { progress: StoryProgress }) {
  const tr = useTr();
  const df = useDateFormat();
  const day = (iso: string) => df.monthDay(beijingDate(iso));
  const single = progress.developmentCount <= 1;
  const step = single
    ? tr("{count} 条历史背景", { count: progress.backgroundCount })
    : progress.position > 1
      ? tr("第 {n} 次", { n: progress.position })
      : tr("共 {count} 次", { count: progress.developmentCount });
  const other = progress.position > 1 ? progress.previous : progress.latest;
  return (
    <Link
      to={`/story/${progress.story.publicId}`}
      className="group/progress relative z-10 mt-2.5 flex min-w-0 items-baseline gap-1.5 text-[14px] leading-relaxed"
      data-story-progress={progress.story.publicId}
    >
      <span className="shrink-0 font-medium text-accent">{single ? tr("事件脉络") : tr("事件进展")}</span>
      <span className="shrink-0 text-ink-4">· {step}</span>
      {!single && other && (
        <span className="line-clamp-1 min-w-0 text-ink-3 transition-colors group-hover/progress:text-accent">
          · {progress.position > 1 ? tr("上次：") : tr("最新：")}
          <span className="num">{day(other.at)}</span> {other.title}
        </span>
      )}
      <IconChevronRight size={13} className="shrink-0 self-center text-ink-4" />
    </Link>
  );
}
