import { tag } from "./setup.ts";
import { confirmedManualEdit } from "./confirmed-manual-fixture.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { dbOf, closeDb } from "@amp/backend/db";
import { updateSource } from "@amp/backend/admin/sources";
import { upsertMaterial } from "@amp/backend/content/materials";
import { publishArticle, republishSource } from "@amp/backend/publication/publish";
import { stopBoss } from "@amp/backend/jobs/queue";

const sql = dbOf("publication");
after(async () => {
  await stopBoss();
  await closeDb();
});
async function fixture(tier: string, selected: boolean, output: Record<string, unknown>, daysOld = 0) {
  const source = `tier-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,tier,site_fulltext) VALUES(${source},'合成矿业来源','rss',${tier},false)`;
  const { articleId } = await upsertMaterial({
    sourceId: source,
    url: `https://source.invalid/${source}`,
    title: "合成铜矿建设审批",
    language: "zh",
    bodyText: "合成铜矿项目已获得建设审批，全部材料仅用于本地隔离测试。",
    via: "fetch",
    publishedAt: new Date(Date.now() - daysOld * 86_400_000),
  });
  await sql`UPDATE articles SET timeline_at=${new Date(Date.now() - daysOld * 86_400_000)},grouped_at=now() WHERE id=${articleId}`;
  const [analysis] =
    await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,reason_zh,score,selected,prompt_version,output)
    VALUES(${articleId},1,'model','pass','合成铜矿建设审批','合成项目批准开工，仅供离线回归。','合成推荐理由',99,${selected},'analysis@synthetic',${sql.json(output as never)}) RETURNING id`;
  await publishArticle(articleId);
  return { source, articleId, analysisId: analysis!.id };
}
async function tier(source: string, value: string) {
  const [row] = await sql`SELECT updated_at FROM sources WHERE id=${source}`;
  await updateSource(source, { patch: { tier: value }, version: row!.updated_at.toISOString(), reason: "合成分级调整" }, "test");
}
async function projection(id: string) {
  return (await sql`SELECT * FROM publications WHERE article_id=${id}`)[0]!;
}

test("source tier republication compares the two original scores, keeps raw analysis and records the applied rule", async () => {
  const f = await fixture("T1", true, { scores: [65, 66], threshold: 60, scoreModel: "fixture" });
  await tier(f.source, "T2");
  const result = await republishSource(f.source);
  assert.equal(result.failed, 0);
  assert.equal((await projection(f.articleId)).selected, false, "65.5 is below the new media threshold despite display score 99");
  const [analysis] = await sql`SELECT selected,output FROM analyses WHERE id=${f.analysisId}`;
  assert.equal(analysis!.selected, true, "original analysis remains immutable");
  assert.deepEqual(analysis!.output.scores, [65, 66]);
  const [decision] = await sql`SELECT after FROM audit_log WHERE subject=${`article:${f.articleId}`} AND action='selection.recompute' ORDER BY id DESC LIMIT 1`;
  assert.equal(decision!.after.threshold, 76);
  assert.match(decision!.after.thresholdVersion, /^selection-thresholds@/);
  assert.equal(decision!.after.promptVersion, "analysis@synthetic");
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts`)[0]!.n, 0, "no model receipt is created");
});

test("missing, refused and malformed original scores fail closed on a known threshold change; legacy records stay compatible", async () => {
  for (const output of [
    { scores: [80], threshold: 60 },
    { scores: [80, "80"], threshold: 60 },
    { scores: [80, 80.5], threshold: 60 },
    { scores: [101, 80], threshold: 60 },
    { scores: [80, 80], threshold: 60, scoreRefused: true },
    { scores: [80, 80], threshold: 60, scoreRefused: "false" },
    { threshold: 60 },
  ]) {
    const f = await fixture("T1", true, output);
    await tier(f.source, "T2");
    assert.equal((await publishArticle(f.articleId))!.selected, false);
  }
  const legacy = await fixture("T1", true, {});
  await tier(legacy.source, "T2");
  assert.equal((await publishArticle(legacy.articleId))!.selected, true, "no proof of the old rule is not invented from display score");
  const boundary = await fixture("T2", false, { scores: [64, 66], threshold: 76 });
  await tier(boundary.source, "T1_5");
  assert.equal((await publishArticle(boundary.articleId))!.selected, true, "exact raw sum at 130 qualifies regardless of display score");
});

test("manual selection outranks tier recalculation and an old projection does not change or bounce back", async () => {
  for (const chosen of [true, false]) {
    const f = await fixture("T1", !chosen, { scores: [65, 66], threshold: 60 });
    await confirmedManualEdit(f.articleId, { fields: { selected: chosen }, reason: "合成人工决定", version: 0 }, "test");
    await tier(f.source, "T2");
    assert.equal((await publishArticle(f.articleId))!.selected, chosen);
  }
  const old = await fixture("T1", true, { scores: [65, 66], threshold: 60 }, 8);
  await tier(old.source, "T2");
  assert.equal((await publishArticle(old.articleId))!.selected, true, "older history retains its original decision");
  const recent = await fixture("T1", true, { scores: [65, 66], threshold: 60 });
  await tier(recent.source, "T2");
  assert.equal((await publishArticle(recent.articleId))!.selected, false);
  const later = new Date(Date.now() + 8 * 86_400_000);
  assert.equal((await publishArticle(recent.articleId, { now: later }))!.selected, false);
  await tier(recent.source, "T1");
  assert.equal((await publishArticle(recent.articleId, { now: later }))!.selected, false, "returning to the original tier cannot revive frozen history");
  await sql`UPDATE articles SET revision=2 WHERE id=${recent.articleId}`;
  assert.equal((await publishArticle(recent.articleId, { now: later }))!.selected, false, "a stale analysis cannot select a new material revision");
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,selected,prompt_version,output)
    VALUES(${recent.articleId},2,'model','pass','合成铜矿新进展','合成新材料的独立判断。',true,'analysis@synthetic-new',${sql.json({ scores: [65, 66], threshold: 60 })})`;
  assert.equal((await publishArticle(recent.articleId, { now: later }))!.selected, true, "a fresh current analysis takes effect for an older article");
});

test("leaving and re-entering selection uses the new release time and appends remove/upsert without changing old ledger entries", async () => {
  const f = await fixture("T1", true, { scores: [65, 66], threshold: 60 });
  const initial = await projection(f.articleId);
  const before = await sql`SELECT seq,op,visible_at FROM selected_ledger WHERE article_id=${f.articleId} ORDER BY seq`;
  await tier(f.source, "T2");
  await publishArticle(f.articleId);
  await tier(f.source, "T1_5");
  const now = new Date(Date.now() + 60_000);
  await publishArticle(f.articleId, { now });
  const after = await projection(f.articleId);
  assert.equal(after.selected, true);
  assert.equal(after.selected_ready_at.toISOString(), now.toISOString());
  assert.equal(after.visible_after.toISOString(), now.toISOString());
  assert.equal(after.first_public_at.toISOString(), initial.first_public_at.toISOString());
  const ledger = await sql`SELECT seq,op,visible_at FROM selected_ledger WHERE article_id=${f.articleId} ORDER BY seq`;
  assert.deepEqual(ledger[0], before[0]);
  assert.deepEqual(
    ledger.map((row) => row.op),
    ["upsert", "remove", "upsert"],
  );
  assert.equal(ledger.at(-1)!.visible_at.toISOString(), now.toISOString());
});
