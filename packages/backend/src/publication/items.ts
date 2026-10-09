import { JURISDICTIONS, jurisdictionDescendants } from "@amp/industry/jurisdictions";
import { geographyRecipe } from "../editorial/geography.ts";
// Public read layer, item level. Every exit (site API, v1, RSS, MCP, sitemap) reads
// items through these functions; visibility, release gate and body licences are applied here.
import { toPublicApiCategory, type CategoryKey, type ChannelKey } from "@amp/contracts/taxonomy";
import type { FeedItemSummary, ItemSummary, SourceKind } from "@amp/contracts/site";
import { dbOf, type Db } from "../db.ts";
import { displayTags } from "./rules.ts";

const sql = dbOf("publication");

export interface ItemRow {
  id: string;
  revision: number;
  title: string;
  original_title: string | null;
  summary: string | null;
  reason: string | null;
  category: string | null;
  tags: string[];
  score: number | null;
  selected: boolean;
  eligible: boolean;
  channel: "news";
  url: string;
  published_at: Date | null;
  discovered_at: Date;
  timeline_at: Date;
  /** Reading-group anchor for a selected item (timeline_at otherwise). */
  sort_at: Date;
  first_party: boolean;
  visibility: string;
  body_mode: "full" | "summary";
  syndicate: boolean;
  indexable: boolean;
  visible_after: Date | null;
  backfill: boolean;
  fact_id: number | null;
  story_id: number | null;
  source_id: string;
  source_name: string;
  source_kind: SourceKind;
  /** Participation mode of the source now (editorial, hot_signal, isolated). */
  source_mode: string;
  author: string | null;
  language: string | null;
  story_public_id: string | null;
  story_title: string | null;
}

/** Columns every item listing selects. Internal judgement details never leave this layer. */
export const ITEM_COLUMNS = sql`
  p.article_id AS id, p.revision, p.title, p.original_title,
  coalesce(p.summary, CASE WHEN s.site_fulltext AND p.visibility = 'public' THEN p.source_excerpt END) AS summary, p.reason, p.category, p.tags, p.score,
  p.selected, p.eligible, p.channel, p.url, p.published_at, p.discovered_at, p.timeline_at, p.sort_at, p.first_party, p.visibility,
  p.body_mode, p.syndicate, p.indexable, p.visible_after, p.backfill, p.fact_id, p.story_id,
  s.id AS source_id, s.name AS source_name, s.kind AS source_kind, s.participation_mode AS source_mode,
  a.author, a.language,
  st.public_id::text AS story_public_id, st.title AS story_title`;

/** Public API listings never render article bodies or story metadata. */
export type ApiItemRow = Pick<
  ItemRow,
  "id" | "title" | "original_title" | "summary" | "source_name" | "url" | "published_at" | "discovered_at" | "category" | "score" | "selected" | "reason"
>;
export const API_ITEM_COLUMNS = sql`
  p.article_id AS id, p.title, p.original_title, p.summary, s.name AS source_name, p.url,
  p.published_at, p.discovered_at, p.category, p.score, p.selected, p.reason`;
export const API_ITEM_FROM = sql`FROM publications p JOIN sources s ON s.id = p.source_id`;

/** A translation of an older revision is left out: the original changed after it (the worker translates it again). */
export const ITEM_FROM = sql`
  FROM publications p
  JOIN sources s ON s.id = p.source_id
  JOIN articles a ON a.id = p.article_id
  LEFT JOIN stories st ON st.id = p.story_id AND st.merged_into IS NULL
  LEFT JOIN translations tr ON tr.article_id = p.article_id AND tr.lang = 'zh' AND tr.revision >= a.revision`;

/** Listed items: public, and a selected item only after its release gate. */
export function listedCondition(now: Date) {
  return sql`p.visibility = 'public' AND (NOT p.selected OR p.visible_after <= ${now})`;
}

/** Selected set as shown on the home timeline, v1 selected mode and RSS. */
export function selectedCondition(now: Date) {
  return sql`p.visibility = 'public' AND p.selected AND p.visible_after <= ${now}`;
}

export function channelCondition(channel: ChannelKey | null | undefined) {
  if (!channel || channel === "all") return sql``;
  if (channel === "firstParty") return sql`AND p.first_party`;
  return sql`AND p.channel = ${channel}`;
}

export function categoryCondition(category: CategoryKey | null | undefined, _v1 = false) {
  if (!category) return sql``;
  return sql`AND p.category = ${category}`;
}

export function tagCondition(tag: string | null | undefined) {
  if (!tag) return sql``;
  return sql`AND p.tags @> ${[tag]}::text[]`;
}

export function topicCondition(topicTags: string[] | null | undefined) {
  if (!topicTags || topicTags.length === 0) return sql``;
  return sql`AND p.tags && ${topicTags}::text[]`;
}

export function toItemSummary(row: ItemRow): ItemSummary {
  return {
    id: row.id,
    revision: row.revision,
    title: row.title,
    originalTitle: row.original_title,
    summary: row.summary,
    reason: row.selected ? row.reason : null,
    source: {
      id: row.source_id,
      name: row.source_name,
      kind: row.source_kind,
      firstParty: row.first_party,
    },
    links: { original: row.url },
    publishedAt: row.published_at?.toISOString() ?? null,
    discoveredAt: row.discovered_at.toISOString(),
    timelineAt: row.timeline_at.toISOString(),
    category: toPublicApiCategory(row.category),
    tags: displayTags(row.tags),
    score: row.score === null ? null : Math.round(Number(row.score)),
    selected: row.selected,
    channel: row.channel,
    story: row.story_public_id ? { publicId: row.story_public_id, title: row.story_title ?? "" } : null,
  };
}

/** Project the shared public article into the exact fields a site card renders. */
export function toFeedItemSummary(row: ItemRow): FeedItemSummary {
  const item = toItemSummary(row);
  return {
    id: item.id,
    title: item.title,
    summary: item.summary,
    reason: item.reason,
    source: { name: item.source.name },
    publishedAt: item.publishedAt,
    timelineAt: item.timelineAt,
    category: item.category,
    tags: item.tags,
    score: item.score,
    selected: item.selected,
    channel: item.channel,
  };
}

export async function fetchItemsByIds(ids: string[], db: Db = sql): Promise<Map<string, ItemRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db<ItemRow[]>`SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE p.article_id IN ${db(ids)}`;
  return new Map(rows.map((r) => [r.id, r]));
}

/** Both branches bind to the article's current source revision, not the publication's independent revision counter. */
export function newsJurisdictionScope(value: string | null | undefined) {
  return { jurisdictionCodes: jurisdictionDescendants(value ?? ""), jurisdictionRecipe: geographyRecipe() };
}
export function jurisdictionCondition(value: string | null, descendants: string[] | undefined, recipe: string) {
  return sql`AND EXISTS(SELECT 1 FROM articles ga LEFT JOIN publication.news_geography g ON g.article_id=ga.id AND g.article_revision=ga.revision
    AND g.analysis_id IS NOT DISTINCT FROM p.analysis_id AND g.recipe=${recipe}
    WHERE ga.id=p.article_id AND (${value}::text IS NULL OR (${value}='unknown' AND (g.state IS NULL OR g.state IN ('unknown','partial')))
    OR (${value}='none' AND g.state='none') OR (g.jurisdictions && coalesce(${descendants ?? null}::text[],'{}'::text[]))))`;
}
/** Cross-lane facet port: known membership only; unknown also counts partially inspected material. No cache or paid work. */
export async function currentNewsJurisdictionCounts(): Promise<{ counts: Record<string, number>; unknown: number }> {
  const now = new Date(),
    rows = await sql<{ codes: string[] | null; state: string | null; n: number }[]>`
    SELECT g.jurisdictions AS codes,g.state,count(*)::int AS n FROM publications p JOIN articles a ON a.id=p.article_id JOIN sources s ON s.id=p.source_id
    LEFT JOIN publication.news_geography g ON g.article_id=p.article_id AND g.article_revision=a.revision AND g.analysis_id IS NOT DISTINCT FROM p.analysis_id AND g.recipe=${geographyRecipe()}
    WHERE p.channel='news' AND s.lane='news' AND s.participation_mode='editorial' AND p.visibility='public' AND p.eligible AND (NOT p.selected OR p.visible_after<=${now})
    GROUP BY g.jurisdictions,g.state`;
  const counts = Object.fromEntries(JURISDICTIONS.map((j) => [j.id, 0]));
  let unknown = 0;
  for (const row of rows) {
    if (!row.state || row.state === "unknown" || row.state === "partial") unknown += row.n;
    for (const j of JURISDICTIONS) if (row.codes?.some((code) => jurisdictionDescendants(j.id).includes(code))) counts[j.id]! += row.n;
  }
  return { counts, unknown };
}
