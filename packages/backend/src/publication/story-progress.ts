// Where a feed card's development sits in its story ("事件进展 · 第 2 次 · 上次：…"). Developments are the
// story's facts with a currently public report, ordered by first report, as on the story page.
import type { StoryProgress } from "@amp/contracts/site";
import { sql, type Db } from "../db.ts";
import { originalPostAdmissionCondition } from "./items.ts";
import { readHistoricalBackground } from "./historical-background.ts";
import { originalPostAffectedStories } from "./stories.ts";

export interface ProgressCard {
  id: string;
  fact_id: number | null;
  story_id: number | null;
  story_public_id: string | null;
  story_title: string | null;
}

export async function loadStoryProgress(cards: ProgressCard[], now: Date, db: Db = sql): Promise<Map<string, StoryProgress>> {
  const out = new Map<string, StoryProgress>();
  const linked = cards.filter((c) => c.fact_id !== null && c.story_id !== null && c.story_public_id);
  if (!linked.length) return out;
  const storyIds = [...new Set(linked.map((c) => c.story_id!))];
  const facts = await db<{ story_id: number; fact_id: number; title: string; first_at: Date }[]>`
    SELECT f.story_id, f.id AS fact_id, f.title, min(coalesce(p.published_at, p.discovered_at)) AS first_at
    FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
    JOIN sources s ON s.id = p.source_id
    WHERE f.story_id = ANY(${storyIds}::bigint[]) AND p.visibility = 'public' AND ${originalPostAdmissionCondition()}
      AND s.participation_mode = 'editorial' AND (NOT p.selected OR p.visible_after <= ${now})
    GROUP BY f.story_id, f.id, f.title`;
  const withBackground = new Set(
    (
      await db<{ story_public_id: string }[]>`SELECT DISTINCT story_public_id::text FROM publication.story_background_refs
        WHERE lane = 'news' AND story_public_id = ANY(${[...new Set(linked.map((c) => c.story_public_id!))]}::uuid[])`
    ).map((r) => r.story_public_id),
  );
  // Fact titles of stories whose original-post grants changed may describe material no longer shown: stay quiet.
  const affected = await originalPostAffectedStories(storyIds, db);
  const background = new Map<string, number>();
  for (const publicId of withBackground) background.set(publicId, (await readHistoricalBackground(publicId, db)).length);
  for (const card of linked) {
    if (affected.has(card.story_id!)) continue;
    const line = facts.filter((f) => f.story_id === card.story_id).sort((a, b) => a.first_at.getTime() - b.first_at.getTime() || a.fact_id - b.fact_id);
    const index = line.findIndex((f) => f.fact_id === card.fact_id);
    const backgroundCount = background.get(card.story_public_id!) ?? 0;
    if (index < 0 || (line.length <= 1 && backgroundCount === 0)) continue;
    const point = (f: (typeof line)[number] | undefined) => (f ? { title: f.title, at: f.first_at.toISOString() } : null);
    out.set(card.id, {
      story: { publicId: card.story_public_id!, title: card.story_title ?? "" },
      developmentCount: line.length,
      position: index + 1,
      previous: point(line[index - 1]),
      latest: index === line.length - 1 ? null : point(line.at(-1)),
      backgroundCount,
    });
  }
  return out;
}
