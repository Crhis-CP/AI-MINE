// Collection jobs: per-source fetch runs and body extraction before analysis.
import type { LegacyJobData } from "@amp/contracts/jobs";
import { work } from "./module-queues.ts";
import type { PgBoss } from "pg-boss";
import { collectSource } from "../sources/collect.ts";
import { checkMpAccount } from "../sources/mp.ts";
import { ensureQueue, QUEUES } from "./queue.ts";
import { ensureSourceQueues, enqueueSourceFetch, sourceFetchQueue, collectionEnabled, collectionConcurrency } from "./source-queues.ts";
export { ensureSourceQueues, SOURCE_QUEUES } from "./source-queues.ts";
import { readSourceDateContext, sourcePreviewLane, runSourcePreview, SOURCE_PREVIEW_QUEUE } from "@amp/backend/admin/sources";
import { registerExtractionJobs } from "./content.ts";
import { recordScheduledCheck } from "../publication/availability.ts";

export async function registerSourceJobs(boss: PgBoss) {
  await ensureQueue(SOURCE_PREVIEW_QUEUE);
  await work(
    boss,
    SOURCE_PREVIEW_QUEUE,
    { localConcurrency: 1, pollingIntervalSeconds: 2 },
    (data) => sourcePreviewLane(data.previewId),
    (data) => runSourcePreview(data.previewId),
  );
  await ensureQueue(QUEUES.fetchSource);
  await ensureSourceQueues();
  for (const lane of ["news", "policy"] as const) {
    if (!collectionEnabled(lane)) continue;
    await work(
      boss,
      sourceFetchQueue(lane),
      { localConcurrency: collectionConcurrency(lane), pollingIntervalSeconds: 2 },
      async (data) => (await readSourceDateContext(data.sourceId))?.lane ?? null,
      async (data) => {
        const result = await collectSource(data.sourceId, { force: data.force, lane, crawlSessionId: data.crawlSessionId });
        if (data.scheduled && result.status === "ok") await recordScheduledCheck(lane);
        if (result.status === "deferred")
          await enqueueSourceFetch(
            lane,
            { ...data, crawlSessionId: result.crawlSessionId },
            { startAfter: new Date(result.retryAt!), singletonKey: `${data.sourceId}:${result.reservationId}:${result.retryAt}` },
          );
        return result;
      },
    );
  }
  // Commit forwarding and legacy acknowledgement together; a crash cannot lose or replay the handoff.
  const forwarding = { localConcurrency: 1, pollingIntervalSeconds: 2, transactional: true } as const;
  await boss.work<LegacyJobData<"sources.fetch">, void, typeof forwarding>(QUEUES.fetchSource, forwarding, async ([job], tx) => {
    if (!job) return;
    const source = await readSourceDateContext(job.data.sourceId);
    if (!source) return;
    if (job.data.lane !== undefined && job.data.lane !== source.lane) throw new Error("Legacy collection lane does not match its source");
    await enqueueSourceFetch(source.lane, job.data, { db: tx });
  });
  await ensureQueue(QUEUES.mpCheck);
  // Dajiala allows a few requests per second; two accounts at a time stays well under it.
  await work(
    boss,
    QUEUES.mpCheck,
    { localConcurrency: 2, pollingIntervalSeconds: 2 },
    async (data) => (await readSourceDateContext(data.sourceId))?.lane ?? null,
    (data) => checkMpAccount(data.sourceId, data.reason ?? "schedule"),
  );
  await registerExtractionJobs(boss);
}
