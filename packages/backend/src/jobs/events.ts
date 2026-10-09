// Event jobs: serial grouping, debounced digests.
import type { PgBoss } from "pg-boss";
import { groupArticle, consolidate, resumeSignalRematch, EVENT_CONTINUATIONS, EVENT_CONTINUATION_OPTIONS } from "../events/group.ts";
import { composeStoryDigest } from "../events/digest.ts";
import { RuntimeControlPaused, RuntimeControlStale } from "../operations/lane-controls.ts";
import { settleNonEditorial } from "./content.ts";
import { ensureQueue, enqueue, QUEUES } from "./queue.ts";

export async function registerEventJobs(boss: PgBoss) {
  await ensureQueue(QUEUES.group);
  // Serial on purpose: two reports of the same new fact must not both create it.
  await boss.work<{ articleId: string; signalOnly?: boolean; force?: boolean }>(
    QUEUES.group,
    { localConcurrency: 1, pollingIntervalSeconds: 0.5 },
    async ([job]) => {
      if (!job) return;
      try {
        // A discussion post comes here straight from collection: record it first (settleNonEditorial).
        if (job.data.signalOnly && !job.data.force && !(await settleNonEditorial(job.data.articleId)).group) return { verdict: "skipped" };
        const result = await groupArticle(job.data.articleId, { signalOnly: job.data.signalOnly, force: job.data.force });
        if (result.storyId && !result.verdict.startsWith("signal")) {
          await enqueue(QUEUES.digest, { storyId: result.storyId }, { singletonKey: `story:${result.storyId}`, startAfter: 60 });
        }
        return result;
      } catch (error) {
        if (error instanceof RuntimeControlPaused || error instanceof RuntimeControlStale) {
          await enqueue(QUEUES.group, job.data, {
            singletonKey: `control:${job.data.articleId}:${!!job.data.signalOnly}:${!!job.data.force}`,
            startAfter: 60,
          });
          return { state: "waiting", reason: "runtime_control" };
        }
        throw error;
      }
    },
  );
  await ensureQueue(QUEUES.digest);
  await boss.work<{ storyId: number; afterCorrection?: boolean }>(QUEUES.digest, { localConcurrency: 3, pollingIntervalSeconds: 5 }, async ([job]) => {
    if (!job) return;
    try {
      return await composeStoryDigest(job.data.storyId, { afterCorrection: job.data.afterCorrection });
    } catch (error) {
      if (error instanceof RuntimeControlPaused || error instanceof RuntimeControlStale) {
        await enqueue(QUEUES.digest, job.data, {
          singletonKey: `control:${job.data.storyId}:${!!job.data.afterCorrection}`,
          startAfter: 60,
        });
        return { state: "waiting", reason: "runtime_control" };
      }
      throw error;
    }
  });
  const continuation = async <T extends object>(queue: string, key: (data: T) => string, run: (data: T) => Promise<unknown>) => {
    await ensureQueue(queue, EVENT_CONTINUATION_OPTIONS);
    await boss.work<T>(queue, { localConcurrency: 1, pollingIntervalSeconds: 5 }, async ([job]) => {
      if (!job) return;
      try {
        return await run(job.data);
      } catch (error) {
        if (!(error instanceof RuntimeControlPaused || error instanceof RuntimeControlStale)) throw error;
        await enqueue(queue, job.data, { singletonKey: key(job.data), startAfter: 60 });
        return { state: "waiting", reason: "runtime_control" };
      }
    });
  };
  await continuation<{ storyIds: number[] }>(
    EVENT_CONTINUATIONS.consolidate,
    (data) => [...data.storyIds].sort((a, b) => a - b).join(":"),
    (data) => consolidate(data.storyIds),
  );
  await continuation<{ articleId: string }>(
    EVENT_CONTINUATIONS.rematch,
    (data) => data.articleId,
    (data) => resumeSignalRematch(data.articleId),
  );
}
