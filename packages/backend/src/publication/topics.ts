import { topicTextMatches } from "./read-predicates.ts";
import { attachSourcePolicies } from "./reader-context.ts";
import type { FeedItemSummary } from "@amp/contracts/site";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config.ts";
import { dbOf } from "../db.ts";
import { cached } from "../lib/cache.ts";
import { ITEM_COLUMNS, ITEM_FROM, listedCondition, toFeedItemSummary, type ItemRow } from "./items.ts";
import { matchesTopicTags, readMatcherValues } from "./mentions.ts";

const sql = dbOf("publication");

export interface TopicRow {
  slug: string;
  name: string;
  grp: "company" | "field" | "genre" | "project";
  entity_id: string | null;
  tags: string[];
  definition: string;
  related: string[];
  position: number;
}

/**
 * Topic pages list 全部矿业动态: every public eligible article whose tag or title/summary names the
 * country, mineral or company. The homepage 精选 filter stays 精选-only (Owner 2026-10-10).
 * `selected` remains in the type so older responses still parse; new counts are `all`.
 */
export type TopicBasis = "selected" | "all";
type TopicCount = { slug: string; total: number; recent: number; pages: number; indexable: boolean; latest: Date | null; basis: TopicBasis };
const topicsCache = cached(() => sql<TopicRow[]>`SELECT slug, name, grp, entity_id, tags, definition, related, position FROM topics ORDER BY position`, {
  freshMs: 60_000,
  maxStaleMs: 10 * 60_000,
});
// Counts may lag by about a minute, like the public directory cache; item reads always check visibility.
const countsCache = cached(queryTopicCounts, { freshMs: 60_000, maxStaleMs: 10 * 60_000 });

/**
 * The topics (stable slugs, names, definitions, related topics) come from the industry pack
 * (industry/topics.json); every environment seeds them from there. Re-runnable.
 */
export async function seedTopics(): Promise<number> {
  const data = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/topics.json"), "utf8")) as {
    topics: Array<{ slug: string; name: string; group: string; entityId?: string | null; tags: string[]; definition: string; related?: string[] }>;
  };
  let position = 0;
  for (const t of data.topics) {
    await sql`
      INSERT INTO topics (slug, name, grp, entity_id, tags, definition, related, position)
      VALUES (${t.slug}, ${t.name}, ${t.group}, ${t.entityId ?? null}, ${t.tags}, ${t.definition}, ${t.related ?? []}, ${position++})
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, grp = EXCLUDED.grp, entity_id = EXCLUDED.entity_id,
        tags = EXCLUDED.tags, definition = EXCLUDED.definition, related = EXCLUDED.related, position = EXCLUDED.position`;
  }
  topicsCache.clear();
  countsCache.clear();
  return data.topics.length;
}

export function listTopics(): Promise<TopicRow[]> {
  return topicsCache.get();
}

export async function loadTopic(slug: string): Promise<TopicRow | null> {
  return (await listTopics()).find((t) => t.slug === slug) ?? null;
}

/**
 * Tags that put an article in a topic. A company topic takes its entity subject tag.
 * Title and summary aliases are matched separately, so a display tag alone is not a company hit.
 */
export function topicMatchTags(t: Pick<TopicRow, "entity_id" | "tags">): string[] {
  return t.entity_id ? [`entity:${t.entity_id}`] : t.tags;
}

export async function loadTopicTags(slug: string): Promise<string[] | null> {
  const t = await loadTopic(slug);
  return t ? topicMatchTags(t) : null;
}

export const TOPIC_PAGE_SIZE = 20;

/** Topic pages exist for every topic; only topics with enough content are listed and indexed. */
export function topicPageCounts(): Promise<TopicCount[]> {
  return countsCache.get();
}

/**
 * One pass over 全部矿业动态. A topic counts an item when its tags overlap, or the title / summary
 * uses that country, mineral or company name (including aliases).
 */
async function queryTopicCounts(): Promise<TopicCount[]> {
  const now = new Date();
  const basis: TopicBasis = "all";
  const [topics, items] = await Promise.all([
    sql<Array<Pick<TopicRow, "slug" | "entity_id" | "tags">>>`SELECT slug, entity_id, tags FROM topics ORDER BY position`,
    sql<{ tags: string[]; timeline_at: Date; search_text: string }[]>`
      SELECT p.tags, p.timeline_at, coalesce(p.search_text, '') AS search_text
      FROM publications p WHERE ${listedCondition(now)} AND p.eligible`,
  ]);
  const recentFrom = Date.now() - 30 * 86400_000;
  return topics.map((t) => {
    const match = topicMatchTags(t);
    let total = 0;
    let recent = 0;
    let latest: Date | null = null;
    for (const it of items) {
      if (!matchesTopicTags(it.tags, it.search_text, match)) continue;
      total += 1;
      if (it.timeline_at.getTime() > recentFrom) recent += 1;
      if (!latest || it.timeline_at > latest) latest = it.timeline_at;
    }
    return {
      slug: t.slug,
      total,
      recent,
      latest,
      pages: Math.max(1, Math.ceil(total / TOPIC_PAGE_SIZE)),
      indexable: total >= 50 || (total >= 20 && recent > 0),
      basis,
    };
  });
}

export interface TopicSummary {
  slug: string;
  name: string;
  group: "company" | "field" | "genre" | "project";
  definition: string;
  total: number;
  recent: number;
  indexable: boolean;
  latestAt: string | null;
  basis: TopicBasis;
}

export async function listTopicSummaries(): Promise<TopicSummary[]> {
  const topics = await listTopics();
  const counts = new Map((await topicPageCounts()).map((c) => [c.slug, c]));
  return topics.map((t) => {
    const c = counts.get(t.slug);
    return {
      slug: t.slug,
      name: t.name,
      group: t.grp,
      definition: t.definition,
      total: c?.total ?? 0,
      recent: c?.recent ?? 0,
      indexable: c?.indexable ?? false,
      latestAt: c?.latest?.toISOString() ?? null,
      basis: c?.basis ?? "selected",
    };
  });
}

export interface TopicPage {
  topic: TopicSummary & { related: Array<{ slug: string; name: string }> };
  items: FeedItemSummary[];
  page: number;
  pageCount: number;
}

export async function loadTopicPage(slug: string, page: number, now = new Date()): Promise<TopicPage | null> {
  const row = await loadTopic(slug);
  if (!row || page < 1) return null;
  const topics = await listTopicSummaries();
  const topic = topics.find((t) => t.slug === slug);
  if (!topic) return null;
  const pageCount = Math.max(1, Math.ceil(topic.total / TOPIC_PAGE_SIZE));
  if (page < 1 || page > pageCount) return null;
  // Page ids from the set the counts follow first, then the joins for those rows only.
  const match = readMatcherValues(null, topicMatchTags(row), [], []);
  const offset = (page - 1) * TOPIC_PAGE_SIZE;
  const rows = await sql<ItemRow[]>`
    WITH page AS (
      SELECT p.article_id FROM publications p
      WHERE ${listedCondition(now)} AND p.eligible AND ${topicTextMatches(match)}
      ORDER BY p.timeline_at DESC, p.article_id DESC
      LIMIT ${TOPIC_PAGE_SIZE} OFFSET ${offset})
    SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE p.article_id IN (SELECT article_id FROM page)
    ORDER BY p.timeline_at DESC, p.article_id DESC`;
  const related = row.related
    .map((r) => topics.find((t) => t.slug === r))
    .filter((t): t is TopicSummary => !!t)
    .map((t) => ({ slug: t.slug, name: t.name }));
  await attachSourcePolicies(rows);
  return { topic: { ...topic, related }, items: rows.map(toFeedItemSummary), page, pageCount };
}
