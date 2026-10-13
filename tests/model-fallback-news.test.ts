import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { dbOf, initializeDb, closeDb } from "@amp/backend/db";
import { upsertMaterial, readCurrentBody } from "@amp/backend/content/materials";
import { loadAnalyzeInput } from "@amp/backend/editorial/analyze";
import { readCurrentSourcePolicy, saveSourcePolicy } from "@amp/backend/admin/sources";
import { sha256 } from "@amp/backend/lib/ids";
import { prepareNewsFallback } from "../packages/backend/src/providers/news-fallback.ts";
import { reportFallbackInput } from "../packages/backend/src/reports/fallback-input.ts";
import { grantDateFixture } from "./source-date-fixture.ts";
const sql = dbOf("content"),
  root = await initializeDb("test");
after(closeDb);
const target = { modelKey: "registered:synthetic-backup", configurationHash: sha256("synthetic-config") };
async function material() {
  const id = `news-fallback-${tag()}`,
    url = `https://news.invalid/${id}`;
  await sql`INSERT INTO sources(id,name,kind,lane,enabled) VALUES(${id},${id},'external','news',false)`;
  await grantDateFixture(id, [url]);
  const row = await upsertMaterial({
    sourceId: id,
    url,
    title: "合成铜矿公告",
    bodyText: "Synthetic full original copper mine text.",
    bodyHtml: "<p>Synthetic full original copper mine text.</p>",
    bodyStatus: "ok",
    language: "en",
    via: "fetch",
  });
  assert.ok(row.articleId);
  return { articleId: row.articleId, sourceId: id, url };
}
test("prepared text binds exact source metadata, bytes, date version and per-step request before fallback", async () => {
  const m = await material(),
    expected = (await loadAnalyzeInput(m.articleId))!;
  const input = await prepareNewsFallback({ root, expected, current: () => loadAnalyzeInput(m.articleId), articles: [expected] });
  assert.ok(input);
  const a = input({ system: "synthetic-score", user: "actual prepared score text" }),
    b = input({ system: "synthetic-title", user: "different prepared title text" });
  assert.notEqual(a.inputFingerprint, b.inputFingerprint);
  const permit = await a.authorize(target);
  try {
    await permit.beforeRequest();
    await sql`UPDATE sources SET name='changed source facts' WHERE id=${m.sourceId}`;
    await assert.rejects(permit.beforeRequest(), /输入已变化/);
    assert.equal(await prepareNewsFallback({ root, expected, current: () => loadAnalyzeInput(m.articleId), articles: [expected] }), undefined);
  } finally {
    permit.close();
  }
  const body = (await readCurrentBody(m.articleId))!;
  const bodyInput = await prepareNewsFallback({ root, expected: body, current: () => readCurrentBody(m.articleId), articles: [body] });
  const bodyPermit = await bodyInput!({ system: "translate", user: { text: body.body_html, referenceOnly: "same original context" } }).authorize(target);
  try {
    await sql`UPDATE articles SET body_html='<p>Changed HTML with unchanged text revision</p>' WHERE id=${m.articleId}`;
    await assert.rejects(bodyPermit.beforeRequest(), /输入已变化/);
  } finally {
    bodyPermit.close();
  }
});
test("a permission version changed after preparation blocks backup even if it remains allowed", async () => {
  const m = await material(),
    expected = (await readCurrentBody(m.articleId))!;
  const input = await prepareNewsFallback({ root, expected, current: () => readCurrentBody(m.articleId), articles: [expected] });
  const policy = (await readCurrentSourcePolicy(m.sourceId))!;
  await saveSourcePolicy(m.sourceId, { expectedVersion: policy.permission_version, policy, reason: "Synthetic still-allowed revision" }, "test");
  await assert.rejects(input!({ system: "translate", user: "frozen" }).authorize(target), /材料版本已变化/);
});
async function projection(m: Awaited<ReturnType<typeof material>>) {
  const [a] = await sql<{ id: number }[]>`INSERT INTO analyses(article_id,input_revision,origin,model,prompt_version,receipt_ids,output)
 VALUES(${m.articleId},1,'model','synthetic','synthetic',${[]},'{}') RETURNING id`;
  await sql`INSERT INTO publications(article_id,analysis_id,title,summary,source_id,channel,url,discovered_at,timeline_at,sort_at,eligible,visibility,category)
 VALUES(${m.articleId},${a!.id},'合成中文标题','合成中文导读',${m.sourceId},'news',${m.url},now(),now(),now(),true,'public','mining')`;
  return { itemId: m.articleId, sourceId: m.sourceId, title: "合成中文标题", summary: "合成中文导读", category: "mining" };
}
test("report backup binds every actual source and rejects stale analysis/publication/withdrawn or missing provenance", async () => {
  const a = await material(),
    b = await material(),
    entries = [await projection(a), await projection(b)];
  const input = await reportFallbackInput(entries);
  assert.ok(input);
  const port = input({ system: "report", user: "actual two-entry report prompt" });
  assert.deepEqual([...port.sourceIds].sort(), [a.sourceId, b.sourceId].sort());
  const permit = await port.authorize(target);
  try {
    await permit.beforeRequest();
    await sql`UPDATE publications SET revision=revision+1,summary='new public summary' WHERE article_id=${b.articleId}`;
    await assert.rejects(permit.beforeRequest(), /输入已变化/);
    assert.equal(await reportFallbackInput(entries), undefined);
  } finally {
    permit.close();
  }
  await sql`UPDATE publications SET summary='合成中文导读' WHERE article_id=${b.articleId}`;
  await sql`UPDATE articles SET revision=2,content_hash=${sha256("new original")} WHERE id=${b.articleId}`;
  assert.equal(await reportFallbackInput(entries), undefined);
  await sql`UPDATE articles SET revision=1 WHERE id=${b.articleId}`;
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${a.articleId}`;
  assert.equal(await reportFallbackInput(entries), undefined);
  await sql`UPDATE publications SET visibility='public',analysis_id=NULL WHERE article_id=${a.articleId}`;
  assert.equal(await reportFallbackInput(entries), undefined);
});
test("a multi-source backup cannot send when any one source revokes external processing", async () => {
  const a = await material(),
    b = await material(),
    entries = [await projection(a), await projection(b)];
  const input = (await reportFallbackInput(entries))!;
  const permit = await input({ system: "report", user: "two sources" }).authorize(target);
  try {
    const policy = (await readCurrentSourcePolicy(b.sourceId))!;
    await saveSourcePolicy(
      b.sourceId,
      {
        expectedVersion: policy.permission_version,
        policy: { ...policy, permissions: { ...policy.permissions, external_model: "deny" } },
        reason: "Synthetic denial",
      },
      "test",
    );
    await assert.rejects(permit.beforeRequest(), /材料版本已变化/);
  } finally {
    permit.close();
  }
});
