import { entityIdentity } from "../editorial/vocabulary.ts";
import { sql, type Db } from "../db.ts";

export interface RepresentativeIdentity {
  source_tier: string;
  publisher_role: string | null;
  owner_entity_id: string | null;
  fact_subject: string | null;
}

/** Reader processes use the published priority, never private source configuration. */
export async function attachRepresentativePriority<T extends { id?: string; article_id?: string }>(rows: T[], db: Db = sql) {
  const ids = rows.map((r) => r.article_id ?? r.id ?? "").filter(Boolean);
  const values = ids.length
    ? await db<
        { article_id: string; representative_priority: number }[]
      >`SELECT article_id,representative_priority FROM publications WHERE article_id=ANY(${ids}::text[])`
    : [];
  const priorities = new Map(values.map((r) => [r.article_id, r.representative_priority]));
  return rows.map((r) => Object.assign(r, { representative_priority: priorities.get(r.article_id ?? r.id ?? "") ?? 3 }));
}

export function representativePriority(row: Partial<RepresentativeIdentity> & { representative_priority?: number }): number {
  if (row.representative_priority !== undefined) return row.representative_priority;
  if (row.source_tier === "T1") return 0;
  const owner = entityIdentity(row.owner_entity_id);
  const subjects = row.fact_subject?.split(/[,，、;；+＋&＆/]/u).map((subject) => entityIdentity(subject)) ?? [];
  if (!owner || subjects.some((subject) => !subject) || !subjects.includes(owner)) return 3;
  if (row.publisher_role === "organization") return 1;
  if (row.publisher_role === "person") return 2;
  return 3;
}

export type RepresentativeRow = Partial<RepresentativeIdentity> & {
  representative_priority?: number;
  id?: string;
  article_id?: string;
  first_party?: boolean;
  body_mode: string;
  score: number | null;
  timeline_at: Date;
};

/**
 * A report scoring this many points (or more) above another is clearly better: it wins the seat even over a
 * T1 or verified publisher (Owner 2026-11-08, TASK-0591). Within this lead the publisher order still decides.
 */
export const REPRESENTATIVE_SCORE_LEAD = 3;

/**
 * Reports clearly below the event's best score drop out first; among the rest: T1, verified publisher,
 * full text, score, then first appearance and a stable id. `readAllFactApiItems` ranks the same way in SQL.
 */
export function pickRepresentative<T extends RepresentativeRow>(rows: T[]): T {
  const top = Math.max(...rows.map((row) => Number(row.score ?? 0)));
  // Compared in hundredths, like the numeric scores SQL compares: 66.1 − 63.1 is a 3-point lead, not 2.9999….
  const lead = (row: T) => Math.round((top - Number(row.score ?? 0)) * 100);
  const close = rows.filter((row) => lead(row) < REPRESENTATIVE_SCORE_LEAD * 100);
  return [...close].sort(
    (a, b) =>
      representativePriority(a) - representativePriority(b) ||
      Number(b.body_mode === "full") - Number(a.body_mode === "full") ||
      Number(b.score ?? 0) - Number(a.score ?? 0) ||
      a.timeline_at.getTime() - b.timeline_at.getTime() ||
      (a.article_id ?? a.id ?? "").localeCompare(b.article_id ?? b.id ?? ""),
  )[0]!;
}
