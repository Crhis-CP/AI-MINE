// Collection jobs: per-source fetch runs and body extraction before analysis.
import type { PgBoss } from "pg-boss";
import { collectSource } from "../sources/collect.ts";
import { checkMpAccount } from "../sources/mp.ts";
import { ensureQueue, QUEUES } from "./queue.ts";
import { ensureSourceQueues, enqueueSourceFetch, sourceFetchQueue, collectionEnabled, collectionConcurrency, type CollectionLane } from "./source-queues.ts";
export { ensureSourceQueues, SOURCE_QUEUES } from "./source-queues.ts";
import { readSourceDateContext } from "@amp/backend/admin/sources";
import { registerExtractionJobs } from "./content.ts";

export async function registerSourceJobs(boss: PgBoss) {
  await ensureQueue(QUEUES.fetchSource);
  await ensureSourceQueues();
  for (const lane of ["news", "policy"] as const) {
    if (!collectionEnabled(lane)) continue;
    await boss.work<{ sourceId: string; lane: CollectionLane; force?: boolean; crawlSessionId?: string }>(
      sourceFetchQueue(lane),
      { localConcurrency: collectionConcurrency(lane), pollingIntervalSeconds: 2 },
      async ([job]) => {
        if (!job) return;
        const result = await collectSource(job.data.sourceId, { force: job.data.force, lane, crawlSessionId: job.data.crawlSessionId });
        if (result.status === "deferred")
          await enqueueSourceFetch(
            lane,
            { ...job.data, crawlSessionId: result.crawlSessionId },
            { startAfter: new Date(result.retryAt!), singletonKey: `${job.data.sourceId}:${result.reservationId}:${result.retryAt}` },
          );
        return result;
      },
    );
  }
  // Commit forwarding and legacy acknowledgement together; a crash cannot lose or replay the handoff.
  const forwarding = { localConcurrency: 1, pollingIntervalSeconds: 2, transactional: true } as const;
  await boss.work<{ sourceId: string; force?: boolean }, void, typeof forwarding>(QUEUES.fetchSource, forwarding, async ([job], tx) => {
    if (!job) return;
    const source = await readSourceDateContext(job.data.sourceId);
    if (!source) return;
    await enqueueSourceFetch(source.lane, job.data, { db: tx });
  });
  await ensureQueue(QUEUES.mpCheck);
  // Dajiala allows a few requests per second; two accounts at a time stays well under it.
  await boss.work<{ sourceId: string; reason?: "schedule" | "manual" }>(QUEUES.mpCheck, { localConcurrency: 2, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (!job) return;
    return checkMpAccount(job.data.sourceId, job.data.reason ?? "schedule");
  });
  await registerExtractionJobs(boss);
}
