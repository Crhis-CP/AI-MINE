import { BATCH_PROMPT_VERSION } from "./relate.ts";
import { recentGroupingCandidateIds } from "../publication/groups.ts";
import { groupingQueuePriority } from "../jobs/content.ts";
import { sql } from "../db.ts";
import { claimPendingGrouping, failedGroupingRecipeInputs, resumeGroupingRecipeFailure } from "../content/grouping.ts";
import { activeNewsSourceIds } from "../admin/sources.ts";
import { receiptWaitingForRecovery, changedGroupingRecipeReceipts } from "../providers/receipts.ts";
import { requireRuntimeRunning, RuntimeControlPaused } from "../operations/lane-controls.ts";
import { ensureQueue, QUEUES } from "../jobs/queue.ts";
import { enqueueJob as enqueue, activeGroupingArticleIds } from "../jobs/module-queues.ts";

/** Persistent continuation for legacy and interrupted grouping. Existing scores and receipts stay intact. */
export async function recoverPendingGroupings(limit = 50) {
  await ensureQueue(QUEUES.group);
  try {
    return await sql.begin(async (tx) => {
      await requireRuntimeRunning("news", ["processing", "publication"], tx);
      const sources = await activeNewsSourceIds(tx, "editorial");
      const signals = await activeNewsSourceIds(tx, "hot_signal");
      const queued = await activeGroupingArticleIds(tx);
      const failed = await failedGroupingRecipeInputs(sources, queued, tx);
      const changed = await changedGroupingRecipeReceipts(
        failed.map((row) => ({ receiptId: row.receipt_id, subject: `article:${row.id}@${row.revision}` })),
        BATCH_PROMPT_VERSION,
        limit,
        tx,
      );
      for (const row of failed) if (changed.get(row.receipt_id) === `article:${row.id}@${row.revision}`) await resumeGroupingRecipeFailure(row, tx);
      const rows = await claimPendingGrouping(sources, limit, tx, queued, signals, await recentGroupingCandidateIds(sources, tx));
      let enqueued = 0,
        waiting = 0;
      for (const row of rows) {
        if (row.grouping_receipt_id !== null && (await receiptWaitingForRecovery(Number(row.grouping_receipt_id), tx))) {
          waiting++;
          continue;
        }
        if (
          await enqueue(
            QUEUES.group,
            { lane: "news", articleId: row.id, ...(row.signal_only ? { signalOnly: true } : {}) },
            { singletonKey: row.id, priority: await groupingQueuePriority(row.id, tx) },
            tx,
          )
        )
          enqueued++;
      }
      return { examined: rows.length, enqueued, waiting, paused: false };
    });
  } catch (error) {
    if (!(error instanceof RuntimeControlPaused)) throw error;
    return { examined: 0, enqueued: 0, waiting: 0, paused: true };
  }
}
