import { SITE } from "@amp/industry/site";
import { arrangeDaily } from "./arrangement.ts";
import { dailyEdition } from "./edition.ts";
import { REPORT_VERSION, reportSection, SECTION_ORDER, periodGroups, type writePeriod } from "./period-writing.ts";
import type { Candidate } from "./compose.ts";

/** Prepare a rule issue without changing its publication or revision. */
export async function dailyDraft(date: string, start: Date, end: Date) {
  const edition = await dailyEdition(date, start, end);
  const arranged = arrangeDaily(edition.entries.filter((entry) => reportSection(entry.category)));
  arranged.flashes = [...arranged.flashes, ...edition.entries.filter((entry) => !reportSection(entry.category))].slice(0, 10);
  const perSection = new Map<string, typeof arranged.main>();
  for (const entry of arranged.main) {
    const label = reportSection(entry.category) ?? SECTION_ORDER.at(-1)!;
    perSection.set(label, [...(perSection.get(label) ?? []), entry]);
  }
  const sections = SECTION_ORDER.filter((label) => perSection.has(label)).map((label) => ({
    label,
    items: perSection.get(label)!.map((entry) => entry.entry),
  }));
  const main = arranged.main.map((entry) => entry.entry),
    flashes = arranged.flashes.map((entry) => entry.entry);
  const quiet = !main.length && !flashes.length;
  const waiting = quiet && (edition.stats.pendingSelections > 0 || edition.stats.judged === 0);
  const lead = main[0];
  const content = {
    date,
    generationStatus: quiet ? "summary" : "ready",
    lead: lead
      ? { title: lead.title, leadParagraph: lead.summary }
      : quiet
        ? { title: "今日无大事发生", leadParagraph: "本期已完成评分的矿业资讯中，没有新增内容入选日报。" }
        : null,
    leadItemId: lead?.itemId ?? null,
    highlights: main.slice(1, 4).map((entry) => entry.itemId),
    sections,
    flashes,
    metrics: {
      totalEvents: main.length,
      sourcesCount: new Set(arranged.main.flatMap((entry) => [...entry.sourceIds])).size,
      firstPartyEvents: main.filter((entry) => entry.firstParty).length,
    },
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    generator: { version: REPORT_VERSION, model: null, ...edition.stats, ...arranged.stats },
  };
  return { content, entries: main.length + flashes.length, waiting };
}

export function periodContent(
  kind: "weekly" | "monthly",
  key: string,
  startDate: string,
  endDateInclusive: string,
  period: { entries: Candidate[]; issues: number },
  top: Candidate[],
  written: Awaited<ReturnType<typeof writePeriod>> | null,
) {
  const lead = top[0];
  return {
    kind,
    generationStatus: written?.overview ? "ready" : "summary",
    title: `${SITE.name} ${kind === "weekly" ? "周报" : "月报"} · ${key}`,
    ...(kind === "weekly" ? { isoLabel: key } : { monthLabel: key }),
    periodStart: startDate,
    periodEnd: endDateInclusive,
    headline: lead?.title ?? null,
    leadItemId: lead?.itemId ?? null,
    highlights: top.slice(1, 4).map((entry) => entry.itemId),
    overview: written?.overview ?? null,
    themes: written?.themes ?? periodGroups(top).map((group) => ({ heading: group.label, summary: null, storyRefs: group.items })),
    storyOrder: top.map((entry) => entry.itemId),
    metrics: { totalStories: top.length, selectedCount: period.entries.length, reportsCovered: period.issues },
    generator: { version: REPORT_VERSION, model: written?.model ?? null, written: !!written?.overview },
  };
}
