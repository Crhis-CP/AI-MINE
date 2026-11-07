// One-off backfill for TASK-0575 (Owner 2026-11-07): sweep the stories of about the last 30 days once for one event
// that was split into several stories, and attach report groups to their story.
//
//   node --env-file=.env scripts/story-merge-backfill.ts               dry run: candidate pairs, calls and an estimated cost; no model call, no write
//   node --env-file=.env scripts/story-merge-backfill.ts --apply       judges the pending pairs in rounds of 20 and merges where both models agree
//   options: --days 30 (stories with a report in the last N days)
//
// The hourly stories.merge job does the same work 20 pairs at a time; this only gets the backlog done in one go.
// Every answer is stored (events.story_merge_decisions), so --apply can be stopped and run again: judged pairs are
// not bought twice. Peak hours, a paused news lane or a waiting model route stop a round; run it again later.
import { parseArgs } from "node:util";
import { closeDb, initializeDb, sql } from "@amp/backend/db";
import { applyStoryMergeBackfill, attachReportGroupsToStories, planStoryMergeBackfill, BACKFILL_DAYS } from "@amp/backend/events/group";

const { values } = parseArgs({ options: { apply: { type: "boolean", default: false }, days: { type: "string" } }, strict: true });
const days = values.days ? Number(values.days) : BACKFILL_DAYS;
if (!Number.isInteger(days) || days < 1 || days > 90) {
  console.error("--days must be a whole number from 1 to 90; nothing written");
  process.exit(2);
}
await initializeDb("worker");
try {
  const plan = await planStoryMergeBackfill({ days });
  // The average recorded cost of the two story judgements over the last 30 days (none recorded: no estimate).
  const [price] = await sql<{ per_call: string | null; currency: string | null; calls: number }[]>`
    SELECT avg(cost)::text AS per_call, max(currency) AS currency, count(*)::int AS calls FROM receipts
    WHERE purpose IN ('group_story','group_story_review') AND cost IS NOT NULL AND created_at>now()-interval '30 days'`;
  const perCall = price?.per_call === null || price?.per_call === undefined ? null : Number(price.per_call);
  const estimate =
    perCall === null
      ? "无近 30 天的事件判断计费记录，无法估算"
      : `${(perCall * plan.calls.min).toFixed(2)}–${(perCall * plan.calls.max).toFixed(2)} ${price?.currency ?? ""}（按近 30 天 ${price?.calls} 次事件判断的平均单价 ${perCall.toFixed(5)}）`;
  console.log(JSON.stringify({ mode: values.apply ? "apply" : "dry-run", ...plan, estimatedCost: estimate }, null, 2));
  if (!values.apply) {
    console.log("Dry run: no model call, nothing written. Re-run with --apply to judge and merge.");
  } else {
    const totals = await applyStoryMergeBackfill({
      days,
      onRound: (round) =>
        console.log(
          JSON.stringify({ judged: round.judged, merged: round.merged.length, different: round.different, skipped: round.skipped, stopped: round.stopped ?? null }),
        ),
    });
    const groups = await attachReportGroupsToStories();
    console.log(JSON.stringify({ totals, reportGroups: groups }, null, 2));
    if (totals.stopped) console.log(`Stopped early (${totals.stopped}); run --apply again later to resume.`);
  }
} finally {
  await closeDb();
}
