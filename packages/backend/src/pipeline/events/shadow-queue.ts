// The queue of the event rules in shadow: one job per grouped report, queued after the live grouping has committed
// (jobs/events.ts), run on its own at concurrency 1 with a slow poll, so it never holds up the grouping queue. The job
// decides the report by the rules (shadow.ts), refreshes the timing of the facts it touches (timing.ts) and the event
// order of their public reports (rank/project.ts). It makes no model call and writes only those three tables.
// It does not wait for the news processing switch (review of design M, F10): it calls no model and writes no table a
// reader sees, so a processing pause neither needs to stop it nor may lose its rows; during a cut-over pause the queue
// drains. Its own switch, the settings key events.shadow, stops it: off, nothing is queued and queued jobs do nothing.
import { z } from "zod";
import { enqueueOn } from "../../jobs/module-queues.ts";
import { defineQueue } from "../../modules.ts";
import { factPublications, projectEventOrder, rankedFact } from "../rank/project.ts";
import { eventShadowEnabled, shadowDecide } from "./shadow.ts";
import { articleFacts, observeFactTiming } from "./timing.ts";

/** Other public reports of a fact whose timing moved, refreshed per job; the rest wait for their own next job. */
export const REPROJECT_LIMIT = 50;
const Payload = z.object({ lane: z.literal("news"), articleId: z.string().min(1), keep: z.boolean().optional() }).strict();
type ShadowJob = z.infer<typeof Payload>;

export const shadowQueue = defineQueue<ShadowJob>({
  name: "news.events.shadow",
  options: { policy: "short", retryLimit: 1, retryDelay: 300, expireInSeconds: 600 },
  worker: { localConcurrency: 1, pollingIntervalSeconds: 10, batchSize: 1 },
  async run([job]) {
    if (!job) return;
    const data = Payload.parse(job);
    if (!(await eventShadowEnabled())) return { state: "skipped", reason: "switched_off" };
    const decision = await shadowDecide(data.articleId, { keepExisting: !!data.keep });
    const previous = await rankedFact(data.articleId);
    const moved = await observeFactTiming([...(await articleFacts(data.articleId)), ...(previous === null ? [] : [previous])]);
    await projectEventOrder(data.articleId);
    let reprojected = 0;
    for (const factId of moved)
      for (const id of await factPublications(factId, REPROJECT_LIMIT)) {
        if (id === data.articleId) continue;
        await projectEventOrder(id);
        reprojected++;
      }
    return { ...decision, movedFacts: moved.length, reprojected };
  },
});

let failures = 0;
/**
 * Called once a live grouping has committed. Queues the shadow decision when the switch is on; a discussion post or a
 * skipped report is not one the rules judge. A run where the live engine decided nothing new ("kept", "manual") only
 * fills a missing row. Never throws: a failure is logged and counted, and the grouping it follows stands.
 */
export async function scheduleEventShadow(articleId: string, verdict: string): Promise<boolean> {
  try {
    if (verdict === "skipped" || verdict.startsWith("signal") || !(await eventShadowEnabled())) return false;
    const keep = verdict === "kept" || verdict === "manual";
    await enqueueOn(shadowQueue, { lane: "news", articleId, ...(keep ? { keep } : {}) }, { singletonKey: `shadow:${articleId}${keep ? ":keep" : ""}` });
    return true;
  } catch (error) {
    failures++;
    console.warn(`[event-shadow] could not queue ${articleId} (${failures} failures since start); live grouping unaffected: ${String(error).slice(0, 200)}`);
    return false;
  }
}
