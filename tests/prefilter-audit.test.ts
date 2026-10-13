import "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { closeDb, dbOf } from "@amp/backend/db";
import type { AdminPrincipal } from "@amp/backend/admin/auth";
import { upsertMaterial } from "@amp/backend/content/materials";
import { publishArticle } from "@amp/backend/publication/publish";
import { drawPrefilterAudit, labelPrefilterAudit, prefilterAuditTake, prefilterAuditView } from "@amp/backend/admin/selectbench";

const sql = dbOf("ai-gateway");
after(closeDb);

test("batch size stays near 20 and keeps both pools when both exist", () => {
  assert.deepEqual(prefilterAuditTake(20, { discarded: 2416, kept: 540 }), { discarded: 10, kept: 10 });
  assert.deepEqual(prefilterAuditTake(20, { discarded: 3, kept: 100 }), { discarded: 3, kept: 17 });
  assert.deepEqual(prefilterAuditTake(20, { discarded: 0, kept: 5 }), { discarded: 0, kept: 5 });
  assert.deepEqual(prefilterAuditTake(20, { discarded: 0, kept: 0 }), { discarded: 0, kept: 0 });
});

test("empty pool draws nothing; a real pool samples both sides without publishing withdrawn work", async () => {
  const [ownerRow] = await sql`INSERT INTO admin_users(email, display_name) VALUES('synthetic-owner@fixture.invalid', 'Synthetic Owner') RETURNING id`;
  await sql`INSERT INTO identity.account_access(user_id, role, models_manage, must_change_password) VALUES(${ownerRow!.id}, 'owner', true, false)`;
  const owner = { userId: Number(ownerRow!.id), accessRevision: 1, name: "Synthetic Owner", csrf: "synthetic", dev: false } as AdminPrincipal;
  const [other] = await sql`INSERT INTO admin_users(email, display_name) VALUES('synthetic-admin@fixture.invalid', 'Synthetic Admin') RETURNING id`;
  await sql`INSERT INTO identity.account_access(user_id, role, models_manage, must_change_password) VALUES(${other!.id}, 'admin', false, false)`;
  const manager = { userId: Number(other!.id), accessRevision: 1, name: "Synthetic Admin", csrf: "synthetic", dev: false } as AdminPrincipal;
  await assert.rejects(prefilterAuditView(manager), /权限/);

  const empty = await drawPrefilterAudit({ requestId: randomUUID(), nonce: randomUUID() }, owner);
  assert.equal(empty.pools.discarded, 0);
  assert.equal(empty.pools.kept, 0);
  assert.equal(empty.draw?.items.length, 0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM publications`)[0].n, 0);

  const sourceId = "synthetic-prefilter-source";
  await sql`INSERT INTO sources(id, name, kind, tier, config) VALUES(${sourceId}, 'Synthetic Source', 'rss', 'T2', '{}'::jsonb)`;
  await sql`INSERT INTO sources(id, name, kind, tier, config) VALUES('cgs-news', 'Synthetic Survey', 'rss', 'T1', '{}'::jsonb)`;
  const ids: string[] = [];
  const make = async (title: string, relevance: "pass" | "block" | "unknown", source = sourceId) => {
    const material = await upsertMaterial({
      sourceId: source,
      url: `https://fixture.invalid/prefilter/${ids.length}`,
      title,
      bodyText: "合成正文。项目取得许可并开始建设，供隔离测试使用。",
      bodyStatus: "ok",
      language: "zh",
      publishedAt: new Date("2026-03-01T00:00:00Z"),
      via: "fetch",
    });
    await sql`INSERT INTO analyses(article_id, input_revision, origin, relevance, title_zh, summary_zh)
      VALUES(${material.articleId}, 1, 'rule', ${relevance}, ${"合成中文标题"}, ${"合成中文导读，项目取得许可。"})`;
    ids.push(material.articleId);
    return material.articleId;
  };
  const discarded: string[] = [];
  const kept: string[] = [];
  for (let i = 0; i < 12; i++) discarded.push(await make(`合成丢掉${i}`, "block"));
  for (let i = 0; i < 12; i++) kept.push(await make(`合成保留${i}`, "pass"));
  const manual = await make("合成人工不收录", "pass");
  await sql`INSERT INTO editorial_overrides(article_id, fields, reason) VALUES(${manual}, ${sql.json({ relevance: "block" })}, '合成同意撤下')`;
  const withdrawn = await make("合成已撤下", "pass");
  await sql`INSERT INTO editorial_overrides(article_id, fields, visibility, reason) VALUES(${withdrawn}, '{}'::jsonb, 'withdrawn', '合成撤下')`;
  const survey = await make("合成地质调查", "pass", "cgs-news");
  const unknown = await make("合成不能判定", "unknown");
  const publishedKept = kept[0]!;
  const publishedDropped = discarded[0]!;
  await publishArticle(publishedKept);
  await publishArticle(publishedDropped);
  const beforeKept = (await sql`SELECT visibility FROM publications WHERE article_id = ${publishedKept}`)[0].visibility;
  const beforeDropped = (await sql`SELECT visibility FROM publications WHERE article_id = ${publishedDropped}`)[0].visibility;
  assert.equal(beforeKept, "public");
  assert.equal(beforeDropped, "withdrawn");

  const finger = async () =>
    JSON.stringify(
      await sql`SELECT a.id, a.processing_state, p.visibility, p.eligible,
        (SELECT count(*)::int FROM translations t WHERE t.article_id = a.id) AS translations
        FROM articles a LEFT JOIN publications p ON p.article_id = a.id
        WHERE a.id = ANY(${ids}) ORDER BY a.id`,
    );
  const before = await finger();
  const receiptsBefore = (await sql`SELECT count(*)::int AS n FROM receipts`)[0].n;
  // Reference the established draw ordering independently of the new cross-module ports.
  const expectedDraw = async (seed: string) => {
    const [previous] = await sql`SELECT id FROM ai.prefilter_audit_draws ORDER BY created_at DESC,id DESC LIMIT 1`;
    const result: string[] = [];
    for (const relevance of ["block", "pass"] as const) {
      const rows = await sql<{ article_id: string }[]>`WITH latest AS (
        SELECT DISTINCT ON(article_id) article_id,relevance FROM analyses ORDER BY article_id,input_revision DESC,id DESC
      ) SELECT a.id AS article_id FROM latest l JOIN articles a ON a.id=l.article_id
        JOIN sources s ON s.id=a.source_id AND s.lane='news'
        LEFT JOIN editorial_overrides o ON o.article_id=a.id AND (o.visibility='withdrawn' OR o.fields->>'relevance'='block')
        LEFT JOIN LATERAL(SELECT revision FROM ai.prefilter_audit_labels WHERE article_id=a.id ORDER BY revision DESC LIMIT 1) lab ON true
        LEFT JOIN ai.prefilter_audit_items prev ON prev.article_id=a.id AND prev.draw_id=${previous?.id ?? null}
        WHERE l.relevance=${relevance} AND o.article_id IS NULL AND s.id <> 'cgs-news'
        ORDER BY (lab.revision IS NULL AND prev.article_id IS NULL) DESC,(lab.revision IS NULL) DESC,hashtext(a.id || ${seed}),a.id LIMIT 10`;
      result.push(...rows.map((row) => row.article_id));
    }
    return result;
  };
  const seed = randomUUID(),
    expected = await expectedDraw(seed);
  const drawn = await drawPrefilterAudit({ requestId: randomUUID(), nonce: seed }, owner);
  assert.deepEqual(
    drawn.draw!.items.map((row) => row.articleId),
    expected,
  );
  assert.equal(drawn.draw!.items.length, 20);
  assert.equal(drawn.draw!.discarded, 10);
  assert.equal(drawn.draw!.kept, 10);
  assert.equal(drawn.pools.discarded, 12);
  assert.equal(drawn.pools.kept, 12);
  const sampled = new Set(drawn.draw!.items.map((item) => item.articleId));
  for (const id of [manual, withdrawn, survey, unknown]) assert.equal(sampled.has(id), false);
  assert.equal(drawn.draw!.items.filter((item) => item.pool === "discarded").length, 10);
  assert.equal(drawn.draw!.items.filter((item) => item.pool === "kept").length, 10);
  assert.equal(await finger(), before);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts`)[0].n, receiptsBefore);
  assert.equal((await sql`SELECT visibility FROM publications WHERE article_id = ${publishedKept}`)[0].visibility, "public");
  assert.equal((await sql`SELECT visibility FROM publications WHERE article_id = ${publishedDropped}`)[0].visibility, "withdrawn");
  assert.equal((await sql`SELECT count(*)::int AS n FROM publications WHERE article_id = ${survey}`)[0].n, 0);

  const sample = drawn.draw!.items[0]!;
  const labelInput = { requestId: randomUUID(), expectedRevision: 0, decision: "should_not_discard" as const, note: "合成标注" };
  const saved = await labelPrefilterAudit(sample.articleId, labelInput, owner);
  assert.equal(saved.decision, "should_not_discard");
  assert.equal((await labelPrefilterAudit(sample.articleId, labelInput, owner)).revision, saved.revision);
  await assert.rejects(labelPrefilterAudit(sample.articleId, { ...labelInput, requestId: randomUUID(), decision: "agree" }, owner), /标注已变化|操作编号/);
  assert.equal(await finger(), before);
  assert.equal((await sql`SELECT visibility FROM publications WHERE article_id = ${publishedDropped}`)[0].visibility, "withdrawn");
  const nextSeed = randomUUID(),
    nextExpected = await expectedDraw(nextSeed);
  const next = await drawPrefilterAudit({ requestId: randomUUID(), nonce: nextSeed }, owner);
  assert.deepEqual(
    next.draw!.items.map((row) => row.articleId),
    nextExpected,
    "unlabeled and not-previously-sampled priority stays exact",
  );
  assert.equal(await finger(), before);
});
