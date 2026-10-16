import { dbOf } from "../db.ts";
const sql = dbOf("editorial");
/** Private operator decisions are represented only as excluded IDs, never their reasons. */
export async function reportSignalExclusions(ids: string[]) {
  if (!ids.length) return new Set<string>();
  return new Set(
    (
      await sql<{ article_id: string }[]>`SELECT article_id FROM editorial_overrides
    WHERE article_id=ANY(${ids}::text[]) AND (visibility='withdrawn' OR fields->>'relevance'='block')`
    ).map((row) => row.article_id),
  );
}
