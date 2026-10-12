import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import { requestSourcePreview, runSourcePreview, recoverSourcePreviews, SOURCE_PREVIEW_QUEUE, archiveSource } from "@amp/backend/admin/sources";
import { ensureQueue, stopBoss } from "@amp/backend/jobs/queue";
import { grantDateFixture } from "./source-date-fixture.ts";
const sql = dbOf("sources");
after(async () => {
  await stopBoss();
  await closeDb();
});
const result = { ms: 1, count: 1, items: [{ title: "恢复后合成铜矿样例", url: "https://example.com/one", publishedAt: null, excerpt: "" }] };
async function fixture() {
  const sourceId = `preview-recovery-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,enabled,config) VALUES(${sourceId},'合成恢复','rss',false,${sql.json({ feedUrl: "https://example.com/rss" })})`;
  await grantDateFixture(sourceId, ["https://example.com"]);
  await ensureQueue(SOURCE_PREVIEW_QUEUE);
  return { sourceId, ...(await requestSourcePreview(sourceId, {}, "test", { inline: true })) };
}
async function expire(id: number) {
  await sql`UPDATE sources.source_previews SET lease_until=now()-interval '1 second' WHERE id=${id}`;
}

test("a killed single-connection worker is requeued once after lease expiry; permanent failures remain closed", async () => {
  const preview = await fixture();
  const code = `import './tests/setup.ts'; import {runSourcePreview} from '@amp/backend/admin/sources';
    await runSourcePreview(process.argv[1],async()=>{console.log('ENTERED');await new Promise(()=>{});});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, String(preview.preview_id)], {
    env: { ...process.env, DATABASE_POOL_MAX: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Error("worker did not enter preview"));
    }, 4000);
    child.on("error", reject);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("ENTERED")) child.kill("SIGKILL");
    });
    child.on("exit", (_code, signal) => {
      clearTimeout(timer);
      signal === "SIGKILL" ? resolve() : reject(Error("worker did not get interrupted"));
    });
  });
  assert.equal((await sql`SELECT status FROM sources.source_previews WHERE id=${preview.preview_id}`)[0]!.status, "running");
  await expire(preview.preview_id);
  const results = await Promise.all([recoverSourcePreviews(), recoverSourcePreviews()]);
  assert.equal(
    results.reduce((n, value) => n + value.reenqueued, 0),
    1,
  );
  const [queued] = await sql`SELECT status,execution_token,lease_until,job_id FROM sources.source_previews WHERE id=${preview.preview_id}`;
  assert.equal(queued!.status, "queued");
  assert.ok(queued!.job_id);
  assert.equal(queued!.execution_token, null);
  assert.equal(queued!.lease_until, null);
  await assert.rejects(
    runSourcePreview(String(preview.preview_id), async () => {
      throw Error("synthetic permanent parsing error");
    }),
    /permanent/,
  );
  assert.equal((await recoverSourcePreviews()).reenqueued, 0);
  assert.equal((await requestSourcePreview(preview.sourceId, {}, "test", { inline: true })).preview_id, preview.preview_id);
});

for (const outcome of ["success", "failure"] as const)
  test(`the old token's late ${outcome} cannot replace a recovered execution`, async () => {
    const preview = await fixture();
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const first = runSourcePreview(String(preview.preview_id), async () => {
      entered.resolve();
      await release.promise;
      if (outcome === "failure") throw Error("late obsolete error");
      return { ...result, items: [{ ...result.items[0]!, title: "旧执行结果" }] };
    });
    const rejected = assert.rejects(first, /失效|obsolete/);
    await entered.promise;
    await expire(preview.preview_id);
    assert.equal((await recoverSourcePreviews()).reenqueued, 1);
    await runSourcePreview(String(preview.preview_id), async () => result);
    const [before] = await sql`SELECT status,result,error,completed_at FROM sources.source_previews WHERE id=${preview.preview_id}`;
    release.resolve();
    await rejected;
    assert.deepEqual((await sql`SELECT status,result,error,completed_at FROM sources.source_previews WHERE id=${preview.preview_id}`)[0], before);
    assert.equal(before!.status, "succeeded");
    assert.equal(before!.result.items[0].title, result.items[0]!.title);
  });

test("archive fences both a late failure and recovery without resurrecting the preview", async () => {
  const preview = await fixture();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const running = runSourcePreview(String(preview.preview_id), async () => {
    entered.resolve();
    await release.promise;
    throw Error("late worker failure");
  });
  const rejected = assert.rejects(running, /late worker/);
  await entered.promise;
  const [source] = await sql`SELECT updated_at FROM sources WHERE id=${preview.sourceId}`;
  await archiveSource(preview.sourceId, { version: source!.updated_at.toISOString(), reason: "合成终态归档", high_risk_confirmed: true }, "test");
  release.resolve();
  await rejected;
  const [row] = await sql`SELECT status,error,execution_token,lease_until FROM sources.source_previews WHERE id=${preview.preview_id}`;
  assert.equal(row!.status, "failed");
  assert.match(row!.error, /归档/);
  assert.equal(row!.execution_token, null);
  assert.equal(row!.lease_until, null);
  assert.equal((await recoverSourcePreviews()).reenqueued, 0);
});
