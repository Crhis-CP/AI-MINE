import { z } from "zod";
import type { JobData } from "@amp/contracts/jobs";
import { extractHistoricalAnchors } from "@amp/backend/publication/publish";
import { defineQueue } from "../modules.ts";
import { enqueueOn } from "../jobs/module-queues.ts";
import { RuntimeControlPaused, RuntimeControlStale, requireRuntimeRunning } from "../operations/lane-controls.ts";
import { ModelPostReceiptGuardError } from "../providers/llm.ts";
import { isModelRouteWaiting, modelRouteWaitSeconds } from "../providers/model-fallback.ts";
import { BudgetExceededError, ReceiptBusyError, ReceiptUnknownError } from "../providers/receipts.ts";
import { historicalSnapshot, HistoricalBackgroundSuperseded } from "./historical-background-store.ts";
import { confirmHistoricalBackground } from "./historical-background.ts";

type HistoryJob = Pick<JobData["events.group"], "lane" | "articleId">;
const Payload = z.object({ lane: z.literal("news"), articleId: z.string().min(1) }).strict();
export const historyQueue = defineQueue<HistoryJob>({
  name: "news.events.history",
  options: { policy: "short", retryLimit: 3, retryDelay: 60, retryBackoff: true },
  worker: { localConcurrency: 1, pollingIntervalSeconds: 2, batchSize: 1 },
  async run([job]) {
    if (!job) return;
    const data = Payload.parse(job);
    try {
      await requireRuntimeRunning("news", ["processing", "publication"]);
      const query = (await historicalSnapshot([data.articleId]))[0]!;
      if (!query.memberships.length) return { state: "skipped", reason: "no_story" };
      const anchors = extractHistoricalAnchors(query.original.original_text);
      if (!anchors.length) return { state: "skipped", reason: "no_anchor" };
      // shortcut: compare three lexical candidates; expand only when measured recall shows useful omissions.
      return await confirmHistoricalBackground({ lane: "news", query: query.binding, anchors, limit: 3 });
    } catch (error) {
      if (error instanceof HistoricalBackgroundSuperseded) return { state: "skipped", reason: "superseded" };
      // The existing receipt recovery replays events.group, which durably schedules this same path again.
      if (error instanceof ReceiptUnknownError) return { state: "waiting", reason: "receipt", receiptId: error.receiptId };
      if (
        !(
          error instanceof RuntimeControlPaused ||
          error instanceof RuntimeControlStale ||
          error instanceof ModelPostReceiptGuardError ||
          error instanceof ReceiptBusyError ||
          error instanceof BudgetExceededError ||
          isModelRouteWaiting(error)
        )
      )
        throw error;
      await enqueueOn(historyQueue, data, {
        singletonKey: `wait:${data.articleId}`,
        startAfter: error instanceof BudgetExceededError ? Math.max(1, error.retryAfterSeconds) : modelRouteWaitSeconds(error, 60),
      });
      return { state: "waiting", reason: "runtime_or_model" };
    }
  },
});
