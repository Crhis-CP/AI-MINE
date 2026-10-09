import type { SendOptions } from "pg-boss";
import type { Db } from "../db.ts";
import { ensureQueue, enqueue } from "./queue.ts";

export type CollectionLane = "news" | "policy";
export const SOURCE_QUEUES = { news: "news.sources.fetch", policy: "policy.sources.fetch" } as const;
export const sourceFetchQueue = (lane: CollectionLane) => SOURCE_QUEUES[lane];
export const collectionEnabled = (lane: CollectionLane) =>
  process.env.COLLECT_ENABLED !== "false" && process.env[`COLLECT_${lane.toUpperCase()}_ENABLED`] !== "false";
export function collectionConcurrency(lane: CollectionLane): number {
  const n = Number(process.env[`FETCH_${lane.toUpperCase()}_CONCURRENCY`] ?? (lane === "news" ? (process.env.FETCH_CONCURRENCY ?? 8) : 2));
  return Number.isInteger(n) && n > 0 ? Math.min(n, 32) : lane === "news" ? 8 : 2;
}
export async function ensureSourceQueues() {
  for (const name of Object.values(SOURCE_QUEUES)) await ensureQueue(name, { policy: "exclusive", retryLimit: 0, expireInSeconds: 600 });
}
export async function enqueueSourceFetch(lane: CollectionLane, data: { sourceId: string; force?: boolean }, options: SendOptions = {}, tx?: Db) {
  await ensureSourceQueues();
  return enqueue(sourceFetchQueue(lane), { ...data, lane }, { ...options, singletonKey: data.sourceId }, tx);
}
