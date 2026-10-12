import { readerAttribution, attachSourcePolicies } from "./reader-context.ts";
import { JURISDICTIONS, jurisdictionDescendants } from "@amp/industry/jurisdictions";
import { geographyRecipe } from "../editorial/geography.ts";
import { jurisdictionCodesInText, jurisdictionTextSql, mentionByTag, mentionPredicate, topicMemberSql, type ReadMatcherValues } from "./mentions.ts";
// Public read layer, item level. Every exit (site API, v1, RSS, MCP, sitemap) reads
// items through these functions; visibility, release gate and body licences are applied here.
import { toPublicApiCategory, type CategoryKey, type ChannelKey } from "@amp/contracts/taxonomy";
import { addCalendarMonths, beijingDate, beijingMidnight } from "@amp/contracts/time";
import type { FeedItemSummary, ItemSummary, SourceKind } from "@amp/contracts/site";
import { dbOf, type Db } from "../db.ts";
import { publicationTextMatches, bodyTextMatches } from "./read-predicates.ts";
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
  source_policy?: unknown;
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

/** Selected set: the 精选 mark, 全部矿业动态, topics, v1 selected mode, RSS and daily issues. No age window. */
export function selectedCondition(now: Date) {
  return sql`p.visibility = 'public' AND p.selected AND p.visible_after <= ${now}`;
}

/**
 * Homepage featured list and its category tabs. Three Beijing calendar months, by the article's
 * archive date (`timeline_at`), not the crawl time. Older picks leave this entrance only.
 */
export function featuredEntryCondition(now: Date) {
  const start = beijingMidnight(addCalendarMonths(beijingDate(now), -3));
  return sql`${selectedCondition(now)} AND p.timeline_at >= ${start}`;
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
  const mention = mentionByTag(tag);
  if (!mention) return sql`AND p.tags @> ${[tag]}::text[]`;
  // A company tag also accepts the entity marker the topic page already uses.
  const stored = mention.kind === "company" ? [mention.label, `entity:${mention.id}`] : [tag];
  return sql`AND (p.tags && ${stored}::text[] OR ${mentionPredicate(mention.needles)})`;
}

export function topicCondition(topicTags: string[] | null | undefined) {
  if (!topicTags || topicTags.length === 0) return sql``;
  return sql`AND ${topicMemberSql(topicTags)}`;
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
    attribution: readerAttribution(row.source_name, row.url, row.source_policy),
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
  await attachSourcePolicies(rows, db);
  return new Map(rows.map((r) => [r.id, r]));
}

/** Both branches bind to the article's current source revision, not the publication's independent revision counter. */
export function newsJurisdictionScope(value: string | null | undefined) {
  return { jurisdictionCodes: jurisdictionDescendants(value ?? ""), jurisdictionRecipe: geographyRecipe() };
}
export function jurisdictionCondition(value: string | null, descendants: string[] | undefined, recipe: string) {
  const named = !!value && value !== "unknown" && value !== "none";
  const text = named ? jurisdictionTextSql(descendants?.length ? descendants : [value]) : sql`FALSE`;
  // Geography tags stay authoritative. Title, summary and the country tag count as well,
  // so a published article is not dropped only because the geography pass never tagged it.
  // "unknown" and "none" stay geography states: a named country in the title is not "unknown".
  return sql`AND (
    ${value}::text IS NULL
    OR (${value} = 'unknown' AND EXISTS (SELECT 1 FROM articles ga LEFT JOIN publication.news_geography g
      ON g.article_id=ga.id AND g.article_revision=ga.revision AND g.analysis_id IS NOT DISTINCT FROM p.analysis_id AND g.recipe=${recipe}
      WHERE ga.id=p.article_id AND (g.state IS NULL OR g.state IN ('unknown','partial'))))
    OR (${value} = 'none' AND EXISTS (SELECT 1 FROM articles ga LEFT JOIN publication.news_geography g
      ON g.article_id=ga.id AND g.article_revision=ga.revision AND g.analysis_id IS NOT DISTINCT FROM p.analysis_id AND g.recipe=${recipe}
      WHERE ga.id=p.article_id AND g.state='none'))
    OR (${named} AND (
      EXISTS (SELECT 1 FROM articles ga LEFT JOIN publication.news_geography g
        ON g.article_id=ga.id AND g.article_revision=ga.revision AND g.analysis_id IS NOT DISTINCT FROM p.analysis_id AND g.recipe=${recipe}
        WHERE ga.id=p.article_id AND g.jurisdictions && coalesce(${descendants ?? null}::text[], '{}'::text[]))
      OR ${text}
    ))
  )`;
}
/** Cross-lane facet port: known membership only; unknown also counts partially inspected material. No cache or paid work. */
export async function currentNewsJurisdictionCounts(): Promise<{ counts: Record<string, number>; unknown: number }> {
  const now = new Date(),
    rows = await sql<{ codes: string[] | null; state: string | null; search_text: string }[]>`
    SELECT g.jurisdictions AS codes, g.state, coalesce(p.search_text, '') AS search_text
    FROM publications p JOIN articles a ON a.id=p.article_id JOIN sources s ON s.id=p.source_id
    LEFT JOIN publication.news_geography g ON g.article_id=p.article_id AND g.article_revision=a.revision AND g.analysis_id IS NOT DISTINCT FROM p.analysis_id AND g.recipe=${geographyRecipe()}
    WHERE p.channel='news' AND s.lane='news' AND s.participation_mode='editorial' AND p.visibility='public' AND p.eligible AND (NOT p.selected OR p.visible_after<=${now})`;
  const counts = Object.fromEntries(JURISDICTIONS.map((j) => [j.id, 0]));
  let unknown = 0;
  for (const row of rows) {
    if (!row.state || row.state === "unknown" || row.state === "partial") unknown += 1;
    const hit = new Set<string>();
    for (const code of row.codes ?? []) for (const j of JURISDICTIONS) if (jurisdictionDescendants(j.id).includes(code)) hit.add(j.id);
    for (const code of jurisdictionCodesInText(row.search_text)) for (const j of JURISDICTIONS) if (jurisdictionDescendants(j.id).includes(code)) hit.add(j.id);
    for (const id of hit) counts[id] = (counts[id] ?? 0) + 1;
  }
  return { counts, unknown };
}

/** Public evidence used by the event judge, bound to the caller's current material revisions. */
export async function newsRelationJurisdictions(materials: { id: string; revision: number }[], db: Db = sql) {
  if (!materials.length) return [];
  const rows = await db<
    { id: string; revision: number; jurisdiction: string | null }[]
  >`SELECT article_id AS id,article_revision AS revision,primary_jurisdiction AS jurisdiction
    FROM publication.news_geography WHERE article_id=ANY(${materials.map((m) => m.id)}::text[])`;
  return rows.filter((r) => materials.some((m) => m.id === r.id && m.revision === r.revision));
}
export async function publicNewsDigestInput(ids: string[], db: Db = sql) {
  return db<{ article_id: string; title: string; summary: string | null }[]>`SELECT article_id,title,summary FROM publications
    WHERE article_id=ANY(${ids}::text[]) AND visibility='public' AND eligible ORDER BY article_id`;
}

/** Current public news source links, for explicit news/policy navigation only. */
export async function readPublicNewsLinkCandidates(articleId: string | null, officialUrl: string | null) {
  const urlPattern = officialUrl === null ? null : `%${officialUrl.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
  return sql<{ id: string; title: string; body_html: string }[]>`SELECT p.article_id AS id,p.title,a.body_html
    FROM publications p JOIN articles a ON a.id=p.article_id JOIN sources s ON s.id=p.source_id
    WHERE p.visibility='public' AND p.eligible AND s.participation_mode='editorial'
      AND (${articleId}::text IS NULL OR p.article_id=${articleId})
      AND (${officialUrl}::text IS NULL OR a.body_html LIKE ${urlPattern})
      AND (NOT p.selected OR p.visible_after<=now())
    ORDER BY p.timeline_at DESC,p.article_id DESC LIMIT 100`;
}

/** Beijing day bounds apply to the timeline; source dates and their precision remain unchanged. */
export function publicationDateCondition(start: Date | null | undefined, end: Date | null | undefined) {
  if (start && end) return sql`AND p.timeline_at >= ${start} AND p.timeline_at < ${end}`;
  if (start) return sql`AND p.timeline_at >= ${start}`;
  if (end) return sql`AND p.timeline_at < ${end}`;
  return sql``;
}

/** Geography qualification stays in this established article/publication read port. */
export function currentGeographyMatch(code: string | null, codes: string[], recipe: string) {
  return sql`CASE WHEN ${code}='unknown' THEN EXISTS (SELECT 1 FROM articles ga LEFT JOIN publication.news_geography g
    ON g.article_id=ga.id AND g.article_revision=ga.revision AND g.analysis_id IS NOT DISTINCT FROM p.analysis_id AND g.recipe=${recipe}
    WHERE ga.id=p.article_id AND (g.state IS NULL OR g.state IN ('unknown','partial')))
    WHEN ${code}='none' THEN EXISTS (SELECT 1 FROM articles ga LEFT JOIN publication.news_geography g
      ON g.article_id=ga.id AND g.article_revision=ga.revision AND g.analysis_id IS NOT DISTINCT FROM p.analysis_id AND g.recipe=${recipe}
      WHERE ga.id=p.article_id AND g.state='none')
    ELSE EXISTS (SELECT 1 FROM articles ga JOIN publication.news_geography g
      ON g.article_id=ga.id AND g.article_revision=ga.revision AND g.analysis_id IS NOT DISTINCT FROM p.analysis_id AND g.recipe=${recipe}
      WHERE ga.id=p.article_id AND g.jurisdictions && ${codes}::text[]) END`;
}
export interface PublicReadScope {
  category: string | null;
  source: string | null;
  jurisdiction: string | null;
  jurisdictionCodes: string[];
  jurisdictionRecipe: string;
  rangeStart: Date | null;
  rangeEnd: Date | null;
  selected: boolean;
}

export interface PublicApiReadScope extends PublicReadScope {
  by: "timeline" | "published";
  now: Date;
  windowStart: Date | null;
  afterAt: Date | null;
  afterId: string | null;
  limit: number;
}
export interface PublicStoryReadScope extends PublicReadScope {
  merged: boolean;
  now: Date;
}
export async function readPublicApiItems(db: Db, query: PublicApiReadScope, matchers: ReadMatcherValues): Promise<Array<ApiItemRow & { sort_at: Date }>> {
  const sort = sql`CASE WHEN ${query.by}='published' THEN coalesce(p.published_at,p.discovered_at) WHEN ${query.selected} THEN p.sort_at ELSE p.timeline_at END`;
  return db<(ApiItemRow & { sort_at: Date })[]>`SELECT ${API_ITEM_COLUMNS},${sort} AS sort_at ${API_ITEM_FROM}
    WHERE p.visibility='public' AND (NOT p.selected OR p.visible_after<=${query.now})
      AND (${!query.selected} OR p.selected) AND (${query.selected} OR p.eligible)

    AND (${query.category}::text IS NULL OR p.category=${query.category})
    AND (${query.source}::text IS NULL OR p.source_id=${query.source})
    ${publicationDateCondition(query.rangeStart, query.rangeEnd)}
    AND (${matchers.tagTags}::text[] IS NULL OR p.tags && ${matchers.tagTags}::text[] OR (${matchers.tagText.active} AND ${publicationTextMatches(matchers.tagText)}))
    AND (${matchers.topicTags}::text[] IS NULL OR p.tags && ${matchers.topicTags}::text[] OR (${matchers.topicText.active} AND ${publicationTextMatches(matchers.topicText)}))
    AND (${query.jurisdiction}::text IS NULL OR ${currentGeographyMatch(query.jurisdiction, query.jurisdictionCodes, query.jurisdictionRecipe)}
      OR (${query.jurisdiction} NOT IN ('unknown','none') AND (p.tags && ${matchers.jurisdictionTags}::text[] OR ${publicationTextMatches(matchers.jurisdictionText)})))
    AND (${!matchers.term0.active} OR ${publicationTextMatches(matchers.term0)} OR EXISTS (SELECT 1 FROM pool_search ps WHERE ps.article_id=p.article_id AND ${bodyTextMatches(matchers.term0)} OFFSET 0))
    AND (${!matchers.term1.active} OR ${publicationTextMatches(matchers.term1)} OR EXISTS (SELECT 1 FROM pool_search ps WHERE ps.article_id=p.article_id AND ${bodyTextMatches(matchers.term1)} OFFSET 0))
    AND (${!matchers.term2.active} OR ${publicationTextMatches(matchers.term2)} OR EXISTS (SELECT 1 FROM pool_search ps WHERE ps.article_id=p.article_id AND ${bodyTextMatches(matchers.term2)} OFFSET 0))
    AND (${!matchers.term3.active} OR ${publicationTextMatches(matchers.term3)} OR EXISTS (SELECT 1 FROM pool_search ps WHERE ps.article_id=p.article_id AND ${bodyTextMatches(matchers.term3)} OFFSET 0))
    AND (${!matchers.term4.active} OR ${publicationTextMatches(matchers.term4)} OR EXISTS (SELECT 1 FROM pool_search ps WHERE ps.article_id=p.article_id AND ${bodyTextMatches(matchers.term4)} OFFSET 0))
    AND (${!matchers.term5.active} OR ${publicationTextMatches(matchers.term5)} OR EXISTS (SELECT 1 FROM pool_search ps WHERE ps.article_id=p.article_id AND ${bodyTextMatches(matchers.term5)} OFFSET 0))
    AND (${query.windowStart}::timestamptz IS NULL OR ${sort}>=${query.windowStart}) AND ${sort}<=${query.now}
    AND (${query.afterAt}::timestamptz IS NULL OR (${sort},p.article_id)<(${query.afterAt},${query.afterId}))
    ORDER BY ${sort} DESC,p.article_id DESC LIMIT ${query.limit}`;
}
export async function readPublicStoryDirectory(db: Db, query: PublicStoryReadScope, matchers: ReadMatcherValues): Promise<Array<{ id: string; latest: Date }>> {
  return db<{ id: string; latest: Date }[]>`SELECT st.public_id::text AS id,max(p.timeline_at) AS latest
    FROM stories st JOIN publications p ON p.story_id=st.id
    WHERE ((${query.merged} AND st.merged_into IS NOT NULL) OR (${!query.merged} AND st.merged_into IS NULL))
      AND p.visibility='public' AND p.eligible AND (NOT p.selected OR p.visible_after<=${query.now}) AND (${!query.selected} OR p.selected)

    AND (${query.category}::text IS NULL OR p.category=${query.category})
    AND (${query.source}::text IS NULL OR p.source_id=${query.source})
    ${publicationDateCondition(query.rangeStart, query.rangeEnd)}
    AND (${matchers.tagTags}::text[] IS NULL OR p.tags && ${matchers.tagTags}::text[] OR (${matchers.tagText.active} AND ${publicationTextMatches(matchers.tagText)}))
    AND (${matchers.topicTags}::text[] IS NULL OR p.tags && ${matchers.topicTags}::text[] OR (${matchers.topicText.active} AND ${publicationTextMatches(matchers.topicText)}))
    AND (${query.jurisdiction}::text IS NULL OR ${currentGeographyMatch(query.jurisdiction, query.jurisdictionCodes, query.jurisdictionRecipe)}
      OR (${query.jurisdiction} NOT IN ('unknown','none') AND (p.tags && ${matchers.jurisdictionTags}::text[] OR ${publicationTextMatches(matchers.jurisdictionText)})))
    AND (${!matchers.term0.active} OR ${publicationTextMatches(matchers.term0)} OR EXISTS (SELECT 1 FROM pool_search ps WHERE ps.article_id=p.article_id AND ${bodyTextMatches(matchers.term0)} OFFSET 0))
    AND (${!matchers.term1.active} OR ${publicationTextMatches(matchers.term1)} OR EXISTS (SELECT 1 FROM pool_search ps WHERE ps.article_id=p.article_id AND ${bodyTextMatches(matchers.term1)} OFFSET 0))
    AND (${!matchers.term2.active} OR ${publicationTextMatches(matchers.term2)} OR EXISTS (SELECT 1 FROM pool_search ps WHERE ps.article_id=p.article_id AND ${bodyTextMatches(matchers.term2)} OFFSET 0))
    AND (${!matchers.term3.active} OR ${publicationTextMatches(matchers.term3)} OR EXISTS (SELECT 1 FROM pool_search ps WHERE ps.article_id=p.article_id AND ${bodyTextMatches(matchers.term3)} OFFSET 0))
    AND (${!matchers.term4.active} OR ${publicationTextMatches(matchers.term4)} OR EXISTS (SELECT 1 FROM pool_search ps WHERE ps.article_id=p.article_id AND ${bodyTextMatches(matchers.term4)} OFFSET 0))
    AND (${!matchers.term5.active} OR ${publicationTextMatches(matchers.term5)} OR EXISTS (SELECT 1 FROM pool_search ps WHERE ps.article_id=p.article_id AND ${bodyTextMatches(matchers.term5)} OFFSET 0))
    GROUP BY st.public_id ORDER BY latest DESC,st.public_id DESC`;
}
