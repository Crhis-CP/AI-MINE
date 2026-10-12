import { dbOf } from "../db.ts";
import type { TextMatchValues } from "./mentions.ts";
const sql = dbOf("publication");

/** Custom plans fold the bound guard flag, preserving direct trigram scans when no guarded character exists. */
export function publicationTextMatches(values: TextMatchValues) {
  return sql`(CASE WHEN ${values.hasGuards} THEN (
    p.search_text ILIKE ANY(${values.likes}::text[]) OR p.search_text ~* ANY(${values.latin}::text[])
    OR EXISTS (SELECT 1 FROM unnest(${values.guardRemovals}::text[],${values.guardLikes}::text[]) AS guards(removal,pattern)
      WHERE regexp_replace(p.search_text,guards.removal,'','gi') ILIKE guards.pattern))
    ELSE p.search_text ILIKE ANY(${values.likes}::text[]) OR p.search_text ~* ANY(${values.latin}::text[]) END)`;
}
export function bodyTextMatches(values: TextMatchValues) {
  return sql`(CASE WHEN ${values.hasGuards} THEN (
    ps.body ILIKE ANY(${values.likes}::text[]) OR ps.body ~* ANY(${values.latin}::text[])
    OR EXISTS (SELECT 1 FROM unnest(${values.guardRemovals}::text[],${values.guardLikes}::text[]) AS guards(removal,pattern)
      WHERE regexp_replace(ps.body,guards.removal,'','gi') ILIKE guards.pattern))
    ELSE ps.body ILIKE ANY(${values.likes}::text[]) OR ps.body ~* ANY(${values.latin}::text[]) END)`;
}
