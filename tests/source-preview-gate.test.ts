import { tag } from "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { dbOf, closeDb } from "@amp/backend/db";
import { updateSource, requestSourcePreview, runSourcePreview, SOURCE_PREVIEW_QUEUE } from "@amp/backend/admin/sources";
import { grantDateFixture } from "./source-date-fixture.ts";
import { ensureQueue, stopBoss } from "@amp/backend/jobs/queue";
const sql = dbOf("sources");
after(async () => {
  await stopBoss();
  await closeDb();
});
test("first enable and configuration switches require successful preview bound to current inputs", async () => {
  const id = `preview-${tag()}`,
    config = { feedUrl: "https://example.com/news.xml" };
  await sql`INSERT INTO sources(id,name,kind,config,enabled) VALUES(${id},'Test','rss',${sql.json(config)},false)`;
  await grantDateFixture(id, [config.feedUrl]);
  const version = async () => (await sql`SELECT updated_at FROM sources WHERE id=${id}`)[0]!.updated_at.toISOString();
  await assert.rejects(() => updateSource(id, { patch: { enabled: true }, version: "bad" }, "test"), /修改/);
  await assert.rejects(async () => updateSource(id, { patch: { enabled: true }, version: await version() }, "test"), /预览/);
  await ensureQueue(SOURCE_PREVIEW_QUEUE);
  const p = await requestSourcePreview(id, {}, "test");
  const result = { ms: 1, count: 1, items: [{ title: "Sample", url: "https://example.com/1", publishedAt: null, excerpt: "sample" }] };
  await runSourcePreview(String(p.preview_id), async () => result);
  await sql`UPDATE sources.source_previews SET completed_at=now()-interval '25 hours' WHERE id=${p.preview_id}`;
  await assert.rejects(async () => updateSource(id, { patch: { enabled: true }, version: await version() }, "test"), /24小时/);
  await sql`UPDATE sources.source_previews SET completed_at=now()-interval '23 hours' WHERE id=${p.preview_id}`;
  await updateSource(id, { patch: { enabled: true }, version: await version() }, "test");
  assert.equal((await sql`SELECT enabled FROM sources WHERE id=${id}`)[0]!.enabled, true);
  const revised = { feedUrl: "https://example.com/new.xml" };
  const saved = await updateSource(id, { patch: { config: revised }, version: await version() }, "test");
  assert.ok(saved && "draft" in saved);
  assert.deepEqual((await sql`SELECT config FROM sources WHERE id=${id}`)[0]!.config, config);
  await assert.rejects(
    async () => updateSource(id, { patch: {}, config_command: "activate_draft", draft_id: Number(saved.draft!.id), version: await version() }, "test"),
    /预览/,
  );
  const p2 = await requestSourcePreview(id, { draft_id: Number(saved.draft!.id) }, "test");
  await runSourcePreview(String(p2.preview_id), async () => result);
  await sql`UPDATE sources.source_previews SET completed_at=now()-interval '25 hours' WHERE id=${p2.preview_id}`;
  await assert.rejects(
    async () =>
      updateSource(
        id,
        { patch: {}, config_command: "activate_draft", draft_id: Number(saved.draft!.id), preview_id: Number(p2.preview_id), version: await version() },
        "test",
      ),
    /24小时/,
  );
  assert.deepEqual((await sql`SELECT config FROM sources WHERE id=${id}`)[0]!.config, config);
  await sql`UPDATE sources.source_previews SET completed_at=now() WHERE id=${p2.preview_id}`;
  await updateSource(
    id,
    { patch: {}, config_command: "activate_draft", draft_id: Number(saved.draft!.id), preview_id: Number(p2.preview_id), version: await version() },
    "test",
  );
  assert.deepEqual((await sql`SELECT config FROM sources WHERE id=${id}`)[0]!.config, revised);
});

test("private HTTP reports missing current preview or nonexistent draft as actionable 409 conflicts", async (t) => {
  const { buildApp } = await import("../apps/api/src/app.ts");
  const { config } = await import("@amp/backend/config");
  const prior = config.devAdmin;
  config.devAdmin = { displayName: "Synthetic source preview operator" };
  const app = await buildApp("private-api");
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await app.close();
    config.devAdmin = prior;
  });
  const id = `preview-http-${tag()}`,
    sourceConfig = { feedUrl: "https://example.com/preview.xml" };
  await sql`INSERT INTO sources(id,name,kind,config,enabled) VALUES(${id},'HTTP fixture','rss',${sql.json(sourceConfig)},false)`;
  await grantDateFixture(id, [sourceConfig.feedUrl]);
  const version = (await sql`SELECT updated_at FROM sources WHERE id=${id}`)[0]!.updated_at.toISOString();
  const headers = { "content-type": "application/json", "x-csrf-token": "dev" };
  const enable = await fetch(`${address}/api/admin/sources/${id}`, { method: "PATCH", headers, body: JSON.stringify({ patch: { enabled: true }, version }) });
  assert.equal(enable.status, 409);
  const problem = (await enable.json()) as { code: string; detail: string };
  assert.equal(problem.code, "conflict");
  assert.match(problem.detail, /须先成功预览/);
  const draft = await fetch(`${address}/api/admin/sources/${id}/preview`, { method: "POST", headers, body: JSON.stringify({ draft_id: 999999 }) });
  assert.equal(draft.status, 409);
  assert.match(((await draft.json()) as { detail: string }).detail, /草稿不存在/);
  assert.equal((await sql`SELECT enabled FROM sources WHERE id=${id}`)[0]!.enabled, false);
});
