// English titles and summaries for public news published before the switch (TASK-0595, Owner 2026-11-08). New items
// are queued when they are published (while EN_COPY_ENABLED=true); this reaches the older ones, newest first, bounded
// and resumable, through the same queue, at the background priority and off-peak, and within the background share of
// the model quota (the worker judges both again when it takes each job). No model is called here.
//   node scripts/en-copy-backfill.ts                       dry run (default): counts and a token estimate, queues nothing
//   node scripts/en-copy-backfill.ts --apply --limit N [--before CURSOR]
//                                                          queues at most N items (hard cap), then prints the
//                                                          --before value to continue from
// Re-running is safe: items that already show an English copy drop out, queued ones are not queued twice (singleton
// key), and an input that already has a copy is only shown, not paid for again. --apply refuses to run while
// EN_COPY_ENABLED is not true (the worker would only drop the jobs).
import { closeDb, initializeDb } from "@amp/backend/db";
import { stopBoss } from "@amp/backend/jobs/queue";
import { englishCopyEnabled } from "@amp/backend/config";
import { enqueueJob } from "../packages/backend/src/jobs/module-queues.ts";
import { QUEUES } from "../packages/backend/src/jobs/queue.ts";
import { englishCopyBackfillPage } from "../packages/backend/src/publication/publish.ts";
import { englishCopyJobOptions, promptTokenEstimate } from "../packages/backend/src/editorial/translation-schedule.ts";
import { promptText } from "../packages/backend/src/editorial/prompts.ts";

/** Upper bounds of one answer: title (≤20 words) and summary (≤70 words) at ~1.3 tokens a word, plus the JSON. */
const OUTPUT_TOKENS = { titleAndSummary: 135, summaryOnly: 105 };
/** The chat envelope around the two messages. */
const ENVELOPE_TOKENS = 10;
const MAX_LIMIT = 20_000;

const args = process.argv.slice(2);
const value = (flag: string) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};
const apply = args.includes("--apply");
const limit = value("--limit") === undefined ? null : Number(value("--limit"));
const beforeArg = value("--before") ?? null;
const cursorMatch = beforeArg === null ? null : /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z),([a-zA-Z0-9_-]{1,128})$/.exec(beforeArg);
const unknown = args.filter((a, i) => !["--apply", "--limit", "--before"].includes(a) && !["--limit", "--before"].includes(args[i - 1] ?? ""));
if (
  unknown.length ||
  apply !== (limit !== null) ||
  (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)) ||
  (beforeArg !== null && (!cursorMatch || Number.isNaN(Date.parse(cursorMatch[1]!))))
) {
  console.error(`usage: en-copy-backfill.ts [--apply --limit 1-${MAX_LIMIT}] [--before <ISO time>,<id>]; nothing queued`);
  process.exit(2);
}
if (apply && !englishCopyEnabled()) {
  console.error("EN_COPY_ENABLED is not true: the worker would drop these jobs; nothing queued");
  process.exit(2);
}

await initializeDb("worker");
try {
  const systemTokens = promptTokenEstimate(promptText("english-copy"));
  let before = cursorMatch ? { at: new Date(cursorMatch[1]!), id: cursorMatch[2]! } : null;
  let due = 0,
    queued = 0,
    keepTitle = 0,
    input = 0,
    output = 0,
    oldest: Date | null = null,
    newest: Date | null = null,
    stopped = false;
  for (;;) {
    const page = await englishCopyBackfillPage(before, 500);
    for (const item of page.items) {
      if (apply && queued >= limit!) {
        stopped = true;
        break;
      }
      due++;
      newest ??= item.discoveredAt;
      oldest = item.discoveredAt;
      if (item.input.keepTitle) keepTitle++;
      input += systemTokens + promptTokenEstimate(JSON.stringify(item.input.message)) + ENVELOPE_TOKENS;
      output += item.input.keepTitle ? OUTPUT_TOKENS.summaryOnly : OUTPUT_TOKENS.titleAndSummary;
      if (apply) {
        const accepted = await enqueueJob(
          QUEUES.translate,
          { articleId: item.articleId, lane: "news", english: true },
          englishCopyJobOptions(item.articleId, false),
        );
        if (accepted === undefined) throw new Error("the queue gave no acceptance; stopped");
        if (accepted) queued++;
      }
      before = { at: item.discoveredAt, id: item.articleId };
    }
    if (stopped || !page.next) break;
    before = page.next;
  }
  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        itemsWithoutEnglishCopy: due,
        englishOriginalsKeepingTheirTitle: keepTitle,
        queued,
        discovered: { newest: newest?.toISOString() ?? null, oldest: oldest?.toISOString() ?? null },
        estimate: {
          systemPromptTokens: systemTokens,
          requests: due,
          inputTokens: input,
          cacheableInputTokens: Math.max(0, due - 1) * systemTokens,
          outputTokens: output,
        },
        next: stopped && before ? `--before ${before.at.toISOString()},${before.id}` : null,
      },
      null,
      2,
    ),
  );
} finally {
  await stopBoss();
  await closeDb();
}
