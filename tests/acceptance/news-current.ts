// The news line as it is live today, behind the abilities the acceptance cases ask for. It only calls what
// production calls; where production has no such ability the adapter leaves it out, and the cases say so.
import { ENTITIES } from "@amp/industry/taxonomy";
import { NAME_GLOSSARY } from "@amp/industry/name-glossary";
import { decideTimeline } from "../../packages/backend/src/content/timeline.ts";
import { bilingualNames } from "../../packages/backend/src/editorial/bilingual-names.ts";
import { validateGeography } from "../../packages/backend/src/editorial/geography.ts";
import { tagGrounded } from "../../packages/backend/src/publication/tag-grounding.ts";
import { reportImportance } from "../../packages/backend/src/reports/arrangement.ts";
import type { NewsEffects } from "./news.ts";

const fold = (s: string) => s.trim().toLowerCase();

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
  // Today the lead is the entry with the highest importance (reports/arrangement.ts); yesterday's issue plays no part.
  lead: (candidates) =>
    [...candidates].sort(
      (a, b) =>
        reportImportance({ score: b.score, participants: b.outlets, official: !!b.official, followUp: !!b.followUp }) -
          reportImportance({ score: a.score, participants: a.outlets, official: !!a.official, followUp: !!a.followUp }) || a.id.localeCompare(b.id),
    )[0]!.id,
};
