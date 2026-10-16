import { tag } from "./setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { sql, closeDb } from "@amp/backend/db";
import { upsertMaterial } from "@amp/backend/content/materials";
import { overrideFields, contentChain, setVisibility } from "@amp/backend/admin/content";
import { publishArticle } from "@amp/backend/publication/publish";
import { stopBoss, ensureQueue } from "@amp/backend/jobs/queue";

after(async () => {
  await stopBoss();
  await closeDb();
});
test("manual drafts stay private; publication binds evidence and changed source invalidates conflicting copy", async () => {
  const sourceId = `manual-${tag()}`,
    body = "Alpha项目已经获得项目建设审批，具体事实以本官方公告为准。";
  await sql`INSERT INTO sources(id,name,kind) VALUES(${sourceId},'Test','rss')`;
  const m = await upsertMaterial({
    sourceId,
    url: `https://example.com/${sourceId}`,
    title: "原文矿业项目",
    bodyText: body,
    bodyHtml: `<p>${body}</p>`,
    language: "zh",
    via: "fetch",
  });
  const input = { fields: { title: "人工标题", summary: "人工中文摘要说明矿业项目建设审批情况" }, reason: "核对原文", version: 0, source_revision: 1 };
  const draft = await overrideFields(m.articleId, input, "test");
  assert.equal(draft!.status, "draft");
  assert.equal((await sql`SELECT * FROM editorial_overrides WHERE article_id=${m.articleId}`).length, 0);
  await assert.rejects(() => overrideFields(m.articleId, { ...input, command: "publish" }, "test"), /核对/);
  const active = await overrideFields(m.articleId, { ...input, command: "publish", source_checked: true, facts_checked: true, evidence_quote: body }, "test");
  assert.equal(active!.status, "active");
  assert.equal((await sql`SELECT title FROM publications WHERE article_id=${m.articleId}`)[0]!.title, "人工标题");
  await upsertMaterial({
    sourceId,
    url: `https://example.com/${sourceId}`,
    title: "原文更正矿业项目",
    bodyText: "Alpha项目尚未获得审批，原公告有关建设审批的信息现予更正。",
    language: "zh",
    via: "fetch",
  });
  await publishArticle(m.articleId);
  const history = (await contentChain(m.articleId))!.manualRevisions;
  assert.equal(history[0]!.status, "conflict");
  assert.notEqual((await sql`SELECT title FROM publications WHERE article_id=${m.articleId}`)[0]!.title, "人工标题");
});
test("audit failure rolls visibility and publication back together", async () => {
  const sourceId = `atomic-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind) VALUES(${sourceId},'Test','rss')`;
  const m = await upsertMaterial({
    sourceId,
    url: `https://example.com/${sourceId}`,
    title: "标题",
    bodyText: "合成中文矿业材料正文，用于验证发布事务。",
    language: "zh",
    via: "fetch",
  });
  await publishArticle(m.articleId);
  await ensureQueue("events.hot-refresh");
  const before = await sql`SELECT visibility,revision FROM publications WHERE article_id=${m.articleId}`;
  await sql.unsafe(
    `CREATE FUNCTION audit_atomic_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='content.visibility' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$`,
  );
  await sql.unsafe(`CREATE TRIGGER audit_atomic_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_atomic_fail()`);
  await assert.rejects(() => setVisibility(m.articleId, { visibility: "withdrawn", reason: "test", version: 0 }, "test"), /injected/);
  assert.deepEqual(await sql`SELECT visibility,revision FROM publications WHERE article_id=${m.articleId}`, before);
  assert.equal((await sql`SELECT * FROM editorial_overrides WHERE article_id=${m.articleId}`).length, 0);
  await sql.unsafe("DROP TRIGGER audit_atomic_fail ON audit_log");
});
