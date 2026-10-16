// Frozen query-shape reference for TASK-0326, derived from the pre-change reader SQL.
import { sql } from "@amp/backend/db";
import type { TextMatchValues, ReadMatcherValues } from "../../packages/backend/src/publication/mentions.ts";

type Fragment = ReturnType<typeof sql>;
export function legacyText(column: Fragment, values: TextMatchValues) {
  const parts = [
    ...values.likes.map((pattern) => sql`${column} ILIKE ${pattern}`),
    ...values.latin.map((pattern) => sql`${column} ~* ${pattern}`),
    ...values.guardLikes.map((pattern, i) => sql`regexp_replace(${column},${values.guardRemovals[i]!},'','gi') ILIKE ${pattern}`),
  ];
  return parts.length ? parts.reduce((a, b) => sql`${a} OR ${b}`) : sql`FALSE`;
}
export function legacyScore(column: Fragment, terms: string[], weight: number) {
  return terms.reduce((out, term) => sql`${out} + CASE WHEN ${column} LIKE ${"%" + term + "%"} THEN ${weight} ELSE 0 END`, sql`0`);
}

export function legacyPublicMatch(values: ReadMatcherValues) {
  return [values.term0, values.term1, values.term2, values.term3, values.term4, values.term5]
    .filter((term) => term.active)
    .reduce(
      (out, term) =>
        sql`${out} AND (${legacyText(sql`p.search_text`, term)} OR EXISTS(SELECT 1 FROM pool_search ps WHERE ps.article_id=p.article_id AND (${legacyText(sql`ps.body`, term)}) OFFSET 0))`,
      sql``,
    );
}
export function legacyPoolMatch(values: ReadMatcherValues) {
  return [values.term0, values.term1, values.term2, values.term3, values.term4, values.term5]
    .filter((term) => term.active)
    .reduce((out, term) => sql`${out} AND (${legacyText(sql`ps.direct`, term)} OR ${legacyText(sql`ps.body`, term)})`, sql`TRUE`);
}

export function legacyDirectMatch(values: ReadMatcherValues) {
  return [values.term0, values.term1, values.term2, values.term3, values.term4, values.term5]
    .filter((term) => term.active)
    .reduce((out, term) => sql`${out} AND (${legacyText(sql`p.search_text`, term)})`, sql`TRUE`);
}
