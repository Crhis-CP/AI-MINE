import type { SendOptions } from "pg-boss";
import type { Db } from "../db.ts";
import { ensureQueue, enqueue, getBoss } from "./queue.ts";
export { sourceCollectionEnabled as collectionEnabled, sourceCollectionConcurrency as collectionConcurrency } from "../config.ts";

export type CollectionLane = "news" | "policy";
export const SOURCE_QUEUES = { news: "news.sources.fetch", policy: "policy.sources.fetch" } as const;
export const sourceFetchQueue = (lane: CollectionLane) => SOURCE_QUEUES[lane];
export async function ensureSourceQueues() {
  for (const name of Object.values(SOURCE_QUEUES)) await ensureQueue(name, { policy: "exclusive", retryLimit: 0, expireInSeconds: 600 });
}
export async function enqueueSourceFetch(
  lane: CollectionLane,
  data: { sourceId: string; force?: boolean; crawlSessionId?: string },
  options: SendOptions = {},
  tx?: Db,
) {
  await ensureSourceQueues();
  if (!data.crawlSessionId) {
    const jobs = await (await getBoss()).findJobs(sourceFetchQueue(lane), { data: { sourceId: data.sourceId }, ...(options.db ? { db: options.db } : {}) });
    if (jobs.some((job) => ["created", "retry", "active"].includes(job.state))) return null;
  }
  return enqueue(sourceFetchQueue(lane), { ...data, lane }, { ...options, singletonKey: options.singletonKey ?? data.sourceId }, tx);
}
