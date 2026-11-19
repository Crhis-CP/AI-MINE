// The news line as it is live today, behind the abilities the acceptance cases ask for. It only calls what
// production calls; where production has no such ability the adapter leaves it out, and the cases say so.
import { ENTITIES } from "@amp/industry/taxonomy";
import { NAME_GLOSSARY } from "@amp/industry/name-glossary";
import { decideTimeline } from "../../packages/backend/src/content/timeline.ts";
import { bilingualNames } from "../../packages/backend/src/editorial/bilingual-names.ts";
import { validateGeography } from "../../packages/backend/src/editorial/geography.ts";
import { tagGrounded } from "../../packages/backend/src/publication/tag-grounding.ts";
import { arrangeDaily, type EditionEntry, reportImportance } from "../../packages/backend/src/reports/arrangement.ts";
import type { LeadCandidate, NewsEffects } from "./news.ts";

const fold = (s: string) => s.trim().toLowerCase();

/** A candidate as the daily issue's arrangement receives it: one entry of its own source, a follow-up when the event was covered before. */
const editionEntry = (c: LeadCandidate): EditionEntry => ({
  entry: {
    itemId: c.id,
    factId: null,
    storyPublicId: null,
    title: c.id,
    summary: "",
    sourceName: c.id,
    sourceUrl: `https://fixture.invalid/${c.id}`,
    sourceId: c.id,
    firstParty: !!c.official,
    role: "report",
    score: c.score,
    publishedAt: "2026-11-19T02:00:00Z",
    sources: c.outlets,
  },
  category: null,
  storyId: null,
  mentions: new Set(),
  sourceIds: new Set([c.id]),
  authority: 2,
  importance: reportImportance({ score: c.score, participants: c.outlets, official: !!c.official, followUp: !!c.followUp }),
  commentary: false,
  previous: c.followUp ? { key: c.id, title: c.id } : null,
});

export const CURRENT_NEWS: NewsEffects = {
  locate(article, answer) {
    const result = validateGeography(answer, { title: article.title, bodyText: article.body, excerpt: null, bodyStatus: "ok", xPost: null });
    return { primary: result.primary, codes: result.codes };
  },
  aboutCompany: (company, text, language) => tagGrounded(company, text, language),
  rewriteNames: bilingualNames,
  // Today a company's Chinese name comes from two lists kept apart: the name glossary and the tag vocabulary.
  companyName(spelling) {
    const wanted = fold(spelling);
    const entry = NAME_GLOSSARY.find((e) => [e.en, ...(e.aliases ?? [])].some((s) => fold(s) === wanted));
    if (entry) return entry.zh;
    return Object.values(ENTITIES).find((e) => e.aliases.some((a) => fold(a) === wanted))?.name ?? null;
  },
  // Today "new" is decided from the report's own times alone: found within 48 hours of its publication.
  isNew: (report) => !decideTimeline(report.publishedAt, report.now).backfill,
  // Today the lead is the first main entry of the production arrangement (reports/arrangement.ts, as reports/draft.ts
  // calls it for a new issue); yesterday's issue plays no part.
  lead: (candidates) => arrangeDaily(candidates.map(editionEntry)).main[0]!.entry.itemId,
};
