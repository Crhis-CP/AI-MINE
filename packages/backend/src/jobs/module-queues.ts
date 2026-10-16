import type { PgBoss } from "pg-boss";
import { serverModules, type ModuleQueue } from "../modules.ts";
import { ensureQueue, QUEUES } from "./queue.ts";

/** Validate the complete set before creating queues or registering any consumer. */
export async function workQueues(boss: PgBoss, queues: readonly ModuleQueue[]): Promise<void> {
  const names = new Set<string>(Object.values(QUEUES));
  for (const queue of queues) {
    if (!queue.name.trim() || names.has(queue.name)) throw new Error(`Invalid or duplicate module queue: ${queue.name}`);
    names.add(queue.name);
  }
  for (const queue of queues) {
    await ensureQueue(queue.name, queue.options);
    await boss.work(queue.name, queue.worker, async (jobs) => queue.run(jobs.map((job) => job.data) as never[]));
  }
}
export function workModuleQueues(boss: PgBoss): Promise<void> {
  return workQueues(
    boss,
    serverModules().flatMap((module) => module.queues ?? []),
  );
}
