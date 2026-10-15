import { entityIdentity } from "../editorial/vocabulary.ts";
import { representativeSourceIdentities } from "../sources/representative-input.ts";
import { representativeFactSubjects } from "../events/representative-input.ts";
import { dbOf, type Db } from "../db.ts";
const sql = dbOf("publication");

export interface RepresentativeIdentity {
  source_tier: string;
  publisher_role: string | null;
  owner_entity_id: string | null;
  fact_subject: string | null;
}

/** One batched identity read for all candidates; the caller still defines which reports qualify. */
export async function attachRepresentativeIdentity<T extends { source_id: string; fact_id: number | null }>(rows: T[], db: Db = sql) {
  if (!rows.length) return rows as (T & Partial<RepresentativeIdentity>)[];
  const sources = new Map((await representativeSourceIdentities([...new Set(rows.map((r) => r.source_id))], db)).map((s) => [s.id, s]));
  const facts = new Map(
    (await representativeFactSubjects([...new Set(rows.flatMap((r) => (r.fact_id === null ? [] : [r.fact_id])))], db)).map((f) => [Number(f.id), f.subject]),
  );
  return rows.map((row) =>
    Object.assign(row, {
      source_tier: sources.get(row.source_id)?.source_tier ?? "",
      publisher_role: sources.get(row.source_id)?.publisher_role ?? null,
      owner_entity_id: sources.get(row.source_id)?.owner_entity_id ?? null,
      fact_subject: row.fact_id === null ? null : (facts.get(Number(row.fact_id)) ?? null),
    }),
  );
}

export function representativePriority(row: Partial<RepresentativeIdentity>): number {
  if (row.source_tier === "T1") return 0;
  const owner = entityIdentity(row.owner_entity_id);
  const subjects = row.fact_subject?.split(/[,，、;；+＋&＆/]/u).map((subject) => entityIdentity(subject)) ?? [];
  if (!owner || subjects.some((subject) => !subject) || !subjects.includes(owner)) return 3;
  if (row.publisher_role === "organization") return 1;
  if (row.publisher_role === "person") return 2;
  return 3;
}

export type RepresentativeRow = Partial<RepresentativeIdentity> & {
  id?: string;
  article_id?: string;
  first_party?: boolean;
  body_mode: string;
  score: number | null;
  timeline_at: Date;
};

/** T1, verified publisher, full text, score, then first appearance and a stable id. */
export function pickRepresentative<T extends RepresentativeRow>(rows: T[]): T {
  return [...rows].sort(
    (a, b) =>
      representativePriority(a) - representativePriority(b) ||
      Number(b.body_mode === "full") - Number(a.body_mode === "full") ||
      Number(b.score ?? 0) - Number(a.score ?? 0) ||
      a.timeline_at.getTime() - b.timeline_at.getTime() ||
      (a.article_id ?? a.id ?? "").localeCompare(b.article_id ?? b.id ?? ""),
  )[0]!;
}
