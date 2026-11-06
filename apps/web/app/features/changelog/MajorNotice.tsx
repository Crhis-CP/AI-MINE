import type { CSSProperties, ReactNode } from "react";
import { useTr } from "../../i18n";
import { Wordmark } from "../../components/Logo";
import { Inline, dateHeading } from "./text";
import { Convergence } from "./AggregationFlow";
import { Showcase202611 } from "./Showcase202611";

/**
 * A major update's own showcase, by version (not by title, which the reader copy may rewrite). With one, the first
 * line leads, the showcase follows, and the remaining lines are listed after it (folded away when there are many).
 */
const SHOWCASES: Record<string, () => ReactNode> = {
  "2026.11": Showcase202611,
};
const FOLD_AFTER = 5;

interface Release {
  date: string;
  time?: string;
  kind: "重大更新" | "更新" | "优化" | "公告" | "下线";
  version?: string;
  title: string;
  body: string[];
}

interface Station {
  name: string;
  kicker: string;
  text: string;
}

interface FeatureParts {
  paragraphs: string[];
  bullets: string[];
  lede?: string;
  stations: Station[];
  outlets: string[];
}

/** The notice's own sequence: each step waits, the dot lights, then the stroke draws to the next. */
const STEP_MS = 520;

function visible(line: string): boolean {
  return !/开源项目|底层重构|整套做法|Claude|Opus|Codex|模型榜|MCP|Skill|TypeScript|万行/.test(line);
}

export function parseFeature(lines: string[]): FeatureParts {
  const paragraphs: string[] = [];
  const bullets: string[] = [];
  const stations: Station[] = [];
  const outlets: string[] = [];
  let lede: string | undefined;
  let seenStation = false;
  for (const line of lines) {
    if (!visible(line)) continue;
    const station = /^\*\*(\S+)\s+(.+?)\*\*[：:]\s*(.+)$/.exec(line);
    if (station) {
      seenStation = true;
      stations.push({ name: station[1]!, kicker: station[2]!, text: station[3]! });
      continue;
    }
    const out = /^出口[：:]\s*(.+)$/.exec(line);
    if (out) {
      outlets.push(
        ...out[1]!
          .split(/[、,，]/)
          .map((s) => s.trim())
          .filter((s) => s && visible(s)),
      );
      continue;
    }
    if (/^\d{2}\s+/.test(line)) continue;
    if (line.startsWith("- ")) {
      bullets.push(line.slice(2));
      continue;
    }
    if (seenStation) continue;
    if (/五层|五站/.test(line)) {
      lede = line;
      continue;
    }
    paragraphs.push(line);
  }
  return { paragraphs, bullets, lede, stations, outlets };
}

function at(step: number): CSSProperties {
  return { animationDelay: `${step * STEP_MS}ms` };
}

/** The stroke used by `.anim-draw`, held until this step so the line arrives with the next dot. */
function Draw({ delayMs, vertical = false }: { delayMs: number; vertical?: boolean }) {
  return (
    <svg
      viewBox={vertical ? "0 0 2 100" : "0 0 100 2"}
      preserveAspectRatio="none"
      className={vertical ? "h-full w-[2px]" : "h-[2px] w-full"}
      aria-hidden="true"
    >
      <path
        d={vertical ? "M1 0 V100" : "M0 1 H100"}
        pathLength={1}
        fill="none"
        className="anim-draw stroke-accent"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
        style={{ animationDelay: `${delayMs}ms`, animationDuration: `${STEP_MS}ms` }}
      />
    </svg>
  );
}

function Dot({ step, current }: { step: number; current: boolean }) {
  return (
    <span className="relative grid size-3.5 shrink-0 place-items-center transition-transform duration-200 group-hover/step:scale-125" style={at(step)}>
      {current && <span className="notice-breathe absolute size-3.5 rounded-full bg-hot" aria-hidden="true" />}
      <span className="anim-pop-in relative size-2.5 rounded-full bg-accent group-hover/step:bg-hot" style={at(step)} />
    </span>
  );
}

/** A small line drawing for each step a notice names; any other step gets a plain ring. */
const STEP_ICONS: Record<string, string> = {
  采集: "M4 13l2-7h12l2 7v5H4z M4 13h5l1.5 2h3l1.5-2h5",
  筛选: "M4 5h16l-6 7.5V18l-4 2v-7.5z",
  归并: "M6 4v3a5 5 0 0 0 5 5h1 M18 4v3a5 5 0 0 1-5 5h-1 M12 12v8",
  精选: "M12 3.5l2.6 5.3 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z",
  发布: "M4 11.5l16-7-5.5 16-3.2-6.3z M11.3 14.2l3.5-3.5",
};
function StepIcon({ name }: { name: string }) {
  const d = STEP_ICONS[name];
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-[18px]"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {d ? <path d={d} /> : <circle cx={12} cy={12} r={5} />}
    </svg>
  );
}

/** The step's badge on the line: its icon in a gold ring that pops in when the line reaches it; the last one breathes. */
function Badge({ step, name, current }: { step: number; name: string; current: boolean }) {
  return (
    <span className="relative grid size-10 shrink-0 place-items-center" style={at(step)}>
      {current && <span className="notice-breathe absolute inset-0 rounded-full bg-hot/40" aria-hidden="true" />}
      <span
        className="anim-pop-in relative grid size-10 place-items-center rounded-full border-2 border-accent bg-surface text-accent shadow-sm transition duration-200 group-hover/step:scale-110 group-hover/step:border-hot group-hover/step:bg-hot group-hover/step:text-white"
        style={at(step)}
      >
        <StepIcon name={name} />
      </span>
    </span>
  );
}

/** A light that keeps travelling the line; `badge` places it through the centres of the step badges. */
function Sheen({ vertical = false, badge = false }: { vertical?: boolean; badge?: boolean }) {
  const place = badge
    ? vertical
      ? "bottom-5 left-[19px] top-5 w-[3px]"
      : "left-[10%] right-[10%] top-[19px] h-[3px]"
    : vertical
      ? "bottom-1 left-[5px] top-1 w-[3px]"
      : "left-[4%] right-[4%] top-[5px] h-[3px]";
  return (
    <div className={`pointer-events-none absolute overflow-hidden ${place}`} aria-hidden="true">
      <div className={vertical ? "notice-sheen-y h-1/4 w-full" : "notice-sheen h-full w-1/4"} />
    </div>
  );
}

/** One step's words: number, name, what it does for the reader. */
function StepCard({ index, station }: { index: number; station: Station }) {
  return (
    <div className="h-full rounded-control border border-line-soft bg-bg-sunk/60 px-3.5 py-3 transition duration-200 group-hover/step:-translate-y-1 group-hover/step:border-accent group-hover/step:bg-accent-soft/60 group-hover/step:shadow-sm">
      <div className="flex items-baseline gap-2">
        <span className="mono text-[11px] font-semibold text-ink-4">{String(index + 1).padStart(2, "0")}</span>
        <span className="text-[16px] font-black text-ink">{station.name}</span>
      </div>
      <div className="mt-0.5 text-[12.5px] font-semibold text-accent group-hover/step:text-hot">{station.kicker}</div>
      <p className="mt-2 text-[12.5px] leading-[1.7] text-ink-3">{station.text}</p>
    </div>
  );
}

function Chain({ stations, outlets }: { stations: Station[]; outlets: string[] }) {
  const tr = useTr();
  return (
    <div className="mt-8">
      <p className="animate-fade-up text-[13px] font-semibold tracking-wide text-ink-3" style={at(1)}>
        {tr("从采集到发布，一层层接上")}
      </p>
      {stations.length === 5 ? <Convergence stations={stations} outlets={outlets} /> : <ChainSteps stations={stations} outlets={outlets} />}
    </div>
  );
}

/** Any other number of steps: badges on a drawn line, cards below. */
function ChainSteps({ stations, outlets }: { stations: Station[]; outlets: string[] }) {
  const tr = useTr();
  const last = stations.length - 1;
  return (
    <div>
      <div className="relative mt-5 hidden sm:block">
        {/* The quiet track the gold line is drawn over, badge to badge. */}
        <span className="absolute left-[10%] right-[10%] top-[19px] h-[2px] rounded-full bg-line-soft" aria-hidden="true" />
        <Sheen badge />
        <ol className="relative grid items-stretch" style={{ gridTemplateColumns: `repeat(${stations.length}, minmax(0, 1fr))` }}>
          {stations.map((station, i) => (
            <li key={station.name} className="group/step flex min-w-0 flex-col">
              <div className="flex h-10 items-center">
                <span className="min-w-0 flex-1">{i > 0 && <Draw delayMs={(i - 1) * STEP_MS + 180} />}</span>
                <Badge step={i + 1} name={station.name} current={i === last} />
                <span className="min-w-0 flex-1">{i < last && <Draw delayMs={i * STEP_MS + 180} />}</span>
              </div>
              <div className="animate-fade-up mt-3 flex-1 px-1.5" style={at(i + 1)}>
                <StepCard index={i} station={station} />
              </div>
            </li>
          ))}
        </ol>
      </div>
      <div className="relative mt-4 sm:hidden">
        <Sheen vertical badge />
        <ol className="relative">
          {stations.map((station, i) => (
            <li key={station.name} className="group/step grid grid-cols-[40px_minmax(0,1fr)] gap-x-3">
              <div className="flex flex-col items-center">
                <Badge step={i + 1} name={station.name} current={i === last} />
                {i < last && (
                  <span className="my-1 min-h-6 flex-1">
                    <Draw vertical delayMs={i * STEP_MS + 180} />
                  </span>
                )}
              </div>
              <div className={`animate-fade-up ${i < last ? "pb-3" : ""}`} style={at(i + 1)}>
                <StepCard index={i} station={station} />
              </div>
            </li>
          ))}
        </ol>
      </div>
      {outlets.length > 0 && (
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <span className="animate-fade-up text-[12px] font-semibold text-ink-3" style={at(stations.length + 1)}>
            {tr("公开出去")} →
          </span>
          {outlets.map((label, i) => (
            <span key={label} className="anim-slide-in-x inline-flex" style={at(stations.length + 1 + i)}>
              <span className="rounded-full border border-accent/50 bg-accent-soft px-3 py-1 text-[12.5px] font-semibold text-accent transition duration-200 hover:-translate-y-0.5 hover:border-hot hover:bg-hot hover:text-white">
                {label}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Three beats for the test notice, lit in order with the same dots and stroke as the rewrite. */
function Beats() {
  const tr = useTr();
  const beats = ["测试上线", tr("试运行"), tr("还在完善")];
  const last = beats.length - 1;
  return (
    <div className="relative mt-6">
      <Sheen />
      <ol className="grid grid-cols-3">
        {beats.map((label, i) => (
          <li key={label} className="group/step min-w-0">
            <div className="flex h-3.5 items-center">
              <span className="min-w-0 flex-1">{i > 0 && <Draw delayMs={(i - 1) * STEP_MS + 180} />}</span>
              <Dot step={i + 1} current={i === last} />
              <span className="min-w-0 flex-1">{i < last && <Draw delayMs={i * STEP_MS + 180} />}</span>
            </div>
            <div className="animate-fade-up mt-2" style={at(i + 1)}>
              <div className="rounded-control py-1 text-center text-[13px] font-bold text-ink transition duration-200 group-hover/step:-translate-y-1 group-hover/step:bg-accent-soft group-hover/step:text-hot">
                {label}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Announcement page. Steps light in order, then a light keeps traveling the line. Hover lifts one step. */
export function FeatureNotice({ release }: { release: Release }) {
  const h = dateHeading(release.date);
  const parts = parseFeature(release.body);
  const label = release.version ? `${release.kind} ${release.version}` : release.kind;
  const test = release.kind === "公告" && release.title === "目前是测试版";
  const Showcase = release.version ? SHOWCASES[release.version] : undefined;
  return (
    <section className="card scroll-mt-6 px-5 py-5 sm:px-7 sm:py-6">
      <header className="animate-fade-up flex items-baseline justify-between gap-4">
        <span className="text-[13px] font-semibold tracking-wide text-hot">{label}</span>
        <span className="shrink-0 text-[12.5px] text-ink-3">
          {h.label} {h.weekday}
          {release.time ? (
            <>
              {" · "}
              <span className="mono">{release.time}</span>
            </>
          ) : null}
        </span>
      </header>
      <div className="animate-fade-up mt-5" style={at(0.35)}>
        <Wordmark size={40} />
      </div>
      <h2 className="animate-fade-up mt-3 max-w-[14em] text-[26px] font-black leading-[1.25] tracking-tight text-ink sm:text-[32px]" style={at(0.7)}>
        {release.title}
      </h2>
      {test && <Beats />}
      {Showcase ? (
        <ShowcaseBody lines={parts.paragraphs} showcase={<Showcase />} />
      ) : (
        <div className="mt-4 max-w-[42em] space-y-3 text-[15px] leading-[1.85] text-ink-2">
          {parts.paragraphs.map((p, i) => (
            <p key={p} className="animate-fade-up" style={at((test ? 4 : 1) + i * 0.6)}>
              <Inline text={p} />
            </p>
          ))}
          {parts.lede && (
            <p className="animate-fade-up text-ink-3" style={at(test ? 5 : 2)}>
              {parts.lede}
            </p>
          )}
          {parts.bullets.length > 0 && (
            <ul className="space-y-1.5 text-[14px] text-ink-3">
              {parts.bullets.map((b, i) => (
                <li key={b} className="animate-fade-up flex gap-2" style={at(2 + i)}>
                  <span className="mt-[11px] size-1 shrink-0 rounded-full bg-hot" aria-hidden="true" />
                  <span>
                    <Inline text={b} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {parts.stations.length > 0 && <Chain stations={parts.stations} outlets={parts.outlets} />}
    </section>
  );
}

/** The lead line, the showcase, then every change of the release as a list (folded when long). */
function ShowcaseBody({ lines, showcase }: { lines: string[]; showcase: ReactNode }) {
  const tr = useTr();
  const [lead, ...rest] = lines;
  const list = (
    <ul className="mt-3 space-y-2 text-[14px] leading-[1.8] text-ink-2">
      {rest.map((line) => (
        <li key={line} className="flex gap-2.5">
          <span className="mt-[11px] size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
          <span>
            <Inline text={line} />
          </span>
        </li>
      ))}
    </ul>
  );
  return (
    <>
      {lead && (
        <p className="animate-fade-up mt-4 max-w-[42em] text-[15.5px] leading-[1.85] text-ink-2" style={at(1)}>
          <Inline text={lead} />
        </p>
      )}
      {showcase}
      {rest.length > 0 &&
        (rest.length > FOLD_AFTER ? (
          <details className="group/all mt-5 max-w-[46em] rounded-control border border-line px-4 py-3">
            <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-3 text-[14px] font-semibold text-ink [&::-webkit-details-marker]:hidden">
              {tr("本次全部 {n} 项变化", { n: rest.length })}
              <span className="text-[12.5px] font-normal text-accent group-open/all:hidden">{tr("展开")}</span>
              <span className="hidden text-[12.5px] font-normal text-accent group-open/all:inline">{tr("收起")}</span>
            </summary>
            {list}
          </details>
        ) : (
          <div className="mt-5 max-w-[46em]">{list}</div>
        ))}
    </>
  );
}
