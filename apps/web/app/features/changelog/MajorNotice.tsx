import type { CSSProperties } from "react";
import { Wordmark } from "../../components/Logo";
import { Inline, dateHeading } from "./text";

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

function Sheen({ vertical = false }: { vertical?: boolean }) {
  return (
    <div
      className={`pointer-events-none absolute overflow-hidden ${vertical ? "bottom-1 left-[5px] top-1 w-[3px]" : "left-[4%] right-[4%] top-[5px] h-[3px]"}`}
      aria-hidden="true"
    >
      <div className={vertical ? "notice-sheen-y h-1/4 w-full" : "notice-sheen h-full w-1/4"} />
    </div>
  );
}

function Chain({ stations, outlets }: { stations: Station[]; outlets: string[] }) {
  const last = stations.length - 1;
  return (
    <div className="mt-8">
      <p className="animate-fade-up text-[13px] font-semibold tracking-wide text-ink-3" style={at(1)}>
        从采集到发布，一层层接上
      </p>
      <div className="relative mt-5 hidden sm:block">
        <Sheen />
        <ol className="grid items-start" style={{ gridTemplateColumns: `repeat(${stations.length}, minmax(0, 1fr))` }}>
          {stations.map((station, i) => (
            <li key={station.name} className="group/step min-w-0">
              <div className="flex h-3.5 items-center">
                <span className="min-w-0 flex-1">{i > 0 && <Draw delayMs={(i - 1) * STEP_MS + 180} />}</span>
                <Dot step={i + 1} current={i === last} />
                <span className="min-w-0 flex-1">{i < last && <Draw delayMs={i * STEP_MS + 180} />}</span>
              </div>
              <div className="animate-fade-up mt-3" style={at(i + 1)}>
                <div className="rounded-control px-2 py-2 transition duration-200 group-hover/step:-translate-y-1 group-hover/step:bg-accent-soft">
                  <div className="text-[15px] font-black text-ink">{station.name}</div>
                  <div className="mt-0.5 text-[12.5px] font-semibold text-accent group-hover/step:text-hot">{station.kicker}</div>
                  <p className="mt-1.5 text-[12.5px] leading-[1.65] text-ink-3">{station.text}</p>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </div>
      <div className="relative mt-4 sm:hidden">
        <Sheen vertical />
        <ol>
          {stations.map((station, i) => (
            <li key={station.name} className="group/step grid grid-cols-[14px_minmax(0,1fr)] gap-x-3">
              <div className="flex flex-col items-center">
                <Dot step={i + 1} current={i === last} />
                {i < last && (
                  <span className="my-1 h-10">
                    <Draw vertical delayMs={i * STEP_MS + 180} />
                  </span>
                )}
              </div>
              <div className={`animate-fade-up ${i < last ? "pb-3" : ""}`} style={at(i + 1)}>
                <div className="rounded-control px-2 py-1.5 transition duration-200 group-hover/step:bg-accent-soft">
                  <div className="text-[15px] font-black text-ink">{station.name}</div>
                  <div className="text-[12.5px] font-semibold text-accent group-hover/step:text-hot">{station.kicker}</div>
                  <p className="mt-1 text-[13px] leading-[1.7] text-ink-3">{station.text}</p>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </div>
      {outlets.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="animate-fade-up text-[12px] font-semibold text-ink-3" style={at(stations.length + 1)}>
            公开出去
          </span>
          {outlets.map((label, i) => (
            <span key={label} className="anim-slide-in-x inline-flex" style={at(stations.length + 1 + i)}>
              <span className="rounded-full bg-ink px-3 py-1 text-[12.5px] font-semibold text-white transition duration-200 hover:-translate-y-0.5 hover:bg-hot">
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
  const beats = ["测试上线", "试运行", "还在完善"];
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
      {parts.stations.length > 0 && <Chain stations={parts.stations} outlets={parts.outlets} />}
    </section>
  );
}
