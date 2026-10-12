import { SITE } from "@amp/industry/site";
import { CATEGORIES } from "@amp/industry/taxonomy";
import { addDays, beijingDate } from "@amp/contracts/time";
import { modelFor } from "../editorial/models.ts";
import { chatJson } from "../providers/llm.ts";
import { reportFallbackInput } from "./fallback-input.ts";
import { writeLead, periodPrompt, PeriodSchema, REPORT_VERSION, type Candidate } from "./compose.ts";
import type { StoredReportContent } from "./references.ts";

/** Worker-only regeneration of the issue's existing references; never selects unrelated new items. */
export async function generateReportCorrection(
  report: { kind: "daily" | "weekly" | "monthly"; key: string; window_start: Date; window_end: Date; content: StoredReportContent },
  entries: Candidate[],
) {
  const model = await modelFor("report");
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
    const sections: Array<{ label: string; items: Candidate[] }> = [],
      flashes: Candidate[] = [];
    for (const entry of entries) {
      const label = CATEGORIES.find((c) => c.key === entry.category)?.section;
      if (!label) {
        flashes.push(entry);
        continue;
      }
      let section = sections.find((s) => s.label === label);
      if (!section) {
        section = { label, items: [] };
        sections.push(section);
      }
      if (section.items.length < 8) section.items.push(entry);
      else flashes.push(entry);
    }
    const lead = await writeLead("daily", report.key, entries, model);
    return {
      content: { ...base, sections, flashes, lead: lead?.lead ?? null, highlights: lead?.highlights ?? [], generationStatus: lead ? "ready" : "summary" },
      model: lead?.model ?? model,
      receiptId: lead?.receiptId ?? null,
    };
  }
  if (!entries.length) return { content: { ...base, themes: [], storyOrder: [], flashes: [] }, model, receiptId: null };
  const prompt = periodPrompt(report.kind, beijingDate(report.window_start), addDays(beijingDate(report.window_end), -1), entries);
  const permit = await reportFallbackInput(entries);
  const result = await chatJson({
    model,
    purpose: `report_${report.kind}`,
    subject: `report:${report.kind}:${report.key}`,
    promptVersion: REPORT_VERSION,
    ...prompt,
    sourceIds: [...new Set(entries.map((e) => e.sourceId))],
    fallbackPermit: permit?.(prompt),
    schema: PeriodSchema,
    temperature: 0.3,
    maxTokens: 2500,
  });
  return {
    content: {
      ...base,
      generationStatus: "ready",
      headline: result.data.headline.trim(),
      overview: result.data.overview,
      flashes: [],
      themes: result.data.themes.map((theme) => ({
        heading: theme.heading,
        summary: theme.summary,
        storyRefs: theme.refs.map((ref) => entries[Number(ref) - 1]).filter((entry): entry is Candidate => !!entry),
      })),
      storyOrder: entries.map((e) => e.itemId),
    },
    model: result.model,
    receiptId: result.receiptId,
  };
}
