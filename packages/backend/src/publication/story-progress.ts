// Where a feed card's development sits in its story ("事件进展 · 第 2 次（共 3 次） · 上次：…"). The story's line
// is the one its page shows (storyLine): the same listed reports, copies of one report folded, the same order.
import type { StoryProgress } from "@amp/contracts/site";
import { sql, type Db } from "../db.ts";
import { readHistoricalBackground } from "./historical-background.ts";
import { developmentTitle, originalPostAffectedStories, readStoryReportLines, storyLine } from "./stories.ts";
import { storiesWithdrawalAffected } from "./withdrawals.ts";

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
  const reports = await readStoryReportLines(storyIds, now, db);
  const withBackground = new Set(
    (
      await db<{ story_public_id: string }[]>`SELECT DISTINCT story_public_id::text FROM publication.story_background_refs
        WHERE lane = 'news' AND story_public_id = ANY(${[...new Set(linked.map((c) => c.story_public_id!))]}::uuid[])`
    ).map((r) => r.story_public_id),
  );
  // Fact titles of stories whose original-post grants changed may describe material no longer shown: stay quiet.
  const affected = await originalPostAffectedStories(storyIds, db);
  // A withdrawn report may have named its fact: those stories' developments are named after public reports.
  const withdrawn = await storiesWithdrawalAffected(storyIds, db);
  const background = new Map<string, number>();
  for (const publicId of withBackground) background.set(publicId, (await readHistoricalBackground(publicId, db)).length);
  const lines = new Map(
    storyIds.map((id) => {
      const rows = reports.filter((r) => r.story_id === id);
      const titles = new Map(rows.map((r) => [r.fact_id, r.fact_title]));
      return [id, { ...storyLine(rows), titles }] as const;
    }),
  );
  for (const card of linked) {
    if (affected.has(card.story_id!)) continue;
    const { developments, developmentOf, developmentOfFact, titles } = lines.get(card.story_id!)!;
    // The card's own report places it; a card whose report is not listed falls back to its fact.
    const index = developmentOf.get(card.id) ?? developmentOfFact.get(card.fact_id!) ?? -1;
    const backgroundCount = background.get(card.story_public_id!) ?? 0;
    if (index < 0 || (developments.length <= 1 && backgroundCount === 0)) continue;
    const guarded = withdrawn.has(card.story_id!);
    const point = (d: (typeof developments)[number] | undefined) =>
      d ? { title: developmentTitle(titles.get(d.factId) ?? "", d.members, guarded), at: d.first.toISOString() } : null;
    out.set(card.id, {
      story: { publicId: card.story_public_id!, title: card.story_title ?? "" },
      developmentCount: developments.length,
      position: index + 1,
      previous: point(developments[index - 1]),
      latest: index === developments.length - 1 ? null : point(developments.at(-1)),
      backgroundCount,
    });
  }
  return out;
}
