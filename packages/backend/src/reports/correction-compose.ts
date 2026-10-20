import { reportFactEvidence, reportPublicInputs } from "../publication/groups.ts";
import { SITE } from "@amp/industry/site";
import { periodDates } from "./periods.ts";
import { modelFor } from "../editorial/models.ts";
import { writePeriod, REPORT_VERSION, type Candidate } from "./compose.ts";
import type { StoredReportContent } from "./references.ts";

/** Worker-only regeneration of the issue's existing references; never selects unrelated new items. */
export async function generateReportCorrection(
  report: { kind: "daily" | "weekly" | "monthly"; key: string; window_start: Date; window_end: Date; content: StoredReportContent },
  entries: Candidate[],
) {
  const model = report.kind === "daily" ? null : await modelFor("report");
  const base = {
    ...report.content,
    correctionPending: false,
    generationStatus: "summary",
    lead: null,
    overview: null,
    headline: null,
    title: `${SITE.name} ${report.kind === "daily" ? "日报" : report.kind === "weekly" ? "周报" : "月报"} · ${report.key}`,
    generator: { version: REPORT_VERSION, model },
    metrics: { totalEvents: entries.length, totalStories: entries.length, sourcesCount: new Set(entries.map((e) => e.sourceId)).size },
  };
  if (report.kind === "daily") {
    const structure = report.content.sourceStructure ?? report.content;
    const inputs = await reportPublicInputs(entries.map((entry) => entry.itemId));
    const evidence = await reportFactEvidence([...new Set(inputs.flatMap((row) => (row.fact_id === null ? [] : [row.fact_id])))], report.window_end);
    const current = new Map(entries.map((entry) => [entry.itemId, entry]));
    const refresh = (old: { itemId: string; related?: Array<{ itemId: string }>; followUp?: unknown; fillIn?: unknown }) => {
      const candidates = [old, ...(old.related ?? [])].flatMap((ref) => (current.has(ref.itemId) ? [current.get(ref.itemId)!] : []));
      const first = candidates[0];
      return first
        ? [
            {
              ...first,
              sources: new Set([
                ...candidates.map((entry) => entry.sourceId),
                ...evidence
                  .filter((row) => inputs.some((input) => candidates.some((entry) => entry.itemId === input.id) && input.fact_id === row.fact_id))
                  .map((row) => row.source_id),
              ]).size,
              ...(old.followUp ? { followUp: old.followUp } : {}),
              ...(old.fillIn ? { fillIn: true } : {}),
              ...(candidates.length > 1 ? { related: candidates.slice(1) } : {}),
            },
          ]
        : [];
    };
    const sections = (structure.sections ?? [])
      .map((section) => ({ label: section.label, items: section.items.flatMap(refresh) }))
      .filter((section) => section.items.length);
    const flashes = (structure.flashes ?? []).flatMap(refresh);
    const main = sections.flatMap((section) => section.items),
      lead = main.find((entry) => entry.itemId === structure.leadItemId) ?? main[0];
    return {
      content: {
        ...base,
        sections,
        flashes,
        lead: lead ? { title: lead.title, leadParagraph: lead.summary } : null,
        leadItemId: lead?.itemId ?? null,
        highlights: main
          .filter((entry) => entry.itemId !== lead?.itemId)
          .slice(0, 3)
          .map((entry) => entry.itemId),
        generationStatus: "ready",
        metrics: { totalEvents: main.length, sourcesCount: new Set(entries.map((entry) => entry.sourceId)).size },
      },
      model: null,
      receiptId: null,
    };
  }
  if (!entries.length) return { content: { ...base, themes: [], storyOrder: [], flashes: [] }, model, receiptId: null };
  const dates = periodDates(report.kind, report.key);
  const result = await writePeriod(report.kind, report.key, dates.start, dates.end, entries, model!);
  const lead = entries[0]!;
  return {
    content: {
      ...base,
      generationStatus: result.overview ? "ready" : "summary",
      headline: lead.title,
      leadItemId: lead.itemId,
      highlights: entries.slice(1, 4).map((entry) => entry.itemId),
      overview: result.overview,
      flashes: [],
      themes: result.themes,
      storyOrder: entries.map((entry) => entry.itemId),
    },
    model: result.model,
    receiptId: result.receiptId,
  };
}
