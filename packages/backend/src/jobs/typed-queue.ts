import type { JobData, JobLane, QueueName, LegacyJobData } from "@amp/contracts/jobs";
import type { PgBoss, SendOptions, WorkOptions } from "pg-boss";
import type { Db } from "../db.ts";
import type { ModuleQueue } from "../modules.ts";
import { enqueue, ensureQueue } from "./queue.ts";

const lanes = {
  "content.analyze": "news",
  "content.translate": "news",
  "content.extract-body": "news",
  "events.group": "news",
  "events.digest": "news",
  "events.hot-refresh": "news",
  "news.events.consolidate": "news",
  "news.events.rematch": "news",
  "sources.fetch": null,
  "news.sources.fetch": "news",
  "policy.sources.fetch": "policy",
  "sources.mp": null,
  "sources.preview": null,
  "notify.selected": "news",
  "publication.republish-source": "news",
  "reports.correct": "news",
  "reports.reconcile": "news",
  "news.model-test": "news",
  "policy.model-test": "policy",
} as const satisfies Record<QueueName, JobLane | null>;

export const engineQueueNames = Object.freeze(Object.keys(lanes));

/** New engine jobs always carry a lane. Old durable jobs are handled by the consumer's compatibility path. */
export function enqueueJob<Q extends QueueName>(name: Q, data: JobData[Q], options: SendOptions = {}, tx?: Db): Promise<string | null> {
  if (!Object.hasOwn(lanes, name) || !data || (data.lane !== "news" && data.lane !== "policy")) throw new Error("Invalid engine job lane");
  if (lanes[name] !== null && lanes[name] !== data.lane) throw new Error("Job lane does not match its queue");
  return enqueue(name, { ...data }, options, tx);
}

/** A module supplies its own typed queue definition; the business write and job share the caller's transaction. */
export async function enqueueOn<T extends { lane: JobLane }>(queue: ModuleQueue<T>, data: T, options: SendOptions = {}, tx?: Db): Promise<string | null> {
  if (data.lane !== "news" && data.lane !== "policy") throw new Error("Invalid module job lane");
  const name = queue.name;
  if (!name.trim() || Object.hasOwn(lanes, name)) throw new Error("Invalid module queue name");
  const payload = { ...data };
  await ensureQueue(name, queue.options);
  return enqueue(name, payload, options, tx);
}

/** Old payloads resolve their lane from current stored context before reaching business code. */
export async function work<Q extends QueueName>(
  boss: PgBoss,
  name: Q,
  options: WorkOptions,
  resolveLane: (data: LegacyJobData<Q>) => Promise<JobLane | null>,
  handler: (data: JobData[Q]) => Promise<unknown>,
): Promise<void> {
  if (!Object.hasOwn(lanes, name)) throw new Error("Invalid engine queue name");
  if (options.batchSize !== undefined && options.batchSize !== 1) throw new Error("Engine handlers consume one job at a time");
  await ensureQueue(name);
  await boss.work<LegacyJobData<Q>>(name, { ...options, batchSize: 1 }, async ([job]) => {
    if (!job) return;
    if (!job.data || typeof job.data !== "object") throw new Error("Invalid job payload");
    const lane = await resolveLane(job.data);
    if (lane === null) return { state: "missing" };
    if (lane !== "news" && lane !== "policy") throw new Error("Invalid stored job lane");
    if (job.data.lane !== undefined && job.data.lane !== lane) throw new Error("Job lane does not match its stored context");
    if (!Object.hasOwn(lanes, name) || (lanes[name] !== null && lanes[name] !== lane)) throw new Error("Stored context does not match the queue lane");
    return handler({ ...job.data, lane } as JobData[Q]);
  });
}
