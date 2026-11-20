import { sql, type Db } from "../db.ts";
import { engineQueueNames } from "./typed-queue.ts";
import type { PgBoss } from "pg-boss";
import { serverModules, type ModuleQueue } from "../modules.ts";
import { ensureQueue } from "./queue.ts";

/** Validate the complete set before creating queues or registering any consumer. */
export async function workQueues(boss: PgBoss, queues: readonly ModuleQueue[]): Promise<void> {
  const names = new Set<string>(engineQueueNames);
  for (const queue of queues) {
    if (!queue.name.trim() || names.has(queue.name)) throw new Error(`Invalid or duplicate module queue: ${queue.name}`);
    names.add(queue.name);
  }
  for (const queue of queues) {
    await ensureQueue(queue.name, queue.options);
    await boss.work(queue.name, { ...queue.worker, perJobResults: true }, async (jobs) => {
      const output = await queue.run(jobs.map((job) => job.data) as never[]);
      return jobs.map((job) => ({ id: job.id, status: "completed" as const, output }));
    });
  }
}
export function workModuleQueues(boss: PgBoss): Promise<void> {
  return workQueues(
    boss,
    serverModules().flatMap((module) => module.queues ?? []),
  );
}

export { enqueueJob, enqueueOn, work } from "./typed-queue.ts";

/**
 * Event shadow jobs completed in a window whose recall reached its window bound (pipeline/events/shadow-queue.ts output),
 * as far as the queue still keeps completed jobs.
 */
export async function shadowJobsWithFullWindow(from: Date, to: Date, db: Db = sql): Promise<number> {
  const [row] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM pgboss.job
    WHERE name='news.events.shadow' AND state='completed' AND completed_on>=${from} AND completed_on<${to}
      AND output->'recall'->>'windowFull'='true'`;
  return row?.n ?? 0;
}

/**
 * The output of the latest completed job of a module queue whose output holds the object `key`, as far as the queue keeps
 * completed jobs (pipeline/events/order-repair.ts resumes from it). Only that queue's jobs are read: the job table's key
 * begins with the queue name.
 */
export async function latestCompletedOutput(queue: string, key: string, db: Db = sql): Promise<Record<string, unknown> | null> {
  const [row] = await db<{ output: Record<string, unknown> }[]>`SELECT output FROM pgboss.job
    WHERE name=${queue} AND state='completed' AND jsonb_typeof(output->${key})='object' ORDER BY completed_on DESC LIMIT 1`;
  return row?.output ?? null;
}

/** Durable grouping waits belong to the queue module, including delayed and retrying jobs. */
export async function activeGroupingArticleIds(db: Db = sql): Promise<string[]> {
  const rows = await db<{ id: string }[]>`SELECT DISTINCT data->>'articleId' AS id FROM pgboss.job
    WHERE name='events.group' AND state IN ('created','active','retry') AND jsonb_typeof(data->'articleId')='string'`;
  return rows.map((row) => row.id);
}
