import { tag } from "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { dbOf, closeDb } from "@amp/backend/db";
import { requestSourcePreview, runSourcePreview, SOURCE_PREVIEW_QUEUE, saveSourcePolicy } from "@amp/backend/admin/sources";
import { grantDateFixture } from "./source-date-fixture.ts";
import { ensureQueue, stopBoss } from "@amp/backend/jobs/queue";
const sql = dbOf("sources");
after(async () => {
  await stopBoss();
  await closeDb();
});
const result = { ms: 1, count: 1, items: [{ title: "合成铜矿样例", url: "https://example.com/one", publishedAt: null, excerpt: "" }] };

test("parallel submissions and a running preview reuse the same persisted job; terminal tasks are reused for one minute before a fresh request", async () => {
  const id = `preview-idem-${tag()}`,
    config = { feedUrl: "https://example.com/news.xml" };
  await sql`INSERT INTO sources(id,name,kind,config,enabled) VALUES(${id},'合成暂停源','rss',${sql.json(config)},false)`;
  await grantDateFixture(id, [config.feedUrl]);
  await ensureQueue(SOURCE_PREVIEW_QUEUE);
  const requests = await Promise.all(Array.from({ length: 6 }, () => requestSourcePreview(id, {}, "test")));
  assert.ok(requests.every((p) => p.preview_id === requests[0]!.preview_id && p.job_id === requests[0]!.job_id));
  assert.ok(requests[0]!.job_id);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let calls = 0;
  const running = runSourcePreview(String(requests[0]!.preview_id), async () => {
    calls++;
    entered.resolve();
    await release.promise;
    return result;
  });
  await entered.promise;
  try {
    const again = await requestSourcePreview(id, {}, "test");
    assert.equal(again.status, "running");
    assert.equal(again.preview_id, requests[0]!.preview_id);
    assert.equal(again.job_id, requests[0]!.job_id);
    await assert.rejects(
      runSourcePreview(String(again.preview_id), async () => {
        calls++;
        return result;
      }),
      /正在执行/,
    );
  } finally {
    release.resolve();
  }
  await running;
  assert.equal(calls, 1);
  assert.deepEqual(
    await runSourcePreview(String(requests[0]!.preview_id), async () => {
      throw Error("must not fetch completed task");
    }),
    result,
  );
  const finished = await requestSourcePreview(id, {}, "test");
  assert.equal(finished.preview_id, requests[0]!.preview_id);
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.count, 1);
  await sql`UPDATE sources.source_previews SET created_at=now()-interval '61 seconds' WHERE id=${finished.preview_id}`;
  const second = await requestSourcePreview(id, {}, "test");
  assert.notEqual(second.preview_id, requests[0]!.preview_id);
  await assert.rejects(
    runSourcePreview(String(second.preview_id), async () => {
      throw Error("synthetic fetch failed");
    }),
    /synthetic/,
  );
  const failed = await requestSourcePreview(id, {}, "test");
  assert.equal(failed.preview_id, second.preview_id);
  assert.equal(failed.status, "failed");
  await sql`UPDATE sources.source_previews SET created_at=now()-interval '61 seconds' WHERE id=${failed.preview_id}`;
  const third = await requestSourcePreview(id, {}, "test");
  assert.notEqual(third.preview_id, second.preview_id);
  assert.equal((await sql`SELECT count(*)::int n FROM sources.source_previews WHERE source_id=${id}`)[0]!.n, 3);
});

test("identical draft submissions reuse one task while changed permission or configuration starts a distinct binding", async () => {
  const id = `preview-bind-${tag()}`,
    config = { feedUrl: "https://example.com/original.xml" };
  await sql`INSERT INTO sources(id,name,kind,config,enabled) VALUES(${id},'合成草稿','rss',${sql.json(config)},false)`;
  const granted = await grantDateFixture(id, [config.feedUrl]);
  const draftConfig = { feedUrl: "https://example.com/draft.xml" };
  const previews = await Promise.all(Array.from({ length: 3 }, () => requestSourcePreview(id, { config: draftConfig }, "test", { inline: true })));
  assert.ok(previews.every((p) => p.preview_id === previews[0]!.preview_id));
  const [draft] = await sql`SELECT draft_id FROM sources.source_previews WHERE id=${previews[0]!.preview_id}`;
  const selected = await requestSourcePreview(id, { draft_id: Number(draft!.draft_id) }, "test", { inline: true });
  assert.equal(selected.preview_id, previews[0]!.preview_id);
  const changed = await requestSourcePreview(id, { config: { feedUrl: "https://example.com/other.xml" } }, "test", { inline: true });
  assert.notEqual(changed.preview_id, selected.preview_id);
  await saveSourcePolicy(id, { policy: granted, expectedVersion: granted.permission_version, reason: "Synthetic permit refresh" }, "test");
  const renewed = await requestSourcePreview(id, { draft_id: Number(draft!.draft_id) }, "test", { inline: true });
  assert.notEqual(renewed.preview_id, selected.preview_id);
  await assert.rejects(
    runSourcePreview(String(selected.preview_id), async () => result),
    /许可/,
  );
  await runSourcePreview(String(renewed.preview_id), async () => result);
  assert.equal((await sql`SELECT enabled,cursor FROM sources WHERE id=${id}`)[0]!.enabled, false);
  assert.equal((await sql`SELECT enabled,cursor FROM sources WHERE id=${id}`)[0]!.cursor, null);
});
