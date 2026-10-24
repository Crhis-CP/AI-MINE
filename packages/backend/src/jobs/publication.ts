import { readSourceDateContext } from "../admin/sources.ts";
// Publication jobs: re-deriving a whole source after an admin change.
import type { PgBoss } from "pg-boss";
import { sql, type Db } from "../db.ts";

import { republishSource } from "../publication/publish.ts";
import { computeHotRanking } from "../events/hot.ts";
import { emit } from "../modules.ts";
import { ensureQueue, QUEUES } from "./queue.ts";
import { enqueueJob as enqueue, work } from "./module-queues.ts";

// The metal price refresh, run by the schedule metals.prices (TASK-0069).
export { refreshMetalPrices } from "../publication/metal-prices/refresh.ts";

export const republishKey = (sourceId: string) => `republish.source:${sourceId}`;

/** Queue intent and its progress marker commit with the source edit. */
export async function queueSourceRepublication(sourceId: string, actor: string, db: Db) {
  await db`INSERT INTO settings(key,value,updated_by)
    VALUES(${republishKey(sourceId)},${db.json({ status: "queued", queuedAt: new Date().toISOString() })},${actor})
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=now()`;
  return enqueue(QUEUES.republishSource, { sourceId, lane: "news" }, { singletonKey: sourceId }, db);
}

async function progress(sourceId: string, value: Record<string, unknown>) {
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${republishKey(sourceId)}, ${sql.json(value as never)}, 'worker')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
}

export async function registerPublicationJobs(boss: PgBoss) {
  await ensureQueue(QUEUES.republishSource);
  await work(
    boss,
    QUEUES.republishSource,
    { localConcurrency: 1, pollingIntervalSeconds: 2 },
    async (data) => (await readSourceDateContext(data.sourceId))?.lane ?? null,
    async (data) => {
      const { sourceId } = data;
      const startedAt = new Date().toISOString();
      await progress(sourceId, { status: "running", done: 0, total: null, startedAt });
      const result = await republishSource(sourceId, (done, total) => progress(sourceId, { status: "running", done, total, startedAt }));
      if (result.deferred) {
        await enqueue(QUEUES.republishSource, { sourceId, lane: "news" }, { singletonKey: `runtime:${sourceId}`, startAfter: new Date(Date.now() + 60_000) });
        await progress(sourceId, { status: "running", ...result, startedAt, reason: "公开暂停，等待恢复" });
        return result;
      }
      if (result.failed)
        await progress(sourceId, {
          status: "failed",
          ...result,
          startedAt,
          finishedAt: new Date().toISOString(),
          reason: "部分内容更新失败，已保留未完成记录",
        });
      // Ownership and publisher changes can alter heat without reducing public content.
      await computeHotRanking();
      if (result.failed) throw new Error(`Source republication incomplete: ${result.failed} failed`);
      if (result.total > 0) await emit("sourceRepublished", { sourceId });
      await progress(sourceId, { status: "done", ...result, startedAt, finishedAt: new Date().toISOString() });
      return result;
    },
  );
}

export { repairPublicationTimes } from "../publication/publish.ts";
