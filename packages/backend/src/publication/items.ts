import { CURRENT_SOURCE_TIME, publicSourceTime, sourceInstant } from "./source-time.ts";
import { attachRepresentativePriority, pickRepresentative, type RepresentativeIdentity } from "./representative.ts";
import { readerAttribution, attachSourcePolicies } from "./reader-context.ts";
import { JURISDICTIONS, jurisdictionDescendants } from "@amp/industry/jurisdictions";
import { geographyRecipe, compatibleGeographyRecipes } from "../editorial/geography.ts";
import type { ReadMatcherValues } from "./mentions.ts";
// Public read layer, item level. Every exit (site API, v1, RSS, MCP, sitemap) reads
// items through these functions; visibility, release gate and body licences are applied here.
import { toPublicApiCategory, type CategoryKey, type ChannelKey } from "@amp/contracts/taxonomy";
import { addCalendarMonths, beijingDate, beijingMidnight } from "@amp/contracts/time";
import type { FeedItemSummary, ItemSummary, SourceKind } from "@amp/contracts/site";
import { sql, type Db } from "../db.ts";
import { publicationTextMatches, publicBodyTextMatches } from "./read-predicates.ts";
import { displayTags, independentSelectedSources } from "./rules.ts";
import { postFeedView, publicPostSummary } from "./post-view.ts";
import { config } from "../config.ts";

export interface ItemRow {
  post_summary_kind?: string | null;
  original_post_admission_required?: boolean | null;
  is_original_post?: boolean;
  x_post?: unknown;
  x_post_revision?: number | null;
  content_revision?: number;
  source_site_fulltext?: boolean;
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
  source_time?: unknown;
  first_public_at?: Date | null;
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
export const ITEM_COLUMNS = () => sql`
  p.article_id AS id, p.revision, p.title, p.original_title,
  p.is_original_post,p.x_post->>'summaryKind' AS post_summary_kind,p.original_post_admission_required,p.x_post,p.x_post_revision,a.revision AS content_revision,
  coalesce(p.summary, CASE WHEN s.site_fulltext AND p.visibility = 'public' AND ${originalPostAdmissionCondition()} THEN p.source_excerpt END) AS summary, p.reason, p.category, p.tags, p.score,
  (${confirmedSelected()}) AS selected, p.eligible, p.channel, p.url, p.published_at, ${CURRENT_SOURCE_TIME()} AS source_time,p.first_public_at, p.discovered_at, p.timeline_at, p.sort_at, p.first_party, p.visibility,
  p.body_mode, p.syndicate, p.indexable, p.visible_after, p.backfill, p.fact_id, p.story_id,
  s.id AS source_id, s.name AS source_name, s.kind AS source_kind, s.participation_mode AS source_mode,s.site_fulltext AS source_site_fulltext,
  a.author, a.language,
  st.public_id::text AS story_public_id,
  st.title AS story_title`;

/** Public API listings never render article bodies or story metadata. */
export type ApiItemRow = Pick<
  ItemRow,
  | "id"
  | "title"
  | "original_title"
  | "summary"
  | "source_name"
  | "url"
  | "published_at"
  | "discovered_at"
  | "category"
  | "score"
  | "selected"
  | "reason"
  | "source_time"
> &
  Pick<ItemRow, "source_id" | "source_policy" | "is_original_post" | "post_summary_kind">;
export const API_ITEM_COLUMNS = () => sql`
  p.article_id AS id, p.title, p.original_title, p.summary, s.name AS source_name, p.url,s.id AS source_id,p.is_original_post,p.x_post->>'summaryKind' AS post_summary_kind,
  p.published_at,${CURRENT_SOURCE_TIME()} AS source_time,p.discovered_at, p.category, p.score, (${confirmedSelected()}) AS selected, p.reason`;
export const API_ITEM_FROM = () => sql`FROM publications p JOIN sources s ON s.id = p.source_id JOIN articles a ON a.id=p.article_id`;

/** Apply the same current summary grant to every machine listing, including sync cursors. */
export async function protectApiPostRows<T extends ApiItemRow>(rows: T[], db: Db = sql, now = Date.now()): Promise<T[]> {
  const posts = rows.filter((row) => row.is_original_post);
  await attachSourcePolicies(posts, db);
  for (const row of posts) {
    row.original_title = null;
    Object.assign(row, publicPostSummary(row, now));
  }
  return rows;
}

/** A translation of an older revision is left out: the original changed after it (the worker translates it again). */
export const ITEM_FROM = () => sql`
  FROM publications p
  JOIN sources s ON s.id = p.source_id
  JOIN articles a ON a.id = p.article_id
  LEFT JOIN stories st ON st.id = p.story_id AND st.merged_into IS NULL
  LEFT JOIN translations tr ON tr.article_id = p.article_id AND tr.lang = 'zh' AND tr.revision >= a.revision`;

/** Both flags are written together only by the current confirmed publication projection.
 * Legacy selected=true rows have selection_candidate=false until that projection is rebuilt.
 * Non-representative confirmed members remain selected; seat is a separate distribution choice.
 */
export function confirmedSelected() {
  return sql`p.selected AND p.selection_candidate`;
}

/** Projection-only gate: unknown original-post classifications fail closed; ordinary articles are unchanged. */
export const originalPostAdmissionCondition = () =>
  sql`(${config.originalPostAdmissionEnabled} OR NOT p.is_original_post OR p.original_post_admission_required IS FALSE)`;

/** Preserve stored seats unless this admission gate removes that fact's ordinary representative. */
export async function admissionReplacementSeats(now: Date, db: Db = sql): Promise<string[]> {
  if (config.originalPostAdmissionEnabled) return [];
  const independent = independentSelectedSources();
  const rows = await db<{ article_id: string; fact_id: number; representative_priority: number; body_mode: string; score: number | null; timeline_at: Date }[]>`
    SELECT p.article_id,p.fact_id,p.representative_priority,p.body_mode,p.score,p.timeline_at FROM publications p
    WHERE ${selectedCondition(now)} AND p.source_id<>ALL(${independent}::text[])
      AND p.fact_id IN (SELECT blocked.fact_id FROM publications blocked WHERE blocked.seat AND blocked.is_original_post
        AND blocked.original_post_admission_required IS DISTINCT FROM false AND blocked.source_id<>ALL(${independent}::text[]))`;
  const facts = new Map<number, Array<(typeof rows)[number]>>();
  for (const row of rows) facts.set(row.fact_id, [...(facts.get(row.fact_id) ?? []), row]);
  return [...facts.values()].map((members) => pickRepresentative(members).article_id);
}

/** Listed items: public, and a selected item only after its release gate. */
export function listedCondition(now: Date) {
  return sql`p.visibility = 'public' AND ${originalPostAdmissionCondition()} AND (NOT p.selected OR p.visible_after <= ${now})`;
}

/** Selected set: the 精选 mark, 全部矿业动态, topics, v1 selected mode, RSS and daily issues. No age window. */
export function selectedCondition(now: Date) {
  return sql`p.visibility = 'public' AND ${originalPostAdmissionCondition()} AND p.eligible AND ${confirmedSelected()} AND p.visible_after <= ${now}`;
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
  return sql`AND (${!channel || channel === "all"} OR (${channel === "firstParty"} AND p.first_party) OR (${channel !== "firstParty"} AND p.channel=${channel ?? null}))`;
}
export function categoryCondition(category: CategoryKey | null | undefined, _v1 = false) {
  return sql`AND (${!category} OR p.category=${category ?? null})`;
}

export function tagCondition(values: ReadMatcherValues) {
  return sql`AND (${values.tagTags}::text[] IS NULL OR p.tags && ${values.tagTags}::text[] OR ${publicationTextMatches(values.tagText)})`;
}
export function topicCondition(values: ReadMatcherValues) {
  return sql`AND (${values.topicTags}::text[] IS NULL OR CASE WHEN ${values.topicJurisdiction}::text IS NOT NULL
    THEN ${currentGeographyMatch(values.topicJurisdiction, values.topicJurisdictionCodes, values.topicRecipe)}
    ELSE p.tags && ${values.topicTags}::text[] OR ${publicationTextMatches(values.topicText)} END)`;
}

export function toItemSummary(row: ItemRow): ItemSummary {
  const copy = publicPostSummary(row);
  return {
    id: row.id,
    revision: row.revision,
    title: copy.title,
    originalTitle: row.is_original_post ? null : row.original_title,
    summary: copy.summary,
    reason: row.selected ? copy.reason : null,
    source: {
      id: row.source_id,
      name: row.source_name,
      kind: row.source_kind,
      firstParty: row.first_party,
    },
    links: { original: row.url },
    publishedAt: sourceInstant(row.source_time)?.toISOString() ?? null,
    sourceTime: publicSourceTime(row.source_time),
    firstPublicAt: row.first_public_at?.toISOString() ?? null,
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
    sourceTime: item.sourceTime,
    firstPublicAt: item.firstPublicAt,
    timelineAt: item.timelineAt,
    category: item.category,
    tags: item.tags,
    score: item.score,
    selected: item.selected,
    channel: item.channel,
    ...(row.is_original_post ? { x: postFeedView(row) } : {}),
  };
}

export async function fetchItemsByIds(ids: string[], db: Db = sql): Promise<Map<string, ItemRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db<ItemRow[]>`SELECT ${ITEM_COLUMNS()} ${ITEM_FROM()} WHERE p.article_id IN ${db(ids)} AND ${originalPostAdmissionCondition()}`;
  await attachSourcePolicies(rows, db);
  for (const row of rows) Object.assign(row, publicPostSummary(row));
  return new Map(rows.map((r) => [r.id, r]));
}

/** Both branches bind to the article's current source revision, not the publication's independent revision counter. */
export function newsJurisdictionScope(value: string | null | undefined) {
  return { jurisdictionCodes: jurisdictionDescendants(value ?? ""), jurisdictionRecipe: geographyRecipe(), jurisdictionRecipes: compatibleGeographyRecipes() };
}
export function jurisdictionCondition(value: string | null, descendants: string[] | undefined, recipe: string, _values: ReadMatcherValues) {
  // Country filters use evidenced locations; country mentions remain available through text search.
  return sql`AND (${value}::text IS NULL OR ${currentGeographyMatch(value, descendants ?? [], recipe)})`;
}
/** Cross-lane facet port: known membership only; unknown also counts partially inspected material. No cache or paid work. */
export async function currentNewsJurisdictionCounts(): Promise<{ counts: Record<string, number>; unknown: number }> {
  const now = new Date(),
    rows = await sql<{ codes: string[] | null; state: string | null }[]>`
    SELECT g.jurisdictions AS codes, g.state
    FROM publications p JOIN articles a ON a.id=p.article_id JOIN sources s ON s.id=p.source_id
    LEFT JOIN publication.news_geography g ON g.article_id=p.article_id AND g.article_revision=a.revision AND g.analysis_id IS NOT DISTINCT FROM p.analysis_id AND g.recipe=ANY(${compatibleGeographyRecipes()}::text[])
    WHERE p.channel='news' AND s.lane='news' AND s.participation_mode='editorial' AND p.visibility='public' AND ${originalPostAdmissionCondition()} AND p.eligible AND (NOT p.selected OR p.visible_after<=${now})`;
  const counts = Object.fromEntries(JURISDICTIONS.map((j) => [j.id, 0]));
  let unknown = 0;
  for (const row of rows) {
    if (!row.state || row.state === "unknown" || row.state === "partial") unknown += 1;
    const hit = new Set<string>();
    for (const code of row.codes ?? []) for (const j of JURISDICTIONS) if (jurisdictionDescendants(j.id).includes(code)) hit.add(j.id);
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
  return db<{ article_id: string; title: string; summary: string | null }[]>`SELECT article_id,title,summary FROM publications p
    WHERE article_id=ANY(${ids}::text[]) AND visibility='public' AND ${originalPostAdmissionCondition()} AND eligible ORDER BY article_id`;
}

/** Current public news source links, for explicit news/policy navigation only. */
export async function readPublicNewsLinkCandidates(articleId: string | null, officialUrl: string | null) {
  const urlPattern = officialUrl === null ? null : `%${officialUrl.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
  return sql<{ id: string; title: string; body_html: string }[]>`SELECT p.article_id AS id,p.title,a.body_html
    FROM publications p JOIN articles a ON a.id=p.article_id JOIN sources s ON s.id=p.source_id
    WHERE p.visibility='public' AND ${originalPostAdmissionCondition()} AND p.eligible AND s.participation_mode='editorial'
      AND (${articleId}::text IS NULL OR p.article_id=${articleId})
      AND (${officialUrl}::text IS NULL OR a.body_html LIKE ${urlPattern})
      AND (NOT p.selected OR p.visible_after<=now())
    ORDER BY p.timeline_at DESC,p.article_id DESC LIMIT 100`;
}

/** Beijing day bounds apply to the timeline; source dates and their precision remain unchanged. */
export function publicationDateCondition(start: Date | null | undefined, end: Date | null | undefined) {
  return sql`AND (${start ?? null}::timestamptz IS NULL OR p.timeline_at>=${start ?? null})
    AND (${end ?? null}::timestamptz IS NULL OR p.timeline_at<${end ?? null})`;
}

/** Geography qualification stays in this established article/publication read port. */
export function currentGeographyMatch(code: string | null, codes: string[], recipe: string) {
  return sql`CASE WHEN ${code}='unknown' THEN EXISTS (SELECT 1 FROM articles ga LEFT JOIN publication.news_geography g
    ON g.article_id=ga.id AND g.article_revision=ga.revision AND g.analysis_id IS NOT DISTINCT FROM p.analysis_id AND g.recipe=ANY(${compatibleGeographyRecipes(recipe)}::text[])
    WHERE ga.id=p.article_id AND (g.state IS NULL OR g.state IN ('unknown','partial')))
    WHEN ${code}='none' THEN EXISTS (SELECT 1 FROM articles ga LEFT JOIN publication.news_geography g
      ON g.article_id=ga.id AND g.article_revision=ga.revision AND g.analysis_id IS NOT DISTINCT FROM p.analysis_id AND g.recipe=ANY(${compatibleGeographyRecipes(recipe)}::text[])
      WHERE ga.id=p.article_id AND g.state='none')
    ELSE EXISTS (SELECT 1 FROM articles ga JOIN publication.news_geography g
      ON g.article_id=ga.id AND g.article_revision=ga.revision AND g.analysis_id IS NOT DISTINCT FROM p.analysis_id AND g.recipe=ANY(${compatibleGeographyRecipes(recipe)}::text[])
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
  const countryScope = !!query.jurisdiction || !!matchers.topicJurisdiction;
  const replacements = query.selected && !countryScope ? await admissionReplacementSeats(query.now, db) : [];
  const sort = sql`CASE WHEN ${query.by}='published' THEN coalesce(p.published_at,p.discovered_at) WHEN ${query.selected} THEN p.sort_at ELSE p.timeline_at END`;
  const rows = await db<(ApiItemRow & { sort_at: Date })[]>`SELECT ${API_ITEM_COLUMNS()},${sort} AS sort_at ${API_ITEM_FROM()}
    WHERE p.visibility='public' AND ${originalPostAdmissionCondition()} AND (NOT p.selected OR p.visible_after<=${query.now})
      AND p.eligible AND (${!query.selected} OR (${confirmedSelected()} AND (${countryScope} OR p.seat OR p.article_id=ANY(${replacements}::text[]))))

    AND (${query.category}::text IS NULL OR p.category=${query.category})
    AND (${query.source}::text IS NULL OR p.source_id=${query.source})
    ${publicationDateCondition(query.rangeStart, query.rangeEnd)}
    AND (${matchers.tagTags}::text[] IS NULL OR p.tags && ${matchers.tagTags}::text[] OR (${matchers.tagText.active} AND ${publicationTextMatches(matchers.tagText)}))
    ${topicCondition(matchers)}
    ${jurisdictionCondition(query.jurisdiction, query.jurisdictionCodes, query.jurisdictionRecipe, matchers)}
    AND (${!matchers.term0.active} OR ${publicationTextMatches(matchers.term0)} OR EXISTS (SELECT 1 FROM pool_search ps WHERE ps.article_id=p.article_id AND ${publicBodyTextMatches(matchers.term0)} OFFSET 0))
    AND (${!matchers.term1.active} OR ${publicationTextMatches(matchers.term1)} OR EXISTS (SELECT 1 FROM pool_search ps WHERE ps.article_id=p.article_id AND ${publicBodyTextMatches(matchers.term1)} OFFSET 0))
    AND (${!matchers.term2.active} OR ${publicationTextMatches(matchers.term2)} OR EXISTS (SELECT 1 FROM pool_search ps WHERE ps.article_id=p.article_id AND ${publicBodyTextMatches(matchers.term2)} OFFSET 0))
    AND (${!matchers.term3.active} OR ${publicationTextMatches(matchers.term3)} OR EXISTS (SELECT 1 FROM pool_search ps WHERE ps.article_id=p.article_id AND ${publicBodyTextMatches(matchers.term3)} OFFSET 0))
    AND (${!matchers.term4.active} OR ${publicationTextMatches(matchers.term4)} OR EXISTS (SELECT 1 FROM pool_search ps WHERE ps.article_id=p.article_id AND ${publicBodyTextMatches(matchers.term4)} OFFSET 0))
    AND (${!matchers.term5.active} OR ${publicationTextMatches(matchers.term5)} OR EXISTS (SELECT 1 FROM pool_search ps WHERE ps.article_id=p.article_id AND ${publicBodyTextMatches(matchers.term5)} OFFSET 0))
    AND (${query.windowStart}::timestamptz IS NULL OR ${sort}>=${query.windowStart}) AND ${sort}<=${query.now}
    AND (${query.afterAt}::timestamptz IS NULL OR (${sort},p.article_id)<(${query.afterAt},${query.afterId}))
    ORDER BY ${sort} DESC,p.article_id DESC LIMIT ${query.limit}`;
  return protectApiPostRows(rows, db, query.now.getTime());
}
export async function readPublicStoryDirectory(db: Db, query: PublicStoryReadScope, matchers: ReadMatcherValues): Promise<Array<{ id: string; latest: Date }>> {
  return db<{ id: string; latest: Date }[]>`SELECT st.public_id::text AS id,max(p.timeline_at) AS latest
    FROM stories st JOIN publications p ON p.story_id=st.id
    WHERE ((${query.merged} AND st.merged_into IS NOT NULL) OR (${!query.merged} AND st.merged_into IS NULL))
      AND p.visibility='public' AND ${originalPostAdmissionCondition()} AND p.eligible AND (NOT p.selected OR p.visible_after<=${query.now}) AND (${!query.selected} OR (${confirmedSelected()}))

    AND (${query.category}::text IS NULL OR p.category=${query.category})
    AND (${query.source}::text IS NULL OR p.source_id=${query.source})
    ${publicationDateCondition(query.rangeStart, query.rangeEnd)}
    AND (${matchers.tagTags}::text[] IS NULL OR p.tags && ${matchers.tagTags}::text[] OR (${matchers.tagText.active} AND ${publicationTextMatches(matchers.tagText)}))
    ${topicCondition(matchers)}
    ${jurisdictionCondition(query.jurisdiction, query.jurisdictionCodes, query.jurisdictionRecipe, matchers)}
    AND (${!matchers.term0.active} OR ${publicationTextMatches(matchers.term0)} OR EXISTS (SELECT 1 FROM pool_search ps WHERE ps.article_id=p.article_id AND ${publicBodyTextMatches(matchers.term0)} OFFSET 0))
    AND (${!matchers.term1.active} OR ${publicationTextMatches(matchers.term1)} OR EXISTS (SELECT 1 FROM pool_search ps WHERE ps.article_id=p.article_id AND ${publicBodyTextMatches(matchers.term1)} OFFSET 0))
    AND (${!matchers.term2.active} OR ${publicationTextMatches(matchers.term2)} OR EXISTS (SELECT 1 FROM pool_search ps WHERE ps.article_id=p.article_id AND ${publicBodyTextMatches(matchers.term2)} OFFSET 0))
    AND (${!matchers.term3.active} OR ${publicationTextMatches(matchers.term3)} OR EXISTS (SELECT 1 FROM pool_search ps WHERE ps.article_id=p.article_id AND ${publicBodyTextMatches(matchers.term3)} OFFSET 0))
    AND (${!matchers.term4.active} OR ${publicationTextMatches(matchers.term4)} OR EXISTS (SELECT 1 FROM pool_search ps WHERE ps.article_id=p.article_id AND ${publicBodyTextMatches(matchers.term4)} OFFSET 0))
    AND (${!matchers.term5.active} OR ${publicationTextMatches(matchers.term5)} OR EXISTS (SELECT 1 FROM pool_search ps WHERE ps.article_id=p.article_id AND ${publicBodyTextMatches(matchers.term5)} OFFSET 0))
    GROUP BY st.public_id ORDER BY latest DESC,st.public_id DESC`;
}

/** Reports reuse current item qualification but machine citations never use the website excerpt fallback. */
export async function fetchMachineReportItems(ids: string[]): Promise<Map<string, ItemRow>> {
  if (!ids.length) return new Map();
  const rows = await sql<(ItemRow & { machine_summary: string | null })[]>`SELECT ${ITEM_COLUMNS()},p.summary AS machine_summary
    ${ITEM_FROM()} WHERE p.article_id IN ${sql(ids)} AND ${originalPostAdmissionCondition()}`;
  await attachSourcePolicies(rows);
  return new Map(rows.map((row) => [row.id, { ...row, ...publicPostSummary({ ...row, summary: row.machine_summary }) }]));
}

/** Version, withdrawal and original time for event evidence, inside the caller's transaction. */
export async function readGroupingEvidencePublications(articleIds: string[], db: Db) {
  if (!articleIds.length) return [];
  return db<{ article_id: string; revision: number; withdrawn: boolean; order_time: string }[]>`
    SELECT article_id,revision,(visibility='withdrawn' OR operator_withdrawn OR (${originalPostAdmissionCondition()}) IS FALSE) AS withdrawn,
    (extract(epoch from coalesce(published_at,discovered_at))*1000000)::bigint::text AS order_time
    FROM publications p WHERE article_id=ANY(${articleIds}::text[])`;
}

export interface GroupingSelectionSnapshot extends Partial<RepresentativeIdentity> {
  article_id: string;
  source_id: string;
  material_revision: number;
  publication_revision: number;
  fact_id: number | null;
  title: string;
  summary: string | null;
  source_name: string;
  first_party: boolean;
  published_at: Date | null;
  discovered_at: Date;
  timeline_at: Date;
  body_mode: string;
  score: number | null;
}

/** Only already visible, current confirmed picks can be evidence of what readers have seen. */
export async function readGroupingSelectionSnapshot(excludeArticleId: string, factIds: number[], db: Db = sql, selectedIds?: string[]) {
  const rows = await db<GroupingSelectionSnapshot[]>`SELECT p.article_id,p.source_id,a.revision AS material_revision,p.revision AS publication_revision,
    p.fact_id,p.title,p.summary,s.name AS source_name,p.first_party,p.published_at,p.discovered_at,p.timeline_at,p.body_mode,p.score
    FROM publications p JOIN articles a ON a.id=p.article_id JOIN sources s ON s.id=p.source_id
    WHERE p.article_id<>${excludeArticleId} AND p.visibility='public' AND ${originalPostAdmissionCondition()} AND p.eligible AND p.selected AND p.visible_after<=now()
      AND a.grouping_status='complete' AND a.grouping_input_revision=a.revision
      AND (${selectedIds ?? null}::text[] IS NULL OR p.article_id=ANY(${selectedIds ?? []}::text[]))
      AND (${selectedIds !== undefined} OR p.fact_id=ANY(${factIds}::bigint[]) OR (p.discovered_at>now()-interval '60 days' AND (p.fact_id IS NULL OR p.discovered_at<=now()-interval '14 days')))
    ORDER BY p.timeline_at DESC,p.article_id`;
  return attachRepresentativePriority(rows, db);
}

export function readConfirmedGroupingItems(ids: string[], db: Db = sql) {
  return readGroupingSelectionSnapshot("", [], db, ids);
}

/** Current public seats of the requested inputs; withdrawn or unreleased copies are never repair candidates. */
export async function selectedGroupingRecipeInputs(ids: string[], db: Db) {
  if (!ids.length) return [];
  const replacements = await admissionReplacementSeats(new Date(), db);
  return db<{ article_id: string; source_id: string; fact_id: number | null }[]>`SELECT article_id,source_id,fact_id FROM publications p
    WHERE p.article_id=ANY(${ids}::text[]) AND p.visibility='public' AND ${originalPostAdmissionCondition()} AND p.eligible AND ${confirmedSelected()} AND (p.seat OR p.article_id=ANY(${replacements}::text[])) AND p.visible_after<=now()
      AND NOT p.operator_withdrawn`;
}

/** Historical sync cursors carry only today's publishable selected seats and current corrections. */
export async function currentSyncItems(ids: string[], now: Date, db: Db = sql): Promise<ApiItemRow[]> {
  if (!ids.length) return [];
  const replacements = await admissionReplacementSeats(now, db);
  const rows = await db<ApiItemRow[]>`SELECT ${API_ITEM_COLUMNS()} ${API_ITEM_FROM()}
    WHERE p.article_id=ANY(${ids}::text[]) AND p.visibility='public' AND ${originalPostAdmissionCondition()} AND p.eligible AND ${confirmedSelected()} AND (p.seat OR p.article_id=ANY(${replacements}::text[]))
      AND p.visible_after<=${now} AND s.participation_mode='editorial' AND s.lane='news'`;
  return protectApiPostRows(rows, db, now.getTime());
}

/** Small source-time projection for story/report/group references, with no body reads or private date observations. */
export async function publicTimeMetadata(ids: string[], db: Db = sql) {
  if (!ids.length) return new Map<string, { sourceTime: ReturnType<typeof publicSourceTime>; publishedAt: string | null; firstPublicAt: string | null }>();
  const rows = await db<
    { id: string; source_time: unknown; first_public_at: Date | null }[]
  >`SELECT p.article_id AS id,${CURRENT_SOURCE_TIME()} AS source_time,p.first_public_at
    FROM publications p JOIN sources s ON s.id=p.source_id JOIN articles a ON a.id=p.article_id WHERE p.article_id=ANY(${ids}::text[])`;
  return new Map(
    rows.map((row) => [
      row.id,
      {
        sourceTime: publicSourceTime(row.source_time),
        publishedAt: sourceInstant(row.source_time)?.toISOString() ?? null,
        firstPublicAt: row.first_public_at?.toISOString() ?? null,
      },
    ]),
  );
}

/** Current material/configuration mismatches, newest first; an acknowledged unknown date is not retried forever. */
export async function pendingSourceTimeProjectionIds(limit: number) {
  const rows = await sql<
    { article_id: string }[]
  >`SELECT p.article_id FROM publications p JOIN articles a ON a.id=p.article_id JOIN sources s ON s.id=p.source_id
    WHERE s.lane='news' AND (p.source_time_material_revision IS DISTINCT FROM a.revision OR p.source_date_version IS DISTINCT FROM a.source_date_version OR p.source_date_config_hash IS DISTINCT FROM s.source_date_config_hash)
    ORDER BY p.timeline_at DESC,p.article_id LIMIT ${limit}`;
  return rows.map((row) => row.article_id);
}
