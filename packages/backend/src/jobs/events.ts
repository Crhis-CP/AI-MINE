import type { JobData } from "@amp/contracts/jobs";
import { ModelPostReceiptGuardError } from "../providers/llm.ts";
import { computeHotRanking } from "../events/hot.ts";
import { isModelRouteWaiting } from "../providers/model-fallback.ts";
import { ReceiptBusyError, ReceiptUnknownError, BudgetExceededError } from "../providers/receipts.ts";
// Event jobs: serial grouping, debounced digests.
import type { PgBoss } from "pg-boss";
import { groupArticle, GroupingSupersededError, consolidate, resumeSignalRematch, EVENT_CONTINUATIONS, EVENT_CONTINUATION_OPTIONS } from "../events/group.ts";
import { composeStoryDigest } from "../events/digest.ts";
import { RuntimeControlPaused, RuntimeControlStale } from "../operations/lane-controls.ts";
import { settleNonEditorial, articleJobLane } from "./content.ts";
import { ensureQueue, QUEUES } from "./queue.ts";
import { enqueueJob as enqueue, work } from "./module-queues.ts";

const isWaiting = (error: unknown) =>
  error instanceof GroupingSupersededError ||
  error instanceof ModelPostReceiptGuardError ||
  error instanceof RuntimeControlPaused ||
  error instanceof RuntimeControlStale ||
  isModelRouteWaiting(error) ||
  error instanceof ReceiptBusyError ||
  error instanceof ReceiptUnknownError ||
  error instanceof BudgetExceededError;
export async function registerEventJobs(boss: PgBoss) {
  await ensureQueue("events.hot-refresh");
  await work(
    boss,
    "events.hot-refresh",
    { localConcurrency: 1, pollingIntervalSeconds: 2 },
    async () => "news" as const,
    async () => {
      try {
        return await computeHotRanking();
      } catch (error) {
        if (!(error instanceof RuntimeControlPaused || error instanceof RuntimeControlStale)) throw error;
        await enqueue("events.hot-refresh", { lane: "news" }, { singletonKey: "control:hot-ranking", startAfter: 60, singletonSeconds: 60 });
        return { state: "waiting", reason: "runtime_control" };
      }
    },
  );
  await ensureQueue(QUEUES.group);
  // Serial on purpose: two reports of the same new fact must not both create it.
  await work(boss, QUEUES.group, { localConcurrency: 1, pollingIntervalSeconds: 0.5 }, articleJobLane, async (data) => {
    try {
      // A discussion post comes here straight from collection: record it first (settleNonEditorial).
      if (data.signalOnly && !data.force && !(await settleNonEditorial(data.articleId)).group) return { verdict: "skipped" };
      const result = await groupArticle(data.articleId, { signalOnly: data.signalOnly, force: data.force });
      if (result.storyId && !result.verdict.startsWith("signal")) {
        await enqueue(QUEUES.digest, { lane: "news", storyId: result.storyId }, { singletonKey: `story:${result.storyId}`, startAfter: 60 });
      }
      return result;
    } catch (error) {
      if (error instanceof ReceiptUnknownError) return { state: "waiting", reason: "receipt", receiptId: error.receiptId };
      if (isWaiting(error)) {
        await enqueue(
          QUEUES.group,
          { ...data, lane: "news" },
          {
            singletonKey: `control:${data.articleId}:${!!data.signalOnly}:${!!data.force}`,
            startAfter: 60,
          },
        );
        return { state: "waiting", reason: isModelRouteWaiting(error) ? "model_route" : "runtime_control" };
      }
      throw error;
    }
  });
  await ensureQueue(QUEUES.digest);
  await work(
    boss,
    QUEUES.digest,
    { localConcurrency: 3, pollingIntervalSeconds: 5 },
    async () => "news" as const,
    async (data) => {
      try {
        return await composeStoryDigest(data.storyId, { afterCorrection: data.afterCorrection });
      } catch (error) {
        if (isWaiting(error)) {
          await enqueue(
            QUEUES.digest,
            { ...data, lane: "news" },
            {
              singletonKey: `control:${data.storyId}:${!!data.afterCorrection}`,
              startAfter: 60,
            },
          );
          return { state: "waiting", reason: isModelRouteWaiting(error) ? "model_route" : "runtime_control" };
        }
        throw error;
      }
    },
  );
  const continuation = async <Q extends (typeof EVENT_CONTINUATIONS)[keyof typeof EVENT_CONTINUATIONS]>(
    queue: Q,
    key: (data: JobData[Q]) => string,
    run: (data: JobData[Q]) => Promise<unknown>,
  ) => {
    await ensureQueue(queue, EVENT_CONTINUATION_OPTIONS);
    await work(
      boss,
      queue,
      { localConcurrency: 1, pollingIntervalSeconds: 5 },
      async (data) => {
        if (queue !== EVENT_CONTINUATIONS.rematch) return "news";
        const articleId = (data as { articleId?: unknown }).articleId;
        if (typeof articleId !== "string") throw new Error("Invalid event continuation material");
        return articleJobLane({ articleId });
      },
      async (data) => {
        try {
          return await run(data);
        } catch (error) {
          if (!isWaiting(error)) throw error;
          await enqueue(queue, data, { singletonKey: key(data), startAfter: 60 });
          return { state: "waiting", reason: isModelRouteWaiting(error) ? "model_route" : "runtime_control" };
        }
      },
    );
  };
  await continuation(
    EVENT_CONTINUATIONS.consolidate,
    (data) => [...data.storyIds].sort((a, b) => a - b).join(":"),
    (data) => consolidate(data.storyIds),
  );
  await continuation(
    EVENT_CONTINUATIONS.rematch,
    (data) => data.articleId,
    (data) => resumeSignalRematch(data.articleId),
  );
}
