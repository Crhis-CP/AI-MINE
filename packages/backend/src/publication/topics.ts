import type { FeedItemSummary } from "@amp/contracts/site";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config.ts";
import { dbOf } from "../db.ts";
import { cached } from "../lib/cache.ts";
import { ITEM_COLUMNS, ITEM_FROM, listedCondition, toFeedItemSummary, type ItemRow } from "./items.ts";

const sql = dbOf("publication");

export interface TopicRow {
  slug: string;
  name: string;
  grp: "company" | "field" | "genre";
  entity_id: string | null;
  tags: string[];
  definition: string;
  related: string[];
  position: number;
}

type TopicCount = { slug: string; total: number; recent: number; pages: number; indexable: boolean; latest: Date | null };
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
 * Tags that put an article in a topic. A company topic takes only articles actually about the company
 * (its entity subject tag), never mere mentions; field and genre topics match their tags.
 */
export function topicMatchTags(t: Pick<TopicRow, "entity_id" | "tags">): string[] {
  return t.entity_id ? [`entity:${t.entity_id}`] : t.tags;
}

export async function loadTopicTags(slug: string): Promise<string[] | null> {
  const t = await loadTopic(slug);
  return t ? topicMatchTags(t) : null;
}

export const TOPIC_PAGE_SIZE = 20;
/** Like 全部矿业动态, topic lists stop at 50 pages; older items are reached by search. */
export const TOPIC_MAX_PAGES = 50;

/** Topic pages exist for every topic; only topics with enough content are listed and indexed. */
export function topicPageCounts(): Promise<TopicCount[]> {
  return countsCache.get();
}

/**
 * One grouped query over the listed pool (what 全部矿业动态 shows): a topic counts an item when their tags
 * overlap (`p.tags && match`, served by the tags GIN index), and only about 60 rows come back. Topics follow
 * the whole pool, not only 精选 (PG-08 “近 30 天 N 条”): before the mining scoring standard is confirmed
 * there is no 精选 at all.
 */
async function queryTopicCounts(): Promise<TopicCount[]> {
  const now = new Date();
  const recentFrom = new Date(now.getTime() - 30 * 86400_000);
  const rows = await sql<{ slug: string; total: number; recent: number; latest: Date | null }[]>`
    SELECT t.slug, count(p.article_id)::int AS total,
      count(p.article_id) FILTER (WHERE p.timeline_at > ${recentFrom})::int AS recent,
      max(p.timeline_at) AS latest
    FROM topics t
    LEFT JOIN publications p ON ${listedCondition(now)} AND p.eligible
      AND p.tags && (CASE WHEN t.entity_id IS NOT NULL THEN ARRAY['entity:' || t.entity_id] ELSE t.tags END)
    GROUP BY t.slug, t.position
    ORDER BY t.position`;
  return rows.map((r) => ({
    slug: r.slug,
    total: r.total,
    recent: r.recent,
    latest: r.latest,
    pages: Math.min(TOPIC_MAX_PAGES, Math.max(1, Math.ceil(r.total / TOPIC_PAGE_SIZE))),
    indexable: r.total >= 50 || (r.total >= 20 && r.recent > 0),
  }));
}

export interface TopicSummary {
  slug: string;
  name: string;
  group: "company" | "field" | "genre";
  definition: string;
  total: number;
  recent: number;
  indexable: boolean;
  latestAt: string | null;
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
  const pageCount = Math.min(TOPIC_MAX_PAGES, Math.max(1, Math.ceil(topic.total / TOPIC_PAGE_SIZE)));
  if (page < 1 || page > pageCount) return null;
  // Page ids from the listed pool first, then the joins for those rows only.
  const rows = await sql<ItemRow[]>`
    WITH page AS (
      SELECT p.article_id FROM publications p
      WHERE ${listedCondition(now)} AND p.eligible AND p.tags && ${topicMatchTags(row)}::text[]
      ORDER BY p.timeline_at DESC, p.article_id DESC
      LIMIT ${TOPIC_PAGE_SIZE} OFFSET ${(page - 1) * TOPIC_PAGE_SIZE})
    SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE p.article_id IN (SELECT article_id FROM page)
    ORDER BY p.timeline_at DESC, p.article_id DESC`;
  const related = row.related
    .map((r) => topics.find((t) => t.slug === r))
    .filter((t): t is TopicSummary => !!t)
    .map((t) => ({ slug: t.slug, name: t.name }));
  return { topic: { ...topic, related }, items: rows.map(toFeedItemSummary), page, pageCount };
}
