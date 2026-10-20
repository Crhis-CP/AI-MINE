import { z } from "zod";
import { CATEGORIES, ENTITIES } from "@amp/industry/taxonomy";
import { SITE } from "@amp/industry/site";
import { promptText, promptVersion } from "../editorial/prompts.ts";
import { chatJson } from "../providers/llm.ts";
import { reportFallbackInput } from "./fallback-input.ts";
import type { Candidate } from "./compose.ts";
export const REPORT_VERSION = `rules-daily-v1:${promptVersion("report-period")}`;
export const SECTION_ORDER = [...new Set(CATEGORIES.map((category) => category.section))];
export const reportSection = (category: string | null) => CATEGORIES.find((value) => value.key === category)?.section ?? null;
export const PeriodSchema = z.object({ overview: z.string().max(1500).catch(""), sections: z.record(z.string(), z.string().max(600)).catch({}) });
export function periodGroups(entries: Candidate[]) {
  const labels = [...SECTION_ORDER, ...(entries.some((entry) => !reportSection(entry.category)) ? ["矿业动态"] : [])];
  return labels
    .map((label) => ({ label, items: entries.filter((entry) => (reportSection(entry.category) ?? "矿业动态") === label) }))
    .filter((group) => group.items.length);
}
export function periodPrompt(kind: "weekly" | "monthly", start: string, end: string, entries: Candidate[]) {
  const groups = periodGroups(entries),
    introduced = groups.filter((group) => group.items.length >= 3).map((group) => group.label);
  return {
    system: promptText("report-period", {
      kindName: kind === "weekly" ? "周报" : "月报",
      overviewLength: kind === "weekly" ? "160" : "240",
      sections: introduced.length ? introduced.join("、") : "无；sections 返回空对象",
    }),
    user: `本期：${start} 至 ${end}\n${groups.map((group) => [`【${group.label}】`, ...group.items.flatMap((entry) => [entry, ...(entry.related ?? [])].map((member) => `- ${member.title}｜${member.summary.slice(0, 140)}`))].join("\n")).join("\n")}`,
  };
}
const COMPANY_NAMES = Object.values(ENTITIES).map((entity) => [entity.name, ...entity.aliases].map((name) => name.toLowerCase()));
const PLAIN = new Set(["esg", "ai", SITE.name.toLowerCase()]);
/** Reject names and material figures unsupported by this issue; known company aliases refer to the same entity. */
export function grounded(text: string, corpus: string) {
  const known = corpus.toLowerCase(),
    companies = COMPANY_NAMES.filter((names) => names.some((name) => known.includes(name)));
  const named = (word: string) => PLAIN.has(word) || known.includes(word) || companies.some((names) => names.includes(word));
  const words = (text.match(/[A-Za-z][A-Za-z0-9.+-]*/g) ?? []).map((word) => word.replace(/[.+-]+$/, " ").trim()).filter((word) => /[A-Z0-9]/.test(word));
  const figures = (text.match(/\d+(?:\.\d+)?%?/g) ?? []).filter((figure) => figure.length >= 3 || /[.%]/.test(figure));
  const mentioned = COMPANY_NAMES.filter((names) => names.some((name) => /\p{Script=Han}/u.test(name) && text.toLowerCase().includes(name)));
  return (
    words.every((word) => named(word.toLowerCase())) &&
    figures.every((figure) => known.includes(figure)) &&
    mentioned.every((names) => companies.includes(names))
  );
}
export function fitted(text: string, max: number): string | null {
  let result = "";
  for (const sentence of text.trim().match(/[^。！？]+(?:[。！？]+[」”’）]*|$)/g) ?? []) {
    if ([...(result + sentence)].length > max) break;
    result += sentence;
  }
  return result.trim() || null;
}
export async function writePeriod(kind: "weekly" | "monthly", key: string, start: string, end: string, entries: Candidate[], model: string) {
  const inputs = [...new Map(entries.flatMap((entry) => [entry, ...(entry.related ?? [])]).map((entry) => [entry.itemId, entry])).values()];
  const prompt = periodPrompt(kind, start, end, entries),
    permit = await reportFallbackInput(inputs);
  const corpus = [`${start} ${end}`, ...inputs.map((entry) => `${entry.title} ${entry.summary}`)].join("\n");
  const usable = (text: string | undefined, max: number) => {
    const fit = fitted(text ?? "", max);
    return fit && grounded(fit, corpus) ? fit : null;
  };
  const result = await chatJson({
    model,
    purpose: `report_${kind}`,
    subject: `report:${kind}:${key}`,
    promptVersion: REPORT_VERSION,
    ...prompt,
    sourceIds: [...new Set(inputs.map((entry) => entry.sourceId))],
    fallbackPermit: permit?.(prompt),
    schema: PeriodSchema.refine(
      (value) => !!usable(value.overview, kind === "weekly" ? 240 : 340),
      "Report overview must fit and be supported by the current issue",
    ),
    temperature: 0.3,
    maxTokens: 2500,
  });
  return {
    overview: usable(result.data.overview, kind === "weekly" ? 240 : 340),
    themes: periodGroups(entries).map((group) => ({
      heading: group.label,
      summary: group.items.length >= 3 ? usable(result.data.sections[group.label], 90) : null,
      storyRefs: group.items,
    })),
    model: result.model,
    receiptId: result.receiptId,
  };
}
