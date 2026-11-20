// Reading the event order (publication.event_rank) for the read side that comes later (design M, B4: timeline, hot board
// and daily issue behind a request parameter). Nothing calls these yet; no reader page or public API reads the table.
import { sql, type Db } from "../../db.ts";
import type { FreshnessBasis, FreshnessClass, Genre } from "./rules.ts";

export interface EventRankView {
  articleId: string;
  factId: number | null;
  storyId: number | null;
  reportedAt: Date;
  freshness: FreshnessClass;
  freshnessBasis: FreshnessBasis;
  occurredOn: string | null;
  anchorAt: Date | null;
  importance: number;
  genre: Genre;
  topic: string | null;
  decidedAt: Date;
}

/** The stored rows of these publications; a publication without a row is absent. */
export async function readEventRanks(ids: readonly string[], db: Db = sql): Promise<Map<string, EventRankView>> {
  if (!ids.length) return new Map();
  const rows = await db<
    {
      article_id: string;
      fact_id: number | null;
      story_id: number | null;
      reported_at: Date;
      freshness: FreshnessClass;
      freshness_basis: FreshnessBasis;
      occurred_on: string | null;
      anchor_at: Date | null;
      importance: number;
      genre: Genre;
      topic: string | null;
      decided_at: Date;
    }[]
  >`SELECT article_id,fact_id,story_id,reported_at,freshness,freshness_basis,occurred_on::text AS occurred_on,anchor_at,importance,genre,topic,decided_at
    FROM publication.event_rank WHERE article_id=ANY(${[...ids]}::text[])`;
  return new Map(
    rows.map((r) => [
      r.article_id,
      {
        articleId: r.article_id,
        factId: r.fact_id,
        storyId: r.story_id,
        reportedAt: r.reported_at,
        freshness: r.freshness,
        freshnessBasis: r.freshness_basis,
        occurredOn: r.occurred_on,
        anchorAt: r.anchor_at,
        importance: r.importance,
        genre: r.genre,
        topic: r.topic,
        decidedAt: r.decided_at,
      },
    ]),
  );
}

/**
 * For the hot board (rules.ts eventAwareHot): a story is fresh when one of its reports since `since` is not old news;
 * its latest such report then stands for it. A story with no row at all is absent: no evidence is not staleness.
 */
export async function storyFreshness(
  storyIds: readonly number[],
  since: Date,
  db: Db = sql,
): Promise<Map<number, { fresh: boolean; latestFreshArticleId: string | null }>> {
  if (!storyIds.length) return new Map();
  const rows = await db<{ story_id: number; latest: string | null }[]>`
    SELECT story_id,(array_agg(article_id ORDER BY reported_at DESC,article_id) FILTER (WHERE freshness<>'old' AND reported_at>=${since}))[1] AS latest
    FROM publication.event_rank WHERE story_id=ANY(${[...storyIds]}::bigint[]) GROUP BY story_id`;
  return new Map(rows.map((row) => [row.story_id, { fresh: row.latest !== null, latestFreshArticleId: row.latest }]));
}
