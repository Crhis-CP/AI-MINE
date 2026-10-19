import { BATCH_PROMPT_VERSION } from "./relate.ts";
import { recentGroupingCandidateIds } from "../publication/groups.ts";
import { selectedGroupingRecipeInputs, publishArticleTx, articleWithdrawalHeld } from "../publication/publish.ts";
import { groupingQueuePriority } from "../jobs/content.ts";
import { selectedGroupingAnalysisInputs } from "../enrichment/records.ts";
import { sql, type Tx } from "../db.ts";
import {
  claimPendingGrouping,
  failedGroupingRecipeInputs,
  resumeGroupingRecipeFailure,
  completedGroupingRecipeInputs,
  resumeCompletedGroupingRecipe,
} from "../content/grouping.ts";
import { activeNewsSourceIds } from "../admin/sources.ts";
import { receiptWaitingForRecovery, changedGroupingRecipeReceipts, completedGroupingRecipeReceipts } from "../providers/receipts.ts";
import { requireRuntimeRunning, RuntimeControlPaused } from "../operations/lane-controls.ts";
import { ensureQueue, QUEUES } from "../jobs/queue.ts";
import { enqueueJob as enqueue, activeGroupingArticleIds } from "../jobs/module-queues.ts";

/** Revisit a few old story splits or unjudged archive seats; the formal consumer still decides their identity/value. */
async function recoverCompletedSelections(sourceIds: string[], queuedIds: string[], limit: number, tx: Tx) {
  const completed = await completedGroupingRecipeInputs(sourceIds, queuedIds, tx);
  const seats = new Map(
    (
      await selectedGroupingRecipeInputs(
        completed.map((row) => row.id),
        tx,
      )
    ).map((row) => [row.article_id, row]),
  );
  const inputs = completed.filter((row) => seats.get(row.id)?.source_id === row.source_id);
  const receipts = await completedGroupingRecipeReceipts(
    inputs.flatMap((row) => (!row.historical && row.receipt_id ? [{ receiptId: row.receipt_id, subject: `article:${row.id}@${row.revision}` }] : [])),
    BATCH_PROMPT_VERSION,
    tx,
  );
  const nominations = new Set(
    (
      await selectedGroupingAnalysisInputs(
        inputs.filter((row) => row.historical).map((row) => row.id),
        tx,
      )
    ).map((row) => `${row.article_id}@${row.input_revision}`),
  );
  const splits = inputs.filter((row) => !row.historical && row.receipt_id && receipts.has(row.receipt_id)).map((row) => row.id);
  const archives = inputs.filter((row) => row.historical && nominations.has(`${row.id}@${row.revision}`)).map((row) => row.id);
  if (!splits.length && !archives.length) return { examined: 0, resumed: [] as string[], enqueued: 0 };
  const decisions = await tx<
    {
      id: string;
      revision: number;
      receipt_id: string | null;
      fact_id: number | null;
      fact_public_id: string | null;
      story_public_id: string | null;
    }[]
  >`
    SELECT d.article_id AS id,d.input_revision AS revision,d.receipt_id::text,d.fact_id,
      f.public_id AS fact_public_id,st.public_id::text AS story_public_id
    FROM grouping_decisions d
    LEFT JOIN facts f ON f.id=d.fact_id LEFT JOIN stories st ON st.id=f.story_id AND st.merged_into IS NULL
    WHERE ((d.article_id=ANY(${splits}::text[]) AND d.verdict='new-fact-in-story' AND d.story_id=st.id
        AND d.candidates @> '[{"relation":"SAME_STORY"}]'::jsonb AND NOT f.manual AND st.origin<>'manual'
        AND EXISTS(SELECT 1 FROM fact_articles fa WHERE fa.article_id=d.article_id AND fa.fact_id=f.id AND fa.role IN ('primary','report') AND fa.input_revision=d.input_revision))
      OR (d.article_id=ANY(${archives}::text[]) AND d.verdict='historical' AND d.receipt_id IS NULL AND d.fact_id IS NULL AND d.story_id IS NULL
        AND d.input_manifest->>'recipe' IS DISTINCT FROM ${BATCH_PROMPT_VERSION}))
      AND NOT EXISTS(SELECT 1 FROM fact_articles fa WHERE fa.article_id=d.article_id AND fa.manual)
      AND NOT EXISTS(SELECT 1 FROM grouping_overrides o WHERE o.article_id=d.article_id)
      AND NOT EXISTS(SELECT 1 FROM regroup_pending rp WHERE rp.article_id=d.article_id)
      AND NOT EXISTS(SELECT 1 FROM grouping_decisions newer WHERE newer.article_id=d.article_id AND newer.id>d.id)
    ORDER BY d.id`;
  const materials = new Map(inputs.map((row) => [row.id, row]));
  // Cap only after every owned read agrees; an obsolete early decision cannot starve the eligible seats behind it.
  const rows = decisions
    .filter((row) => {
      const input = materials.get(row.id);
      return input?.revision === row.revision && input.receipt_id === row.receipt_id && seats.get(row.id)?.fact_id === row.fact_id;
    })
    .slice(0, Math.min(5, limit));
  const resumed: string[] = [];
  let enqueued = 0;
  for (const row of rows) {
    if (await articleWithdrawalHeld(tx, row.id, row.fact_public_id, row.story_public_id)) {
      await publishArticleTx(tx, row.id);
      continue;
    }
    if (!(await resumeCompletedGroupingRecipe(row, tx))) continue;
    await tx`INSERT INTO regroup_pending(article_id) VALUES(${row.id}) ON CONFLICT DO NOTHING`;
    await publishArticleTx(tx, row.id);
    resumed.push(row.id);
    if (await enqueue(QUEUES.group, { lane: "news", articleId: row.id }, { singletonKey: row.id, priority: await groupingQueuePriority(row.id, tx) }, tx))
      enqueued++;
  }
  return { examined: rows.length, resumed, enqueued };
}

/** Persistent continuation for legacy and interrupted grouping. Existing scores and receipts stay intact. */
export async function recoverPendingGroupings(limit = 50) {
  await ensureQueue(QUEUES.group);
  const size = Math.max(1, Math.min(limit, 100));
  try {
    return await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('withdrawal-membership'))`;
      await requireRuntimeRunning("news", ["processing", "publication"], tx);
      const sources = await activeNewsSourceIds(tx, "editorial");
      const signals = await activeNewsSourceIds(tx, "hot_signal");
      const queued = await activeGroupingArticleIds(tx);
      const failed = await failedGroupingRecipeInputs(sources, queued, tx);
      const changed = await changedGroupingRecipeReceipts(
        failed.map((row) => ({ receiptId: row.receipt_id, subject: `article:${row.id}@${row.revision}` })),
        BATCH_PROMPT_VERSION,
        size,
        tx,
      );
      for (const row of failed) if (changed.get(row.receipt_id) === `article:${row.id}@${row.revision}`) await resumeGroupingRecipeFailure(row, tx);
      const splits = await recoverCompletedSelections(sources, queued, size, tx);
      const rows =
        splits.resumed.length < size
          ? await claimPendingGrouping(
              sources,
              size - splits.resumed.length,
              tx,
              [...queued, ...splits.resumed],
              signals,
              await recentGroupingCandidateIds(sources, tx),
            )
          : [];
      let enqueued = splits.enqueued,
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
      return { examined: rows.length + splits.examined, enqueued, waiting, paused: false };
    });
  } catch (error) {
    if (!(error instanceof RuntimeControlPaused)) throw error;
    return { examined: 0, enqueued: 0, waiting: 0, paused: true };
  }
}
