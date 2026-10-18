import { tag } from "./setup.ts";
import http from "node:http";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql, initializeDb } from "@amp/backend/db";
import { config } from "@amp/backend/config";
import { requestSourcePreview, runSourcePreview, recoverSourcePreviews, SOURCE_PREVIEW_QUEUE } from "@amp/backend/admin/sources";
import { ensureQueue, stopBoss } from "@amp/backend/jobs/queue";
import { grantDateFixture } from "./source-date-fixture.ts";
import { saveRobots } from "../packages/backend/src/acquisition/pacing.ts";
import { installUsageFixtureForService } from "./usage-protection-fixture.ts";

await closeDb();
await initializeDb("test", { ...process.env, DATABASE_POOL_MAX: "1" });
config.allowPrivateNetworkFetch = true;
after(async () => {
  await stopBoss();
  await closeDb();
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a lost Jina preview stays held on lease recovery while an explicit fresh preview has a new receipt", async (t) => {
  let hits = 0;
  const server = http.createServer((_req, _res) => {
    hits++;
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((r) => server.close(() => r()));
  });
  process.env.JINA_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.JINA_API_KEY = "synthetic-preview-key";
  await installUsageFixtureForService("jina");
  const origin = "https://preview-mining.example.test",
    id = `jina-preview-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,config,enabled) VALUES(${id},'合成Jina预览','web_list',${sql.json({ url: `https://r.jina.ai/${origin}/list`, parseMode: "markdown" })},false)`;
  await grantDateFixture(id, [origin]);
  await saveRobots(origin, 404, "", new Date(), null, null);
  await ensureQueue(SOURCE_PREVIEW_QUEUE);
  const preview = await requestSourcePreview(id, {}, "test", { inline: true });
  await assert.rejects(runSourcePreview(String(preview.preview_id), undefined, { timeoutMs: 500 }), /timeout|aborted/i);
  let receipt: { id: number; status: string } | undefined;
  for (let n = 0; n < 100; n++) {
    [receipt] = await sql<{ id: number; status: string }[]>`SELECT id,status FROM receipts WHERE subject=${`source:${id}`} AND service='jina'`;
    if (receipt?.status === "unknown") break;
    await wait(10);
  }
  assert.equal(receipt?.status, "unknown");
  assert.equal(hits, 1);
  const before = await sql`SELECT id,attempts,status FROM receipts WHERE id=${receipt!.id}`;
  // Persist the crash window after the gateway wrote unknown but before the worker wrote its terminal state.
  await sql`UPDATE sources.source_previews SET status='running',execution_token=${randomUUID()},lease_until=now()-interval '1 second',completed_at=NULL WHERE id=${preview.preview_id}`;
  assert.equal((await recoverSourcePreviews()).reenqueued, 1);
  // Advance only synthetic scheduler time; the provider receipt is unchanged.
  await sql`UPDATE acquisition.crawl_hosts SET next_slot=now()-interval '1 hour',last_finished=now()-interval '1 hour',cooldown_until=now()-interval '1 hour'`;
  await sql`UPDATE acquisition.crawl_requests SET ready_at=now()-interval '1 hour'`;
  await assert.rejects(runSourcePreview(String(preview.preview_id)), /预览待重试/);
  assert.equal(hits, 1);
  await sql`UPDATE sources.source_previews SET created_at=now()-interval '61 seconds' WHERE id=${preview.preview_id}`;
  const fresh = await requestSourcePreview(id, {}, "test", { inline: true });
  assert.notEqual(fresh.preview_id, preview.preview_id);
  await sql`UPDATE acquisition.crawl_hosts SET next_slot=now()-interval '1 hour',last_finished=now()-interval '1 hour',cooldown_until=now()-interval '1 hour'`;
  await sql`UPDATE acquisition.crawl_requests SET ready_at=now()-interval '1 hour'`;
  await assert.rejects(runSourcePreview(String(fresh.preview_id), undefined, { timeoutMs: 500 }), /timeout|aborted/i);
  for (let n = 0; n < 100; n++) {
    const [count] = await sql`SELECT count(*)::int n FROM receipts WHERE subject=${`source:${id}`} AND service='jina' AND status='unknown'`;
    if (count.n === 2) break;
    await wait(10);
  }
  assert.equal(hits, 2, "an explicit fresh preview is a distinct read, not a retry of the old receipt");
  assert.deepEqual(await sql`SELECT id,attempts,status FROM receipts WHERE id=${receipt!.id}`, before);
  assert.equal((await sql`SELECT count(*)::int n FROM receipts WHERE subject=${`source:${id}`} AND service='jina'`)[0]!.n, 2);
  assert.equal((await sql`SELECT count(*)::int n FROM receipt_attempts WHERE receipt_id=${receipt!.id}`)[0]!.n, 1);
  assert.equal((await recoverSourcePreviews()).reenqueued, 0, "unknown/permanent failures do not enter a recovery loop");
});
