import { tag } from "./setup.ts";
import http from "node:http";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { dbOf, closeDb } from "@amp/backend/db";
import { config } from "@amp/backend/config";
import { updateSource } from "@amp/backend/admin/sources";
import { upsertMaterial } from "@amp/backend/content/materials";
import { ingestItems } from "@amp/backend/ingest/items";
import { runtimeControlSnapshot } from "../packages/backend/src/operations/lane-controls.ts";
import { stopBoss } from "@amp/backend/jobs/queue";
import { collectSource } from "./crawl-fixture.ts";
import { grantDateFixture } from "./source-date-fixture.ts";
const sql = dbOf("sources");
config.allowPrivateNetworkFetch = true;
after(async () => {
  await stopBoss();
  await closeDb();
});

for (const format of ["markdown", "empty-rss"] as const)
  test(`pause during ${format} fetch prevents material, success watermark, cursor and health writes`, async (t) => {
    const arrived = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const server = http.createServer(async (_req, res) => {
      arrived.resolve();
      await release.promise;
      res.writeHead(200, { "content-type": format === "markdown" ? "text/plain" : "application/rss+xml" });
      res.end(
        format === "markdown"
          ? "[合成铜矿项目扩产报道](https://example.com/mining/new)"
          : '<?xml version="1.0"?><rss version="2.0"><channel><title>Synthetic empty feed</title></channel></rss>',
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    t.after(async () => {
      release.resolve();
      await new Promise<void>((r) => server.close(() => r()));
    });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/list`;
    const id = `pause-${format}-${tag()}`,
      sourceConfig = format === "markdown" ? { url, parseMode: "markdown" } : { feedUrl: url };
    const cursor = { initializedAt: "2026-10-01T00:00:00Z", keep: "prior-checkpoint" };
    await sql`INSERT INTO sources(id,name,kind,enabled,config,cursor,health,last_ok_at) VALUES(${id},'合成暂停源',${format === "markdown" ? "web_list" : "rss"},true,${sql.json(sourceConfig)},${sql.json(cursor)},'ok','2026-10-01')`;
    await grantDateFixture(id, [url, "https://example.com"]);
    const running = collectSource(id, { force: true });
    await arrived.promise;
    const [version] = await sql`SELECT updated_at FROM sources WHERE id=${id}`;
    await updateSource(id, { version: version!.updated_at.toISOString(), patch: { enabled: false }, reason: "合成并发暂停" }, "test");
    const [paused] = await sql`SELECT enabled,health,cursor,last_ok_at,last_fetch_at,fail_count,next_fetch_at FROM sources WHERE id=${id}`;
    release.resolve();
    const outcome = await running;
    assert.equal(outcome.status, "skipped", JSON.stringify(outcome));
    assert.equal(outcome.error, "source-paused");
    assert.equal((await sql`SELECT count(*)::int n FROM articles WHERE source_id=${id}`)[0]!.n, 0);
    assert.deepEqual((await sql`SELECT enabled,health,cursor,last_ok_at,last_fetch_at,fail_count,next_fetch_at FROM sources WHERE id=${id}`)[0], paused);
    assert.equal((await sql`SELECT status FROM fetch_runs WHERE source_id=${id} ORDER BY id DESC LIMIT 1`)[0]!.status, "skipped");
  });

test("an uncommitted source pause wins against a concurrent no-date material commit", async () => {
  const id = `pause-lock-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,enabled) VALUES(${id},'合成并发事务','external',true)`;
  const control = await runtimeControlSnapshot("news", ["collection"]);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const pausing = sql.begin(async (tx) => {
    await tx`UPDATE sources SET enabled=false WHERE id=${id}`;
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const writing = upsertMaterial(
    { sourceId: id, title: "暂停事务后的无日期正文", bodyText: "这段合成正文不应在暂停后被写入材料库。", url: `https://example.com/${id}`, via: "fetch" },
    undefined,
    control,
  );
  const rejected = assert.rejects(writing, /暂停/);
  release.resolve();
  await pausing;
  await rejected;
  assert.equal((await sql`SELECT count(*)::int n FROM articles WHERE source_id=${id}`)[0]!.n, 0);
});

test("external ingest does not advance success or create material for a paused source", async () => {
  const id = `pause-ingest-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,enabled,health,last_ok_at) VALUES(${id},'合成推送','external',false,'paused','2026-10-01')`;
  const [before] = await sql`SELECT last_ok_at,last_fetch_at,health FROM sources WHERE id=${id}`;
  await assert.rejects(ingestItems({ sourceId: id, items: [{ title: "合成无日期推送项目新闻", url: `https://example.com/${id}` }] }), /paused/);
  assert.deepEqual((await sql`SELECT last_ok_at,last_fetch_at,health FROM sources WHERE id=${id}`)[0], before);
  assert.equal((await sql`SELECT count(*)::int n FROM articles WHERE source_id=${id}`)[0]!.n, 0);
});
