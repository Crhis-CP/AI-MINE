// Only loopback/self-authored intake tests: preserve the real worker preview and host pacing.
import { dbOf } from "@amp/backend/db";
import { setTimeout as delay } from "node:timers/promises";
import { requestSourcePreview, runSourcePreview, previewSource } from "@amp/backend/admin/sources";
export async function previewSourceFixture(sourceId: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const preview = await requestSourcePreview(sourceId, {}, "synthetic-test", { inline: true });
    let retryAt: string | undefined;
    try {
      await runSourcePreview(String(preview.preview_id), async (source) => {
        const result = await previewSource(source);
        if ("status" in result && result.status === "deferred") retryAt = result.retryAt;
        return result;
      });
      // Default fixture crawl spacing also applies between preview and its first scheduled fetch.
      await delay(2050);
      return;
    } catch (error) {
      if (!retryAt || attempt === 4) throw error;
      // Advance only this synthetic submission's repeat-click window, then request a new preview.
      // A completed failed task itself is immutable to reruns; the real one-minute gate stays enabled.
      await dbOf("sources")`UPDATE sources.source_previews SET created_at=now()-interval '61 seconds'
        WHERE id=${preview.preview_id} AND status='failed'`;
      await delay(Math.max(1, new Date(retryAt).getTime() - Date.now() + 20));
    }
  }
}
