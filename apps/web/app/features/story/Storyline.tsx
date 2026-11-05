// The story as a line of developments: earlier background, one node per development (what changed, when,
// and its reports folded under it), and the dated milestones still ahead. Reports of one development are
// one node, not one row each, so six outlets carrying the same news read as one step of the story.
import { useState } from "react";
import type { StoryDetail, StoryFactView, StoryKeyChange, StoryNextMilestone, StoryReportView } from "@amp/contracts/site";
import { IntentLink as Link } from "../../components/ui/IntentLink";
import { Badge, SelectedBadge } from "../../components/ui/Badge.tsx";
import { IconArrowRight, IconChevronDown } from "../../components/icons";
import { useDateFormat, useT, useTr } from "../../i18n";
import { beijingDate, isDateOnlyInstant, newsSourceDate, shortSourceName } from "../../lib/format";

/** Background items shown before "展开其余". */
const BACKGROUND_PREVIEW = 3;

function useNodeDate() {
  const df = useDateFormat();
  return (iso: string) => (isDateOnlyInstant(iso) ? df.monthDay(beijingDate(iso)) : df.monthDayTime(iso));
}

/** Official first-party reports lead, then the order they were published in. */
export function developmentReports(timeline: StoryReportView[], factId: string): StoryReportView[] {
  return timeline
    .filter((r) => r.factId === factId)
    .sort((a, b) => Number(b.source.firstParty) - Number(a.source.firstParty) || Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
}

function Marker({ tone }: { tone: "latest" | "past" | "context" | "ahead" }) {
  const look = {
    latest: "bg-accent",
    past: "bg-ink-4",
    context: "border-2 border-line-strong bg-surface",
    ahead: "border-2 border-dashed border-accent bg-surface",
  }[tone];
  return <span className={`absolute left-0 top-[5px] size-[11px] rounded-full ring-4 ring-surface ${look}`} aria-hidden="true" />;
}

function ReportRow({ r }: { r: StoryReportView }) {
  const tr = useTr();
  const date = newsSourceDate(r.sourceTime, r.publishedAt);
  return (
    <li className="py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[12.5px] leading-[18px] text-ink-4">
        <span className="min-w-0 truncate">{shortSourceName(r.source.name)}</span>
        {r.source.firstParty && <Badge tone="ok">{tr("官方一手")}</Badge>}
        {r.selected && <SelectedBadge />}
        {date && (
          <time dateTime={date.dateTime} className="num">
            {date.text}
          </time>
        )}
      </div>
      <Link to={`/items/${r.id}`} className="mt-0.5 block text-[14.5px] font-medium leading-[1.6] text-ink-2 transition-colors hover:text-accent">
        {r.title}
      </Link>
    </li>
  );
}

function DevelopmentNode({
  d,
  reports,
  position,
  total,
  latest,
}: {
  d: StoryFactView;
  reports: StoryReportView[];
  position: number;
  total: number;
  latest: boolean;
}) {
  const tr = useTr();
  const tl = useT().list;
  const when = useNodeDate();
  const [open, setOpen] = useState(false);
  const sources = new Set(reports.map((r) => r.source.id)).size;
  const countLabel = sources === d.reportCount ? tr("{count} 家报道", { count: d.reportCount }) : `${d.reportCount} ${tr("篇报道")}`;
  const lead = reports[0] ?? d.representative;
  return (
    <li className="relative pb-7 pl-7 last:pb-0" data-development={d.factId}>
      <Marker tone={latest ? "latest" : "past"} />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-[20px] text-ink-4">
        <time dateTime={d.firstReportAt} className="num font-semibold text-ink-2">
          {when(d.firstReportAt)}
        </time>
        {total > 1 && <span>{tr("第 {n} 个进展", { n: position })}</span>}
        {latest && total > 1 && <Badge tone="accent">{tr("最新")}</Badge>}
      </div>
      <h3 className="mt-1 text-[17px] font-[650] leading-[1.55] text-ink">
        <Link to={`/items/${d.representative.id}`} className="transition-colors hover:text-accent">
          {d.title}
        </Link>
      </h3>
      {d.representative.summary && <p className="mt-1 line-clamp-3 text-[15px] leading-[1.75] text-ink-3">{d.representative.summary}</p>}
      {d.reportCount > 1 ? (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line-soft bg-bg-sunk px-3 py-1 text-[13px] text-ink-3 transition-colors hover:text-accent"
          >
            <span className="shrink-0 font-medium text-ink-2">{countLabel}</span>
            <span className="min-w-0 truncate">
              {lead.source.firstParty ? `${tr("官方一手")}：` : ""}
              {[...new Set(reports.map((r) => shortSourceName(r.source.name)))].slice(0, 3).join(" · ")}
            </span>
            <span className="shrink-0">· {open ? tl.collapse : tl.expand}</span>
            <IconChevronDown size={13} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
          {open && (
            <ol className="mt-1 divide-y divide-line-soft border-l-2 border-line-soft pl-3">
              {reports.map((r) => (
                <ReportRow key={r.id} r={r} />
              ))}
              {reports.length < d.reportCount && <li className="py-2 text-[12.5px] text-ink-4">{tr("更多报道见全部报道。")}</li>}
            </ol>
          )}
        </div>
      ) : (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[13px] text-ink-4">
          <span>{shortSourceName(d.representative.source.name)}</span>
          {d.representative.source.firstParty && <Badge tone="ok">{tr("官方一手")}</Badge>}
        </div>
      )}
    </li>
  );
}

function BackgroundNode({ background }: { background: NonNullable<StoryDetail["background"]> }) {
  const tr = useTr();
  const [open, setOpen] = useState(false);
  const shown = open ? background : background.slice(0, BACKGROUND_PREVIEW);
  return (
    <li className="relative pb-7 pl-7">
      <Marker tone="context" />
      <div className="text-[13px] leading-[20px] text-ink-4">{tr("此前背景")}</div>
      <h3 className="mt-1 text-[17px] font-[650] leading-[1.55] text-ink">{tr("历史背景")}</h3>
      <p className="mt-0.5 text-[13px] text-ink-4">{tr("最多展示10条相关背景报道；原文发布日期不代表事件发生日期。")}</p>
      <ul className="mt-1 divide-y divide-line-soft">
        {shown.map(({ relation, item }) => {
          const date = newsSourceDate(item.sourceTime, item.publishedAt);
          return (
            <li key={item.id} className="py-3">
              <div className="text-[13px] text-ink-4">
                {relation === "SAME_OCCURRENCE" ? tr("同次事项") : tr("同一事件脉络")} · {date?.text ?? tr("原文日期待核实")} · {item.source.name}
              </div>
              <Link to={`/items/${item.id}`} className="mt-1 block text-[15.5px] font-semibold text-ink transition-colors hover:text-accent">
                {item.title}
              </Link>
              {item.summary && <p className="mt-1 line-clamp-2 text-[14.5px] leading-relaxed text-ink-3">{item.summary}</p>}
              <a href={item.originalUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-[13px] text-accent">
                {tr("核对原文")}
              </a>
            </li>
          );
        })}
      </ul>
      {background.length > BACKGROUND_PREVIEW && (
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="text-[13px] text-note transition-colors hover:text-accent">
          {open ? tr("收起") : tr("展开其余 {count} 条", { count: background.length - BACKGROUND_PREVIEW })}
        </button>
      )}
    </li>
  );
}

/** "接下来关注": dated milestones the reports name; nothing is shown without a stated date. */
function NextNode({ next }: { next: StoryNextMilestone[] }) {
  const tr = useTr();
  return (
    <li className="relative pl-7">
      <Marker tone="ahead" />
      <h3 className="text-[17px] font-[650] leading-[1.55] text-ink">{tr("接下来关注")}</h3>
      <ul className="mt-1.5 space-y-1.5">
        {next.map((m) => (
          <li key={`${m.when}|${m.what}`} className="grid grid-cols-[minmax(5.5em,auto)_minmax(0,1fr)] gap-x-3 text-[15px] leading-[1.7]">
            <span className="num font-semibold text-accent">{m.when}</span>
            <span className="text-ink-2">{m.what}</span>
          </li>
        ))}
      </ul>
    </li>
  );
}

/** The main column of the story page: background → developments (oldest first) → what comes next. */
export function Storyline({ story }: { story: StoryDetail }) {
  const tr = useTr();
  const developments = [...story.developments].sort((a, b) => Date.parse(a.firstReportAt) - Date.parse(b.firstReportAt));
  return (
    <ol className="relative before:absolute before:bottom-3 before:left-[5px] before:top-3 before:w-px before:bg-line">
      {!!story.background?.length && <BackgroundNode background={story.background} />}
      {developments.map((d, i) => (
        <DevelopmentNode
          key={d.factId}
          d={d}
          reports={developmentReports(story.timeline, d.factId)}
          position={i + 1}
          total={developments.length}
          latest={i === developments.length - 1}
        />
      ))}
      {developments.length === 0 && (
        <li className="relative pb-7 pl-7 text-[14px] text-ink-4">
          <Marker tone="past" />
          {tr("还没有可公开的进展。")}
        </li>
      )}
      {!!story.next?.length && <NextNode next={story.next} />}
    </ol>
  );
}

/** "关键变化": only values the reports state on both sides, as a compact before → after table. */
export function KeyChanges({ changes }: { changes: StoryKeyChange[] }) {
  const tr = useTr();
  return (
    <div className="mt-4">
      <h3 className="text-[14px] font-semibold text-ink">{tr("关键变化")}</h3>
      <table className="mt-1.5 w-full table-fixed border-collapse text-[14px] leading-[1.6]">
        <thead>
          <tr className="text-left text-[12.5px] text-ink-4">
            <th scope="col" className="w-[34%] py-1.5 pr-2 font-normal">
              {tr("指标")}
            </th>
            <th scope="col" className="py-1.5 pr-2 font-normal">
              {tr("此前")}
            </th>
            <th scope="col" className="py-1.5 font-normal">
              {tr("现在")}
            </th>
          </tr>
        </thead>
        <tbody>
          {changes.map((c) => (
            <tr key={c.item} className="border-t border-line-soft align-top">
              <th scope="row" className="py-2 pr-2 text-left font-medium text-ink-2">
                {c.item}
              </th>
              <td className="num py-2 pr-2 text-ink-4">{c.before}</td>
              <td className="num py-2 font-semibold text-ink">
                <IconArrowRight size={12} className="mr-1 inline -translate-y-px text-accent" />
                {c.after}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
