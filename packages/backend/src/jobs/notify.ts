import { articleJobLane } from "./content.ts";
// Content pushes: selected items after their release gate, each with its share image rendered first.
import type { PgBoss } from "pg-boss";
import { pushSelected } from "../notify/selected.ts";
import { warmShareImage } from "../media/prepare.ts";
import { ensureQueue, QUEUES } from "./queue.ts";
import { enqueueJob as enqueue, work } from "./module-queues.ts";

const MAX_RETRIES = 6;

export async function registerNotifyJobs(boss: PgBoss) {
  await ensureQueue(QUEUES.notifySelected);
  await work(boss, QUEUES.notifySelected, { localConcurrency: 1, pollingIntervalSeconds: 5 }, articleJobLane, async (data) => {
    // The push makes chat apps unfurl the link: have its share image ready (first attempt only).
    if (!data.attempt) await warmShareImage(data.articleId);
    const outcome = await pushSelected(data.articleId);
    const attempt = data.attempt ?? 0;
    if (outcome.status === "retry" && attempt < MAX_RETRIES) {
      await enqueue(QUEUES.notifySelected, { articleId: data.articleId, attempt: attempt + 1, lane: "news" }, { startAfter: outcome.after });
    }
    return outcome;
  });
}
