import { dbOf } from "../db.ts";
import type { TextMatchValues, ReadMatcherValues, SearchScoreValues } from "./mentions.ts";
const sql = dbOf("publication");

/** Custom plans fold the bound guard flag, preserving direct trigram scans when no guarded character exists. */
export function publicationTextMatches(values: TextMatchValues) {
  return sql`(CASE WHEN ${values.hasGuards} THEN (
    p.search_text ILIKE ANY(${values.likes}::text[]) OR p.search_text ~* ANY(${values.latin}::text[])
    OR CASE WHEN p.search_text IS NULL THEN NULL ELSE EXISTS (SELECT 1 FROM unnest(${values.guardRemovals}::text[],${values.guardLikes}::text[]) AS guards(removal,pattern)
      WHERE regexp_replace(p.search_text,guards.removal,'','gi') ILIKE guards.pattern) END)
    ELSE p.search_text ILIKE ANY(${values.likes}::text[]) OR p.search_text ~* ANY(${values.latin}::text[]) END)`;
}
export function bodyTextMatches(values: TextMatchValues) {
  return sql`(CASE WHEN ${values.hasGuards} THEN (
    ps.body ILIKE ANY(${values.likes}::text[]) OR ps.body ~* ANY(${values.latin}::text[])
    OR CASE WHEN ps.body IS NULL THEN NULL ELSE EXISTS (SELECT 1 FROM unnest(${values.guardRemovals}::text[],${values.guardLikes}::text[]) AS guards(removal,pattern)
      WHERE regexp_replace(ps.body,guards.removal,'','gi') ILIKE guards.pattern) END)
    ELSE ps.body ILIKE ANY(${values.likes}::text[]) OR ps.body ~* ANY(${values.latin}::text[]) END)`;
}

export function poolDirectTextMatches(values: TextMatchValues) {
  return sql`(CASE WHEN ${values.hasGuards} THEN (
    ps.direct ILIKE ANY(${values.likes}::text[]) OR ps.direct ~* ANY(${values.latin}::text[])
    OR CASE WHEN ps.direct IS NULL THEN NULL ELSE EXISTS (SELECT 1 FROM unnest(${values.guardRemovals}::text[],${values.guardLikes}::text[]) AS guards(removal,pattern)
      WHERE regexp_replace(ps.direct,guards.removal,'','gi') ILIKE guards.pattern) END)
    ELSE ps.direct ILIKE ANY(${values.likes}::text[]) OR ps.direct ~* ANY(${values.latin}::text[]) END)`;
}
export function topicTextMatches(values: ReadMatcherValues) {
  return sql`(p.tags && ${values.topicTags ?? []}::text[] OR ${publicationTextMatches(values.topicText)})`;
}
export function searchPartScore(values: SearchScoreValues) {
  return sql`(CASE WHEN ps.direct LIKE ${values.term0} THEN 3 ELSE 0 END) + (CASE WHEN ps.body LIKE ${values.term0} THEN 1 ELSE 0 END)
    + (CASE WHEN ps.direct LIKE ${values.term1} THEN 3 ELSE 0 END) + (CASE WHEN ps.body LIKE ${values.term1} THEN 1 ELSE 0 END)
    + (CASE WHEN ps.direct LIKE ${values.term2} THEN 3 ELSE 0 END) + (CASE WHEN ps.body LIKE ${values.term2} THEN 1 ELSE 0 END)
    + (CASE WHEN ps.direct LIKE ${values.term3} THEN 3 ELSE 0 END) + (CASE WHEN ps.body LIKE ${values.term3} THEN 1 ELSE 0 END)
    + (CASE WHEN ps.direct LIKE ${values.term4} THEN 3 ELSE 0 END) + (CASE WHEN ps.body LIKE ${values.term4} THEN 1 ELSE 0 END)
    + (CASE WHEN ps.direct LIKE ${values.term5} THEN 3 ELSE 0 END) + (CASE WHEN ps.body LIKE ${values.term5} THEN 1 ELSE 0 END)`;
}
export function searchTitleScore(values: SearchScoreValues) {
  return sql`(CASE WHEN lower(p.title) LIKE ${values.term0} THEN 6 ELSE 0 END)
    + (CASE WHEN lower(p.title) LIKE ${values.term1} THEN 6 ELSE 0 END)
    + (CASE WHEN lower(p.title) LIKE ${values.term2} THEN 6 ELSE 0 END)
    + (CASE WHEN lower(p.title) LIKE ${values.term3} THEN 6 ELSE 0 END)
    + (CASE WHEN lower(p.title) LIKE ${values.term4} THEN 6 ELSE 0 END)
    + (CASE WHEN lower(p.title) LIKE ${values.term5} THEN 6 ELSE 0 END)`;
}
