// Full-text translation backfill for recent public news (TASK-0569, Owner 2026-11-07, DEC-78补充·新闻原文全文与中文译文).
// The live pipeline translates selected items at once and other public items while they are fresh; this reaches the
// rest of a recent window, bounded and resumable, through the same queue at the lower priority and off-peak.
//   node scripts/translate-backfill.ts [--days 30]                         dry run (default): counts and the token
//                                                                         estimate, queues nothing, calls no model
//   node scripts/translate-backfill.ts --apply --limit N [--days 30] [--after ID]
//                                                                         queues at most N items, then prints the
//                                                                         --after value to continue from
// Re-running from the start is safe: items already translated drop out, queued ones are not queued twice (singleton
// key), and the worker rechecks permission, withdrawal and the current revision before every paid request.
import { closeDb, initializeDb } from "@amp/backend/db";
import { stopBoss } from "@amp/backend/jobs/queue";
import { translatePending } from "@amp/backend/editorial/translate";
import { BACKFILL_TRANSLATION_MAX_DAYS, promptTokenEstimate } from "../packages/backend/src/editorial/translation-schedule.ts";
import { promptText } from "../packages/backend/src/editorial/prompts.ts";

const args = process.argv.slice(2);
const value = (flag: string) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};
const known = new Set(["--apply", "--days", "--limit", "--after"]);
const apply = args.includes("--apply");
const days = Number(value("--days") ?? 30);
const limit = value("--limit") === undefined ? null : Number(value("--limit"));
const after = value("--after") ?? null;
const unknown = args.filter((a, i) => !known.has(a) && !["--days", "--limit", "--after"].includes(args[i - 1] ?? ""));
if (
  unknown.length ||
  !Number.isInteger(days) ||
  days < 1 ||
  days > BACKFILL_TRANSLATION_MAX_DAYS ||
  apply !== (limit !== null) ||
  (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 100_000)) ||
  (after !== null && !/^[a-zA-Z0-9_-]{1,128}$/.test(after))
) {
  console.error(`usage: translate-backfill.ts [--days 1-${BACKFILL_TRANSLATION_MAX_DAYS}] [--apply --limit N] [--after ID]; nothing queued`);
  process.exit(2);
}

await initializeDb("worker");
try {
  const systemTokens = promptTokenEstimate(promptText("translate-body"));
  let cursor: string | null = after,
    due = 0,
    enqueued = 0,
    htmlChars = 0,
    calls = 0,
    input = 0,
    output = 0,
    cached = 0;
  for (;;) {
    const page = Math.min(1000, apply ? limit! - enqueued : 1000);
    if (page < 1) break;
    const result = await translatePending({
      limit: page,
      backfillDays: days,
      afterId: cursor,
      enqueue: apply,
      budgetMs: 10 * 60_000,
      estimateSystemTokens: systemTokens,
    });
    due += result.due;
    enqueued += result.enqueued;
    for (const chars of result.dueHtmlChars) htmlChars += chars;
    calls += result.estimate.calls;
    input += result.estimate.input;
    output += result.estimate.output;
    cached += result.estimate.cachedPrefix;
    cursor = result.cursor.afterId;
    if (result.done || cursor === null || result.scanned === 0) break;
  }
  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        days,
        itemsNeedingTranslation: due,
        queued: enqueued,
        bodyHtmlChars: htmlChars,
        estimate: { systemPromptTokens: systemTokens, requests: calls, inputTokens: input, cacheableInputTokens: cached, outputTokens: output },
        next: cursor ? `--after ${cursor}` : null,
      },
      null,
      2,
    ),
  );
} finally {
  await stopBoss();
  await closeDb();
}
