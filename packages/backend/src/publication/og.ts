// Share images only need public title/summary metadata. Keep the same page visibility rule without
// loading bodies, translations, related stories or signed media that never appear on these cards.
import { toPublicApiCategory, type CategoryKey } from "@amp/contracts/taxonomy";
import type { ItemShareMetadata } from "@amp/contracts/site";
import { publicTimeMetadata } from "./items.ts";
import { sql } from "../db.ts";
import { hasItemPage } from "./rules.ts";

export async function loadItemShare(id: string): Promise<ItemShareMetadata | null> {
  const [row] = await sql<
    {
      id: string;
      title: string;
      summary: string | null;
      category: CategoryKey | null;
      timeline_at: Date;
      source_name: string;
      published_at: Date | null;
      score: number | null;
      selected: boolean;
      source_mode: string;
      visibility: string;
    }[]
  >`SELECT p.article_id AS id, p.title, p.summary, p.category, p.timeline_at,
      p.published_at, p.score, p.selected,
      s.name AS source_name, s.participation_mode AS source_mode, p.visibility
    FROM publications p JOIN sources s ON s.id = p.source_id WHERE p.article_id = ${id}`;
  if (!row || !hasItemPage({ visibility: row.visibility, sourceMode: row.source_mode })) return null;
  const time = (await publicTimeMetadata([id])).get(id);
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    category: toPublicApiCategory(row.category),
    publishedAt: time?.publishedAt ?? null,
    sourceTime: time?.sourceTime ?? null,
    score: row.score === null ? null : Math.round(Number(row.score)),
    selected: row.selected,
    timelineAt: row.timeline_at.toISOString(),
    source: { name: row.source_name },
  };
}
