import { sql } from "../db.ts";
import { claimPendingGrouping } from "../content/grouping.ts";
import { activeNewsSourceIds } from "../admin/sources.ts";
import { receiptWaitingForRecovery } from "../providers/receipts.ts";
import { requireRuntimeRunning, RuntimeControlPaused } from "../operations/lane-controls.ts";
import { ensureQueue, enqueue, QUEUES } from "../jobs/queue.ts";

/** Persistent continuation for legacy and interrupted grouping. Existing scores and receipts stay intact. */
export async function recoverPendingGroupings(limit = 50) {
  await ensureQueue(QUEUES.group);
  try {
    return await sql.begin(async (tx) => {
      await requireRuntimeRunning("news", ["processing", "publication"], tx);
      const sources = await activeNewsSourceIds(tx);
      const rows = await claimPendingGrouping(sources, limit, tx);
      let enqueued = 0,
        waiting = 0;
      for (const row of rows) {
        if (row.grouping_receipt_id !== null && (await receiptWaitingForRecovery(Number(row.grouping_receipt_id), tx))) {
          waiting++;
          continue;
        }
        if (await enqueue(QUEUES.group, { articleId: row.id }, { singletonKey: row.id }, tx)) enqueued++;
      }
      return { examined: rows.length, enqueued, waiting, paused: false };
    });
  } catch (error) {
    if (!(error instanceof RuntimeControlPaused)) throw error;
    return { examined: 0, enqueued: 0, waiting: 0, paused: true };
  }
}
