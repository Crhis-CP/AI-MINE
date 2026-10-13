import { tag } from "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { dbOf, closeDb } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { publishArticle } from "@amp/backend/publication/publish";
import { archiveSource, updateSource, listSources, fetchNow, requestSourcePreview, runSourcePreview, findDuplicateSource } from "@amp/backend/admin/sources";
import { collectSource } from "@amp/backend/sources/collect";
import { stopBoss } from "@amp/backend/jobs/queue";
import { grantDateFixture } from "./source-date-fixture.ts";
const sql = dbOf("sources");
after(async () => {
  await stopBoss();
  await closeDb();
});
test("source archive is terminal, fences later material/preview writes and preserves existing public content", async () => {
  const id = `archive-${tag()}`,
    config = { feedUrl: "https://source.invalid/news.xml" };
  await sql`INSERT INTO sources(id,name,kind,config,enabled,site_fulltext,health) VALUES(${id},'合成归档来源','rss',${sql.json(config)},true,true,'ok')`;
  await grantDateFixture(id, [config.feedUrl]);
  const material = {
    sourceId: id,
    url: `https://source.invalid/${id}`,
    title: "合成铜矿项目公开报道",
    bodyText: "这是一份用于验证归档后公开内容继续保留的合成中文报道。",
    language: "zh",
    via: "fetch" as const,
  };
  const stored = await upsertMaterial(material);
  await publishArticle(stored.articleId);
  const before = await sql`SELECT visibility,title FROM publications WHERE article_id=${stored.articleId}`;
  assert.equal(before[0]!.visibility, "public");
  const version = async () => (await sql`SELECT updated_at FROM sources WHERE id=${id}`)[0]!.updated_at.toISOString();
  await assert.rejects(archiveSource(id, { version: await version(), reason: "合成停用", high_risk_confirmed: false }, "test"), /确认/);
  const preview = await requestSourcePreview(id, {}, "test", { inline: true });
  await assert.rejects(
    runSourcePreview(String(preview.preview_id), async () => {
      await archiveSource(id, { version: await version(), reason: "合成归档并明确保留既有内容", high_risk_confirmed: true }, "test");
      return { ms: 1, count: 1, items: [{ title: "合成样例", url: material.url, publishedAt: null, excerpt: "合成摘要" }] };
    }),
    /归档/,
  );
  assert.deepEqual(await sql`SELECT visibility,title FROM publications WHERE article_id=${stored.articleId}`, before);
  assert.equal((await listSources({ q: id })).rows.length, 0);
  assert.equal((await listSources({ q: id, archived: "true" })).rows.length, 1);
  await assert.rejects(updateSource(id, { patch: { enabled: true }, version: await version() }, "test"), /归档/);
  await assert.rejects(fetchNow(id, "test"), /归档/);
  await assert.rejects(requestSourcePreview(id, {}, "test", { inline: true }), /归档/);
  await assert.rejects(upsertMaterial({ ...material, bodyText: "归档后不应覆盖到旧材料的新正文" }), /归档/);
  assert.equal((await collectSource(id)).error, "archived");
  assert.equal((await sql`SELECT revision FROM articles WHERE id=${stored.articleId}`)[0]!.revision, 1);
  await assert.rejects(sql`UPDATE sources SET enabled=true WHERE id=${id}`);
  await assert.rejects(sql`UPDATE sources SET archived_at=NULL WHERE id=${id}`, /terminal/);
  assert.equal(await findDuplicateSource("rss", config), null, "adding a fresh identity is possible after archive");
});

test("non-entry configuration activation retains exact RSS checkpoint, entry change resets it", async () => {
  const id = `cursor-${tag()}`,
    original = { feedUrl: "https://source.invalid/cursor.xml" };
  const cursor = {
    initializedAt: "2026-10-01T00:00:00Z",
    rss: { configHash: "old", etag: "synthetic-etag", responseUrl: original.feedUrl, lastModified: null },
  };
  await sql`INSERT INTO sources(id,name,kind,config,enabled,cursor) VALUES(${id},'检查点','rss',${sql.json(original)},true,${sql.json(cursor)})`;
  await grantDateFixture(id, [original.feedUrl]);
  const activate = async (config: Record<string, unknown>) => {
    const version = (await sql`SELECT updated_at FROM sources WHERE id=${id}`)[0]!.updated_at.toISOString();
    const draft = await updateSource(id, { patch: { config }, version }, "test");
    const preview = await requestSourcePreview(id, { draft_id: Number(draft!.draft!.id) }, "test", { inline: true });
    await runSourcePreview(String(preview.preview_id), async () => ({
      ms: 1,
      count: 1,
      items: [{ title: "合成检查点样例", url: original.feedUrl, publishedAt: null, excerpt: "" }],
    }));
    await updateSource(
      id,
      { patch: {}, version, config_command: "activate_draft", draft_id: Number(draft!.draft!.id), preview_id: Number(preview.preview_id) },
      "test",
    );
  };
  await activate({ ...original, _amp: { initialBackfillLimit: 15 } });
  assert.deepEqual((await sql`SELECT cursor FROM sources WHERE id=${id}`)[0]!.cursor, cursor);
  await activate({ feedUrl: "https://source.invalid/new-entry.xml" });
  assert.equal((await sql`SELECT cursor FROM sources WHERE id=${id}`)[0]!.cursor, null);
});
