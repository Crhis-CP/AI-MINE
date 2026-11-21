import { PhoneBar } from "../components/shell/PhoneBar";
import { useTr } from "../i18n";
import { useEffect } from "react";
import { setChangelogSeen } from "../lib/local-state";
import { SITE } from "@amp/industry/site";
import { useLoaderData } from "react-router";
import { IntentLink as Link } from "../components/ui/IntentLink";
import { apiGet } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { AsideCard, ReadingLayout } from "../components/ui/Page";
import { IconChevronRight } from "../components/icons";
import { FeatureNotice } from "../features/changelog/MajorNotice";
import { Inline, useReleaseLabels } from "../features/changelog/text";
import { type Release, releaseKey } from "../features/changelog/release";
import { showcaseFor } from "../features/changelog/showcases";
import { FilmRecordings } from "../features/changelog/films/context";
import { filmsFor } from "../features/changelog/films/recordings.server";
import type { FilmReel } from "../features/changelog/films/context";

/** Shared caches may keep this page for five minutes. */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

/** The changelog, and the films among its entries with their recordings (TASK-0367): fixed files, no further reads. */
export async function loader({ request }: { request: Request }) {
  const changelog = await apiGet<{ releases: Release[] }>("/api/site/changelog", { signal: request.signal });
  return { releases: changelog.releases, films: filmsFor(changelog.releases.map(releaseKey)) };
}

export function meta() {
  return pageMeta({
    title: "更新日志",
    description: `${SITE.name} 的功能更新、优化、公告与下线记录。`,
    descriptionEn: "What changed on AI-MINE: new features, improvements, notices and retirements.",
    path: "/changelog",
    image: "/og/pages/changelog.png",
  });
}

const KIND_DOT: Record<Release["kind"], string> = {
  重大更新: "bg-hot",
  更新: "bg-accent",
  优化: "bg-ok",
  公告: "bg-amber",
  下线: "bg-ink-4",
};

function isFeatureNotice(r: Release, films: Readonly<Record<string, FilmReel>>): boolean {
  return r.kind === "重大更新" || (r.kind === "公告" && r.title === "目前是测试版") || showcaseFor(r, films) !== undefined;
}

function ReleaseBody({ lines }: { lines: string[] }) {
  const blocks: Array<string | string[]> = [];
  for (const line of lines) {
    const last = blocks.at(-1);
    if (!line.startsWith("- ")) blocks.push(line);
    else if (Array.isArray(last)) last.push(line.slice(2));
    else blocks.push([line.slice(2)]);
  }
  const text = "mt-2 max-w-[52em] text-[13.5px] leading-[1.8] text-ink-3";
  return blocks.map((b, i) =>
    Array.isArray(b) ? (
      <ul key={i} className={`${text} space-y-1`}>
        {b.map((li, j) => (
          <li key={j} className="flex gap-2">
            <span className="mt-[11px] size-1 shrink-0 rounded-full bg-ink-4" aria-hidden="true" />
            <span>
              <Inline text={li} />
            </span>
          </li>
        ))}
      </ul>
    ) : (
      <p key={i} className={text}>
        <Inline text={b} />
      </p>
    ),
  );
}

/** A day's entries in order, the plain ones in a row sharing one card, each feature notice on its own. */
function runs(
  releases: Release[],
  films: Readonly<Record<string, FilmReel>>,
): Array<{ feature: Release; plain?: never } | { feature?: never; plain: Release[] }> {
  const out: Array<{ feature: Release; plain?: never } | { feature?: never; plain: Release[] }> = [];
  for (const r of releases) {
    const last = out.at(-1);
    if (isFeatureNotice(r, films)) out.push({ feature: r });
    else if (last?.plain) last.plain.push(r);
    else out.push({ plain: [r] });
  }
  return out;
}

function PlainCard({ date, releases }: { date: string; releases: Release[] }) {
  const labels = useReleaseLabels();
  const h = labels.date(date);
  return (
    <section className="card scroll-mt-16 lg:scroll-mt-6 px-5 lg:px-7">
      <h2 className="flex items-baseline gap-3 border-b border-line-soft py-4">
        <time dateTime={date} className="text-[18px] font-bold text-ink">
          {h.label}
        </time>
        <span className="text-[12px] text-ink-4">{h.weekday}</span>
      </h2>
      <ol>
        {releases.map((r) => (
          <li
            key={`${r.date}-${r.time ?? ""}-${r.title}`}
            className="grid gap-x-8 gap-y-2 border-b border-line-soft py-5 last:border-b-0 sm:grid-cols-[88px_minmax(0,1fr)]"
          >
            <div className="flex items-center gap-3 sm:block">
              {r.time && <span className="mono block text-[12.5px] text-ink-3">{r.time}</span>}
              <span
                className={`inline-flex items-center gap-1.5 text-[11.5px] ${r.kind === "重大更新" ? "font-semibold text-hot" : "text-ink-4"} ${r.time ? "sm:mt-1.5" : ""}`}
              >
                <span className={`size-1.5 rounded-full ${KIND_DOT[r.kind]}`} aria-hidden="true" />
                {labels.kind(r.kind, r.version)}
              </span>
            </div>
            <article className="min-w-0 sm:border-l sm:border-line sm:pl-8">
              <h3 className="text-[15px] font-bold leading-snug text-ink">{r.title}</h3>
              <ReleaseBody lines={r.body} />
            </article>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default function ChangelogPage() {
  const tr = useTr();
  const data = useLoaderData<typeof loader>();
  // The newest entry is the first: the unread mark's version (the site meta's changelogVersion names the same one).
  const first = data.releases[0];
  const version = first ? releaseKey(first) : null;
  useEffect(() => {
    if (version) setChangelogSeen(version);
  }, [version]);
  // Strictly newest first, every entry under its own date, a major update's animation included (Owner 2026-11-21:
  // “更新日志为什么把11月6日置顶，没有必要”, reversing the lift of 2026-11-14).
  const groups = new Map<string, Release[]>();
  for (const r of data.releases) groups.set(r.date, [...(groups.get(r.date) ?? []), r]);
  // Month → the newest date shown in it (the jump target) and how many entries it holds.
  const months = new Map<string, { first: string; count: number }>();
  for (const [date, releases] of groups) {
    const month = months.get(date.slice(0, 7)) ?? { first: date, count: 0 };
    month.count += releases.length;
    months.set(date.slice(0, 7), month);
  }

  const aside = (
    <>
      <AsideCard title={tr("按月份")} className="hidden lg:block">
        <nav aria-label={tr("按月份")} className="-mx-2 -mb-1">
          {[...months.entries()].map(([month, m]) => {
            const [y, mo] = month.split("-").map(Number) as [number, number];
            return (
              <a
                key={month}
                href={`#d-${m.first}`}
                className="flex items-center justify-between rounded-control px-2 py-2 text-[13.5px] text-ink-2 transition-colors hover:bg-bg-sunk hover:text-ink"
              >
                {tr("{y} 年 {mo} 月", { y, mo })}
                <span className="num text-[12px] text-ink-4">
                  {m.count} {tr("条")}
                </span>
              </a>
            );
          })}
        </nav>
      </AsideCard>
      <AsideCard title={tr("有想法或遇到问题")}>
        <p className="text-[13px] leading-[1.75] text-ink-3">{tr("想要的功能、用着不顺的地方，都可以在反馈页告诉我们。")}</p>
        <Link to="/feedback" className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">
          {tr("去反馈")} <IconChevronRight size={14} />
        </Link>
      </AsideCard>
    </>
  );

  return (
    <ReadingLayout phoneBar={<PhoneBar back={{ to: "/more", label: tr("我的") }} title={tr("更新日志")} />} aside={aside}>
      <header className="pb-6">
        <h1 data-page-title="" className="text-[24px] font-semibold leading-[1.3] text-ink">
          {tr("更新日志")}
        </h1>
        <p className="mt-1.5 text-[13px] text-ink-3">{tr("新功能、调整、下线，都写在这里。")}</p>
      </header>
      <FilmRecordings value={data.films}>
        <div className="space-y-4">
          {[...groups.entries()].map(([date, releases]) => (
            <div key={date} id={`d-${date}`} className="scroll-mt-16 lg:scroll-mt-6 space-y-4">
              {/* Within a day, strictly by time too: an entry with its own showcase stands between the list cards. */}
              {runs(releases, data.films).map((run) =>
                run.feature ? (
                  <FeatureNotice key={releaseKey(run.feature) + run.feature.title} release={run.feature} />
                ) : (
                  <PlainCard key={releaseKey(run.plain[0]!) + run.plain[0]!.title} date={date} releases={run.plain} />
                ),
              )}
            </div>
          ))}
        </div>
      </FilmRecordings>
    </ReadingLayout>
  );
}
