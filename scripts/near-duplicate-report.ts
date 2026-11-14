// Near-duplicate reprints: how often a match lands in the same event (TASK-0661). Read-only: one read-only
// transaction, no model call, no write. Run it after the record has run for a while and paste the Markdown on the board:
//   node scripts/near-duplicate-report.ts [--days 14] [--cost 0.016]
// For each recorded match (an article and the closest earlier article from another source whose body SimHash is at most
// 3 bits away and whose title is alike) it checks whether grouping later put both into the same fact or the same story.
// Same event = precision; different events = would-be wrong merges. Saving = matches × the per-article analysis cost
// (default 0.016 元, the measured mean of prefilter, scores and writing per article). Nothing is skipped by this card.
import { parseArgs } from "node:util";
import { closeDb, initializeDb, sql } from "@amp/backend/db";

export interface MatchRow {
  fingerprinted: number;
  matched: number;
  sameFact: number;
  sameStory: number;
  differentEvent: number;
  notGrouped: number;
}

export async function collect(days: number): Promise<MatchRow> {
  return sql.begin(async (tx) => {
    await tx`SET TRANSACTION READ ONLY`;
    await tx`SET LOCAL statement_timeout = '120s'`;
    const [row] = await tx<MatchRow[]>`
      WITH recent AS (
        SELECT DISTINCT ON (article_id) article_id, match_article_id FROM enrichment.near_duplicates
        WHERE computed_at > pg_catalog.clock_timestamp() - make_interval(days => ${days}) ORDER BY article_id, input_revision DESC
      ), membership AS (
        -- Grouping that holds for the article's current revision, as publication reads it: a manual link, or an automatic
        -- one for this revision that is not waiting to be regrouped (events/group.ts trusted()).
        SELECT fa.article_id, fa.fact_id, f.story_id FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id JOIN articles a ON a.id = fa.article_id
        WHERE fa.role IN ('primary', 'report')
          AND (fa.manual OR (fa.input_revision = a.revision AND NOT EXISTS (SELECT 1 FROM regroup_pending rp WHERE rp.article_id = fa.article_id)))
      ), judged AS (
        SELECT r.article_id,
          EXISTS (SELECT 1 FROM membership a JOIN membership b ON a.fact_id = b.fact_id WHERE a.article_id = r.article_id AND b.article_id = r.match_article_id) AS same_fact,
          EXISTS (SELECT 1 FROM membership a JOIN membership b ON a.story_id = b.story_id WHERE a.story_id IS NOT NULL
            AND a.article_id = r.article_id AND b.article_id = r.match_article_id) AS same_story,
          EXISTS (SELECT 1 FROM membership WHERE article_id = r.article_id) AND EXISTS (SELECT 1 FROM membership WHERE article_id = r.match_article_id) AS both_grouped
        FROM recent r WHERE r.match_article_id IS NOT NULL
      )
      SELECT (SELECT count(*)::int FROM recent) AS fingerprinted,
        count(*)::int AS matched,
        count(*) FILTER (WHERE same_fact)::int AS "sameFact",
        count(*) FILTER (WHERE same_story AND NOT same_fact)::int AS "sameStory",
        count(*) FILTER (WHERE both_grouped AND NOT same_fact AND NOT same_story)::int AS "differentEvent",
        count(*) FILTER (WHERE NOT both_grouped)::int AS "notGrouped"
      FROM judged`;
    return row!;
  });
}

const percent = (part: number, whole: number) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : "—");

export function render(row: MatchRow, days: number, cost: number): string {
  const decided = row.sameFact + row.sameStory + row.differentEvent;
  return [
    `# 近乎相同的转载稿：最近 ${days} 天（TASK-0661，只记不跳过）`,
    "",
    "| 指标 | 数值 |",
    "| --- | --- |",
    `| 算了指纹的稿件（正文至少 200 字） | ${row.fingerprinted} |`,
    `| 认出是别家近乎相同的转载 | ${row.matched}（${percent(row.matched, row.fingerprinted)}） |`,
    `| 其中后来归到同一件事（同一事实） | ${row.sameFact} |`,
    `| 归到同一事件、不同进展 | ${row.sameStory} |`,
    `| 归到不同事件（误认） | ${row.differentEvent} |`,
    `| 还没归组，暂不能判断 | ${row.notGrouped} |`,
    `| 准确率（同一事实 ÷ 已能判断） | ${percent(row.sameFact, decided)} |`,
    `| 误认率（不同事件 ÷ 已能判断） | ${percent(row.differentEvent, decided)} |`,
    `| 如果跳过这些转载稿，约能省 | ${(row.matched * cost).toFixed(2)} 元（每篇按 ${cost} 元） |`,
    "",
    "只读统计，没有调用模型、没有写库。是否让认出的转载稿直接挂到原稿的事件下、不再单独分析，另开卡由 Owner 决定。",
  ].join("\n");
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { days: { type: "string", default: "14" }, cost: { type: "string", default: "0.016" } } });
  const days = Number(values.days),
    cost = Number(values.cost);
  if (!Number.isInteger(days) || days < 1 || days > 90 || !(cost >= 0)) throw new Error("Usage: near-duplicate-report.ts [--days 1-90] [--cost 元]");
  await initializeDb("worker");
  try {
    console.log(render(await collect(days), days, cost));
  } finally {
    await closeDb();
  }
}
