/** Existing parser/material tests use explicit synthetic robots and a virtual pacing clock.
 * Real HTTP timing, queue continuation and robots failures live in crawl-queues/crawl-pacing. */
import { previewSource as preview, readSourceDateContext } from "@amp/backend/admin/sources";
import { collectSource as collect } from "@amp/backend/sources/collect";
import { withSourceCrawl, CrawlDeferred } from "../packages/backend/src/acquisition/crawl.ts";
import { saveRobots } from "../packages/backend/src/acquisition/pacing.ts";
let clock = Date.now(),
  serial = 0;
export async function collectSource(sourceId: string, opts: Parameters<typeof collect>[1] = {}) {
  const source = await readSourceDateContext(sourceId);
  if (!source) return collect(sourceId, opts);
  const url = String(source.config.feedUrl ?? source.config.url ?? "").replace(/^https:\/\/r\.jina\.ai\//, "");
  if (!url) return collect(sourceId, opts);
  await saveRobots(new URL(url).origin, 404, "", new Date(clock), null, null);
  const scope = `parser-fixture:${sourceId}:${++serial}`;
  for (let n = 0; n < 100; n++) {
    try {
      return await withSourceCrawl(
        source,
        scope,
        async () => {
          const result = await collect(sourceId, opts);
          if (result.status === "deferred") throw new CrawlDeferred(new Date(result.retryAt!), result.reservationId!, result.error ?? "deferred");
          return result;
        },
        { now: () => new Date(clock) },
      );
    } catch (error) {
      if (!(error instanceof CrawlDeferred)) throw error;
      clock = Math.max(clock + 1, error.retryAt.getTime());
    }
  }
  throw new Error("Synthetic collection did not finish its bounded steps");
}

export async function previewSource(draft: Parameters<typeof preview>[0]) {
  const saved = await readSourceDateContext(draft.id);
  if (!saved) return preview(draft);
  const source = { ...saved, ...draft },
    scope = `preview-fixture:${draft.id}:${++serial}`;
  for (let n = 0; n < 100; n++) {
    try {
      return await withSourceCrawl(
        source,
        scope,
        async () => {
          const result = await preview(draft);
          if ("status" in result && result.status === "deferred") throw new CrawlDeferred(new Date(result.retryAt), "preview-fixture", result.reason);
          return result;
        },
        { now: () => new Date(clock) },
      );
    } catch (error) {
      if (!(error instanceof CrawlDeferred)) throw error;
      clock = Math.max(clock + 1, error.retryAt.getTime());
    }
  }
  throw new Error("Synthetic preview did not finish");
}
